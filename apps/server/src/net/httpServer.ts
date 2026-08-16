import { randomBytes } from 'node:crypto'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { dirname, extname, join, normalize, resolve } from 'node:path'
import type { Logger } from '@hobo/shared'
import type { ServerMetrics } from '../observability/metrics.js'
import { canEditMap, resolveHoboToolsUser } from './hoboToolsAuth.js'
import { MAX_MAP_BYTES, loadMap, saveMap } from './mapStore.js'
import { MAX_ASSET_BYTES, isContentAddressed, storeAsset } from './mapAssetStore.js'
import type { MapFileV2 } from '@hobo/content'

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
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
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
  onMapSaved?: (next: MapFileV2, revision: string) => void,
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
      // The canonical v2 document, with its revision as an ETag. This IS the
      // wire format: there is no v1 projection any more.
      void loadMap(mapPath).then((rec) => {
        res.writeHead(200, {
          'content-type': 'application/json',
          'cache-control': 'no-cache',
          etag: `"${rec.revision}"`,
        })
        res.end(JSON.stringify(rec.map))
      })
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
        let aborted = false
        req.on('data', (c: Buffer) => {
          size += c.length
          if (size > MAX_MAP_BYTES) {
            aborted = true
            req.destroy()
          } else chunks.push(c)
        })
        req.on('close', () => {
          if (!aborted || res.headersSent) return
          res.writeHead(413, { 'content-type': 'application/json' })
          res.end('{"error":"map_too_large"}')
        })
        req.on('end', () => {
          void (async () => {
            const body = Buffer.concat(chunks).toString('utf8')
            // If-Match carries the revision the editor last loaded; a
            // mismatch is a 409 rather than a silent overwrite.
            const ifMatch = (req.headers['if-match'] as string | undefined)?.replace(/"/g, '')
            const current = await loadMap(mapPath)
            const outcome = await saveMap(mapPath, body, current, ifMatch)
            if (outcome.status !== 200) {
              log.warn('map save rejected', { status: outcome.status, error: outcome.error })
              res.writeHead(outcome.status, { 'content-type': 'application/json' })
              res.end(
                JSON.stringify({
                  error: outcome.error,
                  ...(outcome.issues ? { issues: outcome.issues.slice(0, 40) } : {}),
                  ...(outcome.revision ? { revision: outcome.revision } : {}),
                }),
              )
              return
            }
            log.info('map saved by editor', {
              bytes: body.length,
              revision: outcome.record.revision,
            })
            onMapSaved?.(outcome.record.map, outcome.record.revision)
            res.writeHead(200, {
              'content-type': 'application/json',
              etag: `"${outcome.record.revision}"`,
            })
            res.end(JSON.stringify({ ok: true, live: true, revision: outcome.record.revision }))
          })().catch(() => {
            if (res.headersSent) return
            res.writeHead(500, { 'content-type': 'application/json' })
            res.end('{"error":"save_failed"}')
          })
        })
      })
      return
    }
    // ── Custom texture assets: uploaded once, served to every player. ──
    // Big source files (4k photo textures) live on disk next to the map
    // artifact instead of being base64-embedded into map.json.
    // Generic content-addressed asset upload (textures, paint masks, models).
    // `/api/texture` is the same handler under its old name so older editor
    // builds keep working; there is ONE store behind both.
    if (
      (url === '/api/map-assets' || url === '/api/texture') &&
      req.method === 'POST' &&
      mapPath &&
      editorAuth
    ) {
      const token = (req.headers['x-editor-key'] as string | undefined) ?? undefined
      void editorAuthorized(editorAuth, token).then((authed) => {
        if (!authed) {
          res.writeHead(403, { 'content-type': 'application/json' })
          res.end('{"error":"forbidden"}')
          return
        }
        const chunks: Buffer[] = []
        let size = 0
        let aborted = false
        req.on('data', (c: Buffer) => {
          size += c.length
          // Enforced WHILE streaming: a 48 MB cap that only checks at the end
          // has already buffered 48 MB.
          if (size > MAX_ASSET_BYTES) {
            aborted = true
            res.writeHead(413, { 'content-type': 'application/json' })
            res.end('{"error":"too_large"}')
            req.destroy()
            return
          }
          chunks.push(c)
        })
        req.on('end', () => {
          if (aborted) return
          void storeAsset(join(dirname(mapPath), 'map-assets'), Buffer.concat(chunks))
            .then((outcome) => {
              if (!outcome.ok) {
                res.writeHead(outcome.status, { 'content-type': 'application/json' })
                res.end(JSON.stringify({ error: outcome.error }))
                return
              }
              log.info('map asset stored', {
                hash: outcome.asset.hash,
                bytes: outcome.asset.bytes,
                mime: outcome.asset.mime,
                deduplicated: outcome.deduplicated,
              })
              res.writeHead(200, { 'content-type': 'application/json' })
              res.end(JSON.stringify({ ok: true, ...outcome.asset }))
            })
            .catch((err: unknown) => {
              log.warn('map asset store failed', { error: String(err) })
              res.writeHead(500, { 'content-type': 'application/json' })
              res.end('{"error":"write_failed"}')
            })
        })
      })
      return
    }
    if (url.startsWith('/map-assets/') && mapPath) {
      const base = url.slice('/map-assets/'.length)
      // Ids are server-generated; anything else is rejected outright.
      if (!/^[a-z0-9.-]+$/.test(base) || base.includes('..')) {
        res.writeHead(403)
        res.end()
        return
      }
      const assetPath = join(dirname(mapPath), 'map-assets', base)
      if (!existsSync(assetPath)) {
        res.writeHead(404)
        res.end()
        return
      }
      res.writeHead(200, {
        'content-type': MIME[extname(assetPath)] ?? 'application/octet-stream',
        // A content-addressed name cannot ever refer to different bytes, so
        // it is immutable. Legacy `tex-<timestamp>` names are not: they were
        // minted per upload and carry no such promise.
        'cache-control': isContentAddressed(base)
          ? 'public, max-age=31536000, immutable'
          : 'public, max-age=300',
      })
      createReadStream(assetPath).pipe(res)
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
          // Secure cookies are dropped over plain http (local dev).
          const secure = oauth.selfUrl.startsWith('https') ? '; Secure' : ''
          res.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'set-cookie': `hq_sso=${encodeURIComponent(data.access_token)}; Path=/; Max-Age=${7 * 86400}; SameSite=Lax${secure}`,
          })
          res.end(`<!doctype html><title>Signing in…</title><script>
localStorage.setItem('hq_sso', ${tok});
location.href = '/play';
</script><noscript><a href="/play">Continue</a></noscript>`)
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
    // Pretty page routes: /play is the game, /editor the map editor; the
    // old .html URLs redirect so bookmarks keep working.
    if (url === '/play.html' || url === '/editor.html') {
      res.writeHead(301, { location: url === '/play.html' ? '/play' : '/editor' })
      res.end()
      return
    }
    const pageAlias = url === '/play' ? 'play.html' : url === '/editor' ? 'editor.html' : null

    // Static files with path traversal guard.
    const safePath = normalize(pageAlias ?? url).replace(/^(\.\.[/\\])+/, '')
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
      // HTML must always revalidate (a stale page pins an old protocol
      // version and can't join). Vite content-hashes /assets/, so those
      // are immutable; everything else gets a modest TTL.
      'cache-control': filePath.endsWith('.html')
        ? 'no-cache'
        : filePath.includes('/assets/')
          ? 'public, max-age=31536000, immutable'
          : 'public, max-age=3600',
    })
    createReadStream(filePath)
      .on('error', (err) => {
        log.warn('static file error', { path: filePath, error: String(err) })
        res.destroy()
      })
      .pipe(res)
  })
}
