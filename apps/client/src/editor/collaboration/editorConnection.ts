/**
 * The editor's live channel: presence, remote selection, locks, and the push
 * that says the map was saved.
 *
 * The server assigns the peer id and the colour, and the server owns the lock
 * table — a client that could pick its own identity could impersonate another
 * editor's selection, and a client that granted its own locks would not be a
 * lock at all. This only reports what it is told.
 */
import { Color3 } from '@babylonjs/core/Maths/math.color.js'
import type { FreeCamera } from '@babylonjs/core/Cameras/freeCamera.js'
import type { Scene } from '@babylonjs/core/scene.js'
import { PeerAvatars } from './peerAvatars.js'
import { LockController, type LockOwner } from './lockController.js'

export interface EditorConnectionOptions {
  scene: Scene
  peersEl: HTMLElement
  camera: FreeCamera
  keyOf: () => string
  onRemoteSaved: () => void
  onChange: () => void
  onLockLost: () => void
}

export interface EditorConnection {
  connect: () => void
  sendSelection: (ids: readonly string[]) => void
  acquire: (ids: readonly string[], then?: () => void) => boolean
  release: () => void
  canEdit: (id: string) => boolean
  lockOwner: (id: string) => string | null
  lockOwners: () => Map<string, string>
  lockColors: () => Map<string, string>
  remoteSelections: () => Map<number, { color: Color3; ids: string[] }>
  remoteSelectionColors: () => Map<string, string>
  peerCount: () => number
}

/** Message sizes are bounded: a peer cannot make us allocate arbitrarily. */
const MAX_IDS = 512

export function createEditorConnection(opts: EditorConnectionOptions): EditorConnection {
  const peers = new PeerAvatars(opts.scene, opts.peersEl)
  let socket: WebSocket | null = null
  let myPeerId = -1
  const remoteSel = new Map<number, { color: Color3; ids: string[] }>()

  const send = (msg: Record<string, unknown>): void => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg))
  }

  const locks = new LockController(
    {
      request: (ids) => send({ t: 'lock', ids: [...ids] }),
      release: (ids) => send({ t: 'unlock', ids: [...ids] }),
    },
    {
      onLost: () => opts.onLockLost(),
      onChange: () => opts.onChange(),
    },
  )

  const connect = (): void => {
    const key = opts.keyOf()
    if (!key) return
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    socket = new WebSocket(`${proto}://${location.host}/editor-ws?key=${encodeURIComponent(key)}`)
    socket.addEventListener('message', (e) => onMessage(String(e.data)))
    socket.addEventListener('close', () => {
      locks.disconnected()
      remoteSel.clear()
      opts.onChange()
      // Reconnect quietly; an editor left open overnight should recover.
      setTimeout(connect, 4000)
    })
  }

  const onMessage = (raw: string): void => {
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(raw) as Record<string, unknown>
    } catch {
      return
    }
    switch (msg['t']) {
      case 'welcome':
        myPeerId = Number(msg['id'])
        locks.setPeerId(myPeerId)
        return
      case 'presence': {
        const p = msg as unknown as {
          id: number
          name: string
          pos: number[]
          yaw: number
          pitch: number
        }
        if (p.id !== myPeerId) peers.update(p.id, p.name, p.pos, p.yaw, p.pitch)
        opts.onChange()
        return
      }
      case 'peer_gone': {
        const id = Number(msg['id'])
        remoteSel.delete(id)
        peers.remove(id)
        opts.onChange()
        return
      }
      case 'peer_sel': {
        const id = Number(msg['id'])
        const ids = Array.isArray(msg['ids']) ? (msg['ids'] as string[]).slice(0, MAX_IDS) : []
        remoteSel.set(id, { color: Color3.FromHexString(String(msg['color'] ?? '#ffffff')), ids })
        opts.onChange()
        return
      }
      case 'lock_result': {
        if (msg['granted'] === true) locks.granted(msg['ids'] as string[])
        else locks.denied(String(msg['owner'] ?? 'another editor'))
        return
      }
      case 'locks': {
        const owners = new Map<string, LockOwner>()
        for (const [id, o] of Object.entries((msg['owners'] ?? {}) as Record<string, LockOwner>))
          owners.set(id, o)
        locks.setOwners(owners)
        return
      }
      case 'map_saved':
        opts.onRemoteSaved()
        return
    }
  }

  return {
    connect,
    sendSelection: (ids) => send({ t: 'sel', ids: ids.slice(0, MAX_IDS) }),
    acquire: (ids, then) => locks.acquire(ids, then),
    release: () => locks.release(),
    canEdit: (id) => locks.canEdit(id),
    lockOwner: (id) => locks.ownerOf(id)?.name ?? null,
    lockOwners: () => new Map([...locks.remoteLocks()].map(([id, o]) => [id, o.name])),
    lockColors: () => new Map([...locks.remoteLocks()].map(([id, o]) => [id, o.color])),
    remoteSelections: () => remoteSel,
    remoteSelectionColors: () => {
      const out = new Map<string, string>()
      for (const r of remoteSel.values()) for (const id of r.ids) out.set(id, r.color.toHexString())
      return out
    },
    peerCount: () => remoteSel.size,
  }
}
