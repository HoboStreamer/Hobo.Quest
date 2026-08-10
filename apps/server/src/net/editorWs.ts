import type { Server } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import type { Logger } from '@hobo/shared'
import { canEditMap, resolveHoboToolsUser } from './hoboToolsAuth.js'
import type { EditorAuth } from './httpServer.js'

/**
 * Live collaboration channel for the map editor (/editor-ws): after an
 * authorized hello, each editor streams its camera pose and receives every
 * other editor's pose (rendered as floating eyeballs), plus an instant
 * `map_saved` push when anyone saves — so co-editors merge in real time
 * instead of waiting for the poll.
 *
 * The channel is presence + notification only: the map artifact itself
 * still flows through the authenticated HTTP save/load path.
 */

interface EditorPeer {
  ws: WebSocket
  id: number
  name: string
  authed: boolean
}

export interface EditorHub {
  wss: WebSocketServer
  broadcastSaved(): void
}

const MAX_MSG = 2048

export function attachEditorWs(http: Server, auth: EditorAuth, log: Logger): EditorHub {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8192 })
  void http
  const peers = new Set<EditorPeer>()
  let nextId = 1

  const sendOthers = (from: EditorPeer, text: string): void => {
    for (const p of peers) {
      if (p !== from && p.authed && p.ws.readyState === p.ws.OPEN) p.ws.send(text)
    }
  }

  wss.on('connection', (ws: WebSocket) => {
    const peer: EditorPeer = { ws, id: nextId++, name: 'editor', authed: false }
    peers.add(peer)

    ws.on('message', (data, isBinary) => {
      if (isBinary || String(data).length > MAX_MSG) {
        ws.close(4005, 'bad_message')
        return
      }
      let msg: {
        t?: string
        key?: string
        name?: string
        pos?: number[]
        yaw?: number
        pitch?: number
      }
      try {
        msg = JSON.parse(String(data)) as typeof msg
      } catch {
        ws.close(4007, 'malformed')
        return
      }
      if (!peer.authed) {
        if (msg.t !== 'hi' || typeof msg.key !== 'string') {
          ws.close(4001, 'hello_first')
          return
        }
        void authorizeEditor(auth, msg.key).then((ok) => {
          if (!ok) {
            ws.close(4003, 'not_authorized')
            return
          }
          peer.authed = true
          peer.name = String(msg.name ?? 'editor').slice(0, 24)
          ws.send(JSON.stringify({ t: 'welcome', id: peer.id }))
          log.info('editor joined', { id: peer.id, name: peer.name })
        })
        return
      }
      if (
        msg.t === 'cam' &&
        Array.isArray(msg.pos) &&
        msg.pos.length === 3 &&
        msg.pos.every((n) => typeof n === 'number' && Number.isFinite(n))
      ) {
        sendOthers(
          peer,
          JSON.stringify({
            t: 'peer',
            id: peer.id,
            name: peer.name,
            pos: msg.pos,
            yaw: Number(msg.yaw) || 0,
            pitch: Number(msg.pitch) || 0,
          }),
        )
      }
    })

    ws.on('close', () => {
      peers.delete(peer)
      if (peer.authed) sendOthers(peer, JSON.stringify({ t: 'peer_gone', id: peer.id }))
    })
    ws.on('error', () => peers.delete(peer))
  })

  return {
    wss,
    broadcastSaved(): void {
      const text = JSON.stringify({ t: 'map_saved' })
      for (const p of peers) {
        if (p.authed && p.ws.readyState === p.ws.OPEN) p.ws.send(text)
      }
    },
  }
}

async function authorizeEditor(auth: EditorAuth, key: string): Promise<boolean> {
  if (auth.hoboToolsUrl) {
    const user = await resolveHoboToolsUser(auth.hoboToolsUrl, key)
    return user !== null && canEditMap(user.rank)
  }
  return auth.key !== null && key === auth.key
}
