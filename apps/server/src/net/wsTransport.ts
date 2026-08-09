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
  const wss = new WebSocketServer({ server: http, path: '/ws', maxPayload: MAX_MESSAGE_BYTES })

  wss.on('connection', (ws: WebSocket, req) => {
    const remote = req.socket.remoteAddress ?? 'unknown'
    let msgCount = 0
    let windowStart = Date.now()

    const conn: GameConnection = {
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
