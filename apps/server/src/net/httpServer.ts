import { randomBytes } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { dirname, extname, join, normalize, resolve } from 'node:path'
import type { Logger } from '@hobo/shared'
import type { ServerMetrics } from '../observability/metrics.js'
import { canEditMap, resolveHoboToolsUser } from './hoboToolsAuth.js'

/**
 * Minimal HTTP layer: health/metrics endpoints and (in production) the
 * built client bundle. Game traffic itself is WebSocket-only.
 */

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
}

export interface EditorAuth {
  /** Shared-secret fallback. */
  key: string | null
  /** hobo.tools session endpoint; token validated there when configured. */
  hoboToolsUrl: string | null
}

/** hobo.tools OAuth2 client — powers the /auth/login → /auth/callback flow. */
export interface OAuthConfig {
  clientId: string
  clientSecret: string
  /** Public hobo.tools base, e.g. https://hobo.tools */
  baseUrl: string
  /** Our public base, e.g. https://hobo.quest (redirect_uri host). */
  selfUrl: string
}

/**
 * Validates a map-editor token: against hobo.tools when configured (the
 * endpoint must answer a JSON body with an admin-ish rank for the given
 * bearer token), else against the EDITOR_KEY shared secret.
 */
async function editorAuthorized(auth: EditorAuth, token: string | undefined): Promise<boolean> {
  if (!token) return false
  if (auth.hoboToolsUrl) {
    const user = await resolveHoboToolsUser(auth.hoboToolsUrl, token)
    return user !== null && canEditMap(user.rank)
  }
  return auth.key !== null && token === auth.key
}

export function createHttpServer(
  staticDir: string | null,
  metrics: ServerMetrics,
  log: Logger,
  mapPath?: string,
  editorAuth?: EditorAuth,
  onMapSaved?: (body: string) => void,
  listCharacters?: (
    token: string,
    auth: string | undefined,
  ) => Promise<{ slot: number; name: string; appearance: unknown }[]>,
  oauth?: OAuthConfig | null,
): Server {
  const root = staticDir ? resolve(staticDir) : null
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = (req.url ?? '/').split('?')[0] ?? '/'
    if (url === '/map.json' && mapPath) {
      if (existsSync(mapPath)) {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-cache' })
        createReadStream(mapPath).pipe(res)
      } else {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-cache' })
        res.end('null')
      }
      return
    }
    if (url === '/api/map' && req.method === 'POST' && mapPath && editorAuth) {
      const token = (req.headers['x-editor-key'] as string | undefined) ?? undefined
      void editorAuthorized(editorAuth, token).then((ok) => {
        if (!ok) {
          log.warn('editor save rejected', {})
          res.writeHead(403, { 'content-type': 'application/json' })
          res.end('{"error":"forbidden"}')
          return
        }
        const chunks: Buffer[] = []
        let size = 0
        req.on('data', (c: Buffer) => {
          size += c.length
          if (size > 64 * 1024 * 1024) req.destroy()
          else chunks.push(c)
        })
        req.on('end', () => {
          try {
            const body = Buffer.concat(chunks).toString('utf8')
            JSON.parse(body) // must at least be JSON
            mkdirSync(dirname(mapPath), { recursive: true })
            writeFileSync(mapPath, body)
            log.info('map saved by editor', { bytes: body.length })
            onMapSaved?.(body)
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end('{"ok":true,"live":true}')
          } catch {
            res.writeHead(400, { 'content-type': 'application/json' })
            res.end('{"error":"bad_map"}')
          }
        })
      })
      return
    }
    if (url === '/api/characters' && listCharacters) {
      const params = new URL(req.url ?? '/', 'http://x').searchParams
      const token = params.get('token') ?? ''
      const auth = params.get('auth') ?? undefined
      void (token.length >= 8 || auth ? listCharacters(token, auth) : Promise.resolve([])).then(
        (chars) => {
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-cache' })
          res.end(JSON.stringify(chars))
        },
      )
      return
    }
    // ── hobo.tools OAuth2 SSO ──────────────────────────────────────
    // /auth/login redirects to the hobo.tools account chooser; the
    // callback exchanges the code server-side (client secret never
    // reaches the browser), then hands the access token to the page.
    if (url === '/auth/login' && oauth) {
      const params = new URLSearchParams({
        client_id: oauth.clientId,
        redirect_uri: `${oauth.selfUrl}/auth/callback`,
        response_type: 'code',
        scope: 'profile theme',
        state: randomBytes(16).toString('hex'),
      })
      res.writeHead(302, { location: `${oauth.baseUrl}/oauth/authorize?${params.toString()}` })
      res.end()
      return
    }
    if (url === '/auth/callback' && oauth) {
      const code = new URL(req.url ?? '/', 'http://x').searchParams.get('code')
      if (!code) {
        res.writeHead(400, { 'content-type': 'text/plain' })
        res.end('missing code')
        return
      }
      void (async () => {
        try {
          const resp = await fetch(`${oauth.baseUrl}/oauth/token`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              grant_type: 'authorization_code',
              client_id: oauth.clientId,
              client_secret: oauth.clientSecret,
              code,
              redirect_uri: `${oauth.selfUrl}/auth/callback`,
            }),
          })
          const data = (await resp.json()) as {
            access_token?: string
            error_description?: string
            error?: string
            user?: { username?: string }
          }
          if (!data.access_token) {
            res.writeHead(400, { 'content-type': 'text/plain' })
            res.end(`sign-in failed: ${data.error_description ?? data.error ?? 'no token'}`)
            return
          }
          const tok = JSON.stringify(data.access_token)
          res.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'set-cookie': `hq_sso=${encodeURIComponent(data.access_token)}; Path=/; Max-Age=${7 * 86400}; SameSite=Lax; Secure`,
          })
          res.end(`<!doctype html><title>Signing in…</title><script>
localStorage.setItem('hq_sso', ${tok});
location.href = '/play.html';
</script><noscript><a href="/play.html">Continue</a></noscript>`)
        } catch (err) {
          log.warn('oauth callback failed', { error: String(err) })
          res.writeHead(502, { 'content-type': 'text/plain' })
          res.end('hobo.tools is unreachable — try again shortly')
        }
      })()
      return
    }
    if (url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, tick: metrics.tick }))
      return
    }
    if (url === '/metrics') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(metrics.snapshot()))
      return
    }
    if (!root) {
      res.writeHead(404)
      res.end('not found')
      return
    }
    // Static files with path traversal guard.
    const safePath = normalize(url).replace(/^(\.\.[/\\])+/, '')
    let filePath = join(root, safePath)
    if (!filePath.startsWith(root)) {
      res.writeHead(403)
      res.end()
      return
    }
    if (url === '/' || !existsSync(filePath) || statSync(filePath).isDirectory()) {
      filePath = join(root, 'index.html')
      if (!existsSync(filePath)) {
        res.writeHead(404)
        res.end('client build missing')
        return
      }
    }
    const type = MIME[extname(filePath)] ?? 'application/octet-stream'
    res.writeHead(200, {
      'content-type': type,
      'cache-control': filePath.endsWith('index.html') ? 'no-cache' : 'public, max-age=3600',
    })
    createReadStream(filePath)
      .on('error', (err) => {
        log.warn('static file error', { path: filePath, error: String(err) })
        res.destroy()
      })
      .pipe(res)
  })
}
