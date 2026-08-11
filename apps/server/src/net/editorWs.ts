import type { Server } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import type { Logger } from '@hobo/shared'
import { canEditMap, resolveHoboToolsUser } from './hoboToolsAuth.js'
import { LockManager } from './editorLocks.js'
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
  color: string
  authed: boolean
}

/** Stable, distinguishable session colors (assigned round-robin). */
const PEER_COLORS = ['#ff9d4d', '#4dc3ff', '#7dff6e', '#ff6ec7', '#ffe14d', '#b39dff']

export interface EditorHub {
  wss: WebSocketServer
  broadcastSaved(): void
}

const MAX_MSG = 2048

export function attachEditorWs(http: Server, auth: EditorAuth, log: Logger): EditorHub {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8192 })
  void http
  const peers = new Set<EditorPeer>()
  const locks = new LockManager()
  let nextId = 1
  const broadcastLocks = (): void => {
    const owners: Record<string, { id: number; name: string; color: string }> = {}
    for (const [oid, pid] of Object.entries(locks.state())) {
      const p = [...peers].find((pp) => pp.id === pid)
      if (p) owners[oid] = { id: p.id, name: p.name, color: p.color }
    }
    const text = JSON.stringify({ t: 'locks', owners })
    for (const p of peers) {
      if (p.authed && p.ws.readyState === p.ws.OPEN) p.ws.send(text)
    }
  }
  // Lease sweeper: locks from crashed/vanished editors expire on their own.
  const sweeper = setInterval(() => {
    if (locks.sweep(Date.now()).length > 0) broadcastLocks()
  }, 10_000)
  sweeper.unref()

  const sendOthers = (from: EditorPeer, text: string): void => {
    for (const p of peers) {
      if (p !== from && p.authed && p.ws.readyState === p.ws.OPEN) p.ws.send(text)
    }
  }

  wss.on('connection', (ws: WebSocket) => {
    const peer: EditorPeer = {
      ws,
      id: nextId++,
      name: 'editor',
      color: PEER_COLORS[nextId % PEER_COLORS.length]!,
      authed: false,
    }
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
        ids?: string[]
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
          ws.send(JSON.stringify({ t: 'welcome', id: peer.id, color: peer.color }))
          ws.send(
            JSON.stringify({
              t: 'locks',
              owners: Object.fromEntries(
                Object.entries(locks.state()).map(([oid, pid]) => {
                  const p = [...peers].find((pp) => pp.id === pid)
                  return [oid, { id: pid, name: p?.name ?? '?', color: p?.color ?? '#888' }]
                }),
              ),
            }),
          )
          log.info('editor joined', { id: peer.id, name: peer.name })
        })
        return
      }
      locks.heartbeat(peer.id, Date.now())
      const strIds = (v: unknown): string[] =>
        Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 200) : []
      if (msg.t === 'lock') {
        const ids = strIds(msg.ids)
        const r = locks.acquire(peer.id, ids, Date.now())
        const blocker = r.blocked[0]
          ? [...peers].find((pp) => pp.id === r.blocked[0]!.owner)
          : undefined
        ws.send(
          JSON.stringify({
            t: 'lock_result',
            granted: r.granted,
            ids,
            ...(blocker ? { owner: blocker.name, ownerColor: blocker.color } : {}),
          }),
        )
        if (r.granted) broadcastLocks()
        return
      }
      if (msg.t === 'unlock') {
        locks.release(peer.id, strIds(msg.ids))
        broadcastLocks()
        return
      }
      if (msg.t === 'sel') {
        sendOthers(
          peer,
          JSON.stringify({
            t: 'peer_sel',
            id: peer.id,
            name: peer.name,
            color: peer.color,
            ids: strIds(msg.ids),
          }),
        )
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
      if (locks.releaseAll(peer.id).length > 0) broadcastLocks()
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
