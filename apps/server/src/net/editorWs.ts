import type { Server } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import type { Logger } from '@hobo/shared'
import {
  EDITOR_MAX_MESSAGE_BYTES,
  decodeEditorClientMessage,
  encodeEditorMessage,
  type EditorLockOwnerInfo,
  type EditorServerMessage,
} from '@hobo/protocol'
import { canEditMap, resolveHoboToolsUser } from './hoboToolsAuth.js'
import { LockManager } from './editorLocks.js'
import type { EditorAuth } from './httpServer.js'

/**
 * Live collaboration for the map editor (`/editor-ws`).
 *
 * After an authorized `hello`, each editor streams its camera pose and its
 * selection, and receives everyone else's; asks for and releases edit locks;
 * and gets a `mapSaved` push the moment anyone saves.
 *
 * The channel is presence + arbitration only — the map artifact itself still
 * flows through the authenticated HTTP save/load path, which is what keeps
 * the socket cheap and the save atomic.
 *
 * Both sides speak `@hobo/protocol`'s editor messages. They previously did
 * not: the client never sent the `hello` this handler demands, listened for a
 * tag this handler never emitted, and never sent camera at all. Sharing the
 * definition and DECODING rather than casting is what stops that recurring.
 */

interface EditorPeer {
  ws: WebSocket
  id: number
  name: string
  color: string
  authed: boolean
  lastCam: { pos: [number, number, number]; yaw: number; pitch: number } | null
  lastSel: string[]
}

/** Stable, distinguishable session colours (assigned round-robin). */
const PEER_COLORS = ['#ff9d4d', '#4dc3ff', '#7dff6e', '#ff6ec7', '#ffe14d', '#b39dff']

export interface EditorHub {
  wss: WebSocketServer
  broadcastSaved(revision: string): void
  /** Live peer count, for tests and diagnostics. */
  peerCount(): number
}

export function attachEditorWs(http: Server, auth: EditorAuth, log: Logger): EditorHub {
  const wss = new WebSocketServer({ noServer: true, maxPayload: EDITOR_MAX_MESSAGE_BYTES })
  void http
  const peers = new Set<EditorPeer>()
  const locks = new LockManager()
  let nextId = 1

  const send = (peer: EditorPeer, msg: EditorServerMessage): void => {
    if (peer.authed && peer.ws.readyState === peer.ws.OPEN) peer.ws.send(encodeEditorMessage(msg))
  }
  const broadcast = (msg: EditorServerMessage, except?: EditorPeer): void => {
    const text = encodeEditorMessage(msg)
    for (const p of peers) {
      if (p !== except && p.authed && p.ws.readyState === p.ws.OPEN) p.ws.send(text)
    }
  }

  const lockOwners = (): Record<string, EditorLockOwnerInfo> => {
    const owners: Record<string, EditorLockOwnerInfo> = {}
    for (const [id, peerId] of Object.entries(locks.state())) {
      const p = [...peers].find((pp) => pp.id === peerId)
      // A lock whose owner has already gone is not reported; the sweeper
      // will free it, and naming a ghost as the blocker helps nobody.
      if (p) owners[id] = { peerId: p.id, name: p.name, color: p.color }
    }
    return owners
  }
  const broadcastLocks = (): void => broadcast({ t: 'lockState', owners: lockOwners() })

  // Lease sweeper: locks from crashed or vanished editors expire on their own.
  const sweeper = setInterval(() => {
    if (locks.sweep(Date.now()).length > 0) broadcastLocks()
  }, 10_000)
  sweeper.unref()

  /**
   * ONE teardown path, used by close and by error. Doing this in two places
   * is how a peer ends up removed from presence but still holding locks.
   */
  const dropPeer = (peer: EditorPeer): void => {
    if (!peers.delete(peer)) return
    const freed = locks.releaseAll(peer.id).length > 0
    if (peer.authed) broadcast({ t: 'peerGone', peerId: peer.id }, peer)
    if (freed) broadcastLocks()
  }

  wss.on('connection', (ws: WebSocket) => {
    const peer: EditorPeer = {
      ws,
      id: nextId++,
      name: 'editor',
      color: PEER_COLORS[nextId % PEER_COLORS.length]!,
      authed: false,
      lastCam: null,
      lastSel: [],
    }
    peers.add(peer)

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        ws.close(4005, 'bad_message')
        return
      }
      const msg = decodeEditorClientMessage(String(data))
      if (!msg) {
        ws.close(4007, 'malformed')
        return
      }

      if (!peer.authed) {
        // Anything before a successful hello is refused, so an unauthorized
        // socket can neither read presence nor take a lock.
        if (msg.t !== 'hello') {
          ws.close(4001, 'hello_first')
          return
        }
        void authorizeEditor(auth, msg.key).then((ok) => {
          if (!ok) {
            ws.close(4003, 'not_authorized')
            return
          }
          peer.authed = true
          // The server assigns identity and colour; the client cannot pick
          // either, so it cannot impersonate another editor's selection.
          peer.name = msg.name
          send(peer, { t: 'welcome', peerId: peer.id, color: peer.color })
          send(peer, { t: 'lockState', owners: lockOwners() })
          // Presence snapshot: the newcomer sees everyone immediately rather
          // than waiting for them to move.
          for (const other of peers) {
            if (other === peer || !other.authed) continue
            if (other.lastCam)
              send(peer, {
                t: 'presence',
                peerId: other.id,
                name: other.name,
                color: other.color,
                pos: other.lastCam.pos,
                yaw: other.lastCam.yaw,
                pitch: other.lastCam.pitch,
              })
            if (other.lastSel.length > 0)
              send(peer, {
                t: 'peerSelection',
                peerId: other.id,
                name: other.name,
                color: other.color,
                ids: other.lastSel,
              })
          }
          log.info('editor joined', { id: peer.id, name: peer.name })
        })
        return
      }

      // Any authenticated traffic counts as liveness, and `heartbeat` exists
      // so an editor holding a lock while sitting still keeps its lease.
      locks.heartbeat(peer.id, Date.now())

      switch (msg.t) {
        case 'heartbeat':
          return
        case 'camera': {
          peer.lastCam = { pos: msg.pos, yaw: msg.yaw, pitch: msg.pitch }
          broadcast(
            {
              t: 'presence',
              peerId: peer.id,
              name: peer.name,
              color: peer.color,
              pos: msg.pos,
              yaw: msg.yaw,
              pitch: msg.pitch,
            },
            peer,
          )
          return
        }
        case 'selection': {
          peer.lastSel = msg.ids
          broadcast(
            {
              t: 'peerSelection',
              peerId: peer.id,
              name: peer.name,
              color: peer.color,
              ids: msg.ids,
            },
            peer,
          )
          return
        }
        case 'lockRequest': {
          const result = locks.acquire(peer.id, msg.ids, Date.now())
          const blocker = result.blocked[0]
            ? [...peers].find((pp) => pp.id === result.blocked[0]!.owner)
            : undefined
          send(peer, {
            t: 'lockResult',
            granted: result.granted,
            ids: msg.ids,
            ...(blocker ? { ownerName: blocker.name, ownerColor: blocker.color } : {}),
          })
          if (result.granted) broadcastLocks()
          return
        }
        case 'lockRelease': {
          if (msg.ids === undefined) locks.releaseAll(peer.id)
          else locks.release(peer.id, msg.ids)
          broadcastLocks()
          return
        }
        case 'hello':
          // A second hello is meaningless; ignore rather than re-authorize.
          return
      }
    })

    ws.on('close', () => dropPeer(peer))
    ws.on('error', () => dropPeer(peer))
  })

  return {
    wss,
    broadcastSaved(revision: string): void {
      broadcast({ t: 'mapSaved', revision })
    },
    peerCount(): number {
      let n = 0
      for (const p of peers) if (p.authed) n++
      return n
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
