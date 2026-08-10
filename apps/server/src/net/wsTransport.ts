import type { Server } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import { decodeClientMessage } from '@hobo/protocol'
import type { Logger } from '@hobo/shared'
import type { GameConnection, GameServer } from '../game/gameServer.js'

/**
 * WebSocket transport binding. Enforces wire-level limits (message size,
 * rate) before anything reaches game code; malformed or abusive traffic
 * drops the connection.
 */

const MAX_MESSAGE_BYTES = 4096
const MAX_MESSAGES_PER_SECOND = 120

export function attachWebSocket(http: Server, game: GameServer, log: Logger): WebSocketServer {
  // noServer: upgrades are routed by path in main (two WSS instances bound
  // to one http server both complete the handshake and corrupt frames).
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES })
  void http

  wss.on('connection', (ws: WebSocket, req) => {
    // Real client IP: Cloudflare/nginx headers first (we sit behind both in
    // prod), socket address in dev. Guest identity hangs off this.
    const fwd = req.headers['x-forwarded-for']
    const remote =
      (typeof req.headers['cf-connecting-ip'] === 'string'
        ? req.headers['cf-connecting-ip']
        : undefined) ??
      (typeof fwd === 'string' ? (fwd.split(',')[0] ?? '').trim() : undefined) ??
      req.socket.remoteAddress ??
      'unknown'
    let msgCount = 0
    let windowStart = Date.now()

    const conn: GameConnection = {
      ip: remote,
      send: (text) => {
        if (ws.readyState === ws.OPEN) ws.send(text)
      },
      close: (code, reason) => ws.close(code, reason),
    }

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        ws.close(4005, 'text_only')
        return
      }
      const now = Date.now()
      if (now - windowStart >= 1000) {
        windowStart = now
        msgCount = 0
      }
      if (++msgCount > MAX_MESSAGES_PER_SECOND) {
        log.warn('rate limit exceeded', { remote })
        ws.close(4006, 'rate_limit')
        return
      }
      const msg = decodeClientMessage(data.toString())
      if (!msg) {
        // A schema-invalid first message is almost always a version-skewed
        // or corrupted hello — tell the client so it can recover instead
        // of freezing on a silent close, and log enough to diagnose.
        let kind = 'unparseable'
        try {
          kind = String((JSON.parse(data.toString()) as { t?: string }).t ?? 'missing-t')
        } catch {
          /* not JSON */
        }
        log.warn('malformed message', { remote, kind, bytes: data.toString().length })
        ws.send(JSON.stringify({ t: 'reject', reason: 'invalid_hello' }))
        ws.close(4007, 'malformed')
        return
      }
      game.onMessage(conn, msg)
    })

    ws.on('close', () => game.onDisconnect(conn))
    ws.on('error', (err) => {
      log.warn('ws error', { remote, error: String(err) })
    })
  })

  return wss
}
