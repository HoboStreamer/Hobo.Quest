import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { extname, join, normalize, resolve } from 'node:path'
import type { Logger } from '@hobo/shared'
import type { ServerMetrics } from '../observability/metrics.js'

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

export function createHttpServer(
  staticDir: string | null,
  metrics: ServerMetrics,
  log: Logger,
): Server {
  const root = staticDir ? resolve(staticDir) : null
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = (req.url ?? '/').split('?')[0] ?? '/'
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
