/**
 * The editor's live channel: presence, remote selection, locks, and the push
 * that says the map was saved.
 *
 * Speaks `@hobo/protocol`'s editor messages, decoded rather than cast. The
 * previous version of this file and the server had drifted apart — no
 * `hello`, a tag the server never sent, no camera stream — so collaboration
 * silently did nothing at all.
 *
 * The server assigns the peer id and colour and owns the lock table. A client
 * that could choose its own identity could impersonate another editor's
 * selection, and one that granted its own locks would not have a lock.
 */
import { Color3 } from '@babylonjs/core/Maths/math.color.js'
import {
  EDITOR_CAMERA_HZ,
  EDITOR_HEARTBEAT_MS,
  decodeEditorServerMessage,
  encodeEditorMessage,
  type EditorClientMessage,
  type EditorLockOwnerInfo,
} from '@hobo/protocol'
import type { FreeCamera } from '@babylonjs/core/Cameras/freeCamera.js'
import type { Scene } from '@babylonjs/core/scene.js'
import { PeerAvatars } from './peerAvatars.js'
import { LockController } from './lockController.js'

export interface EditorConnectionOptions {
  scene: Scene
  peersEl: HTMLElement
  camera: FreeCamera
  /** The editor credential, read at connect time. */
  keyOf: () => string
  /** Display name for other editors. */
  nameOf: () => string
  onRemoteSaved: () => void
  onChange: () => void
  onLockLost: () => void
  onLockDenied: (owner: string) => void
}

export interface RemotePeer {
  peerId: number
  name: string
  color: string
  selection: string[]
}

/**
 * The lock vocabulary the editor actually needs.
 *
 * `canInspect` and `owns` are deliberately different questions. Treating
 * "nobody else has it" as permission to mutate is how a server-authoritative
 * lock system ends up never being acquired: both editors think they may
 * proceed, and the arbitration never runs.
 */
export interface EditorConnection {
  connect: () => void
  disconnect: () => void
  sendSelection: (ids: readonly string[]) => void

  /** Reading is always allowed, even for an object someone else holds. */
  canInspect: (id: string) => boolean
  isLockedByOther: (id: string) => boolean
  owns: (id: string) => boolean
  ownsAll: (ids: readonly string[]) => boolean
  /** Request `ids`; `then` runs once they are actually granted. */
  acquire: (ids: readonly string[], then?: () => void) => boolean
  release: (ids: readonly string[]) => void
  releaseAll: () => void

  lockOwner: (id: string) => string | null
  lockOwners: () => Map<string, string>
  lockColors: () => Map<string, string>
  remoteSelectionColors: () => Map<string, string>
  peers: () => RemotePeer[]
  peerCount: () => number
  myPeerId: () => number
  connected: () => boolean
}

export function createEditorConnection(opts: EditorConnectionOptions): EditorConnection {
  const avatars = new PeerAvatars(opts.scene, opts.peersEl)
  let socket: WebSocket | null = null
  let peerId = -1
  let credential = ''
  let open = false
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let heartbeat: ReturnType<typeof setInterval> | null = null
  let cameraTimer: ReturnType<typeof setInterval> | null = null
  let lastCameraKey = ''
  const remote = new Map<number, RemotePeer>()

  const send = (msg: EditorClientMessage): void => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(encodeEditorMessage(msg))
  }

  const locks = new LockController(
    {
      request: (ids) => send({ t: 'lockRequest', ids: [...ids] }),
      release: (ids) => send({ t: 'lockRelease', ids: [...ids] }),
    },
    {
      onLost: () => opts.onLockLost(),
      onDenied: (owner) => opts.onLockDenied(owner),
      onChange: () => opts.onChange(),
    },
  )

  const stopTimers = (): void => {
    if (heartbeat !== null) clearInterval(heartbeat)
    if (cameraTimer !== null) clearInterval(cameraTimer)
    heartbeat = null
    cameraTimer = null
  }

  const startTimers = (): void => {
    stopTimers()
    // An editor that owns a lock and simply stops moving must not lose it,
    // so liveness is explicit rather than a side effect of camera traffic.
    heartbeat = setInterval(() => send({ t: 'heartbeat' }), EDITOR_HEARTBEAT_MS)
    cameraTimer = setInterval(() => {
      const c = opts.camera
      const key = `${c.position.x.toFixed(2)},${c.position.y.toFixed(2)},${c.position.z.toFixed(2)},${c.rotation.y.toFixed(3)},${c.rotation.x.toFixed(3)}`
      // Only when it actually moved: a still editor costs nothing.
      if (key === lastCameraKey) return
      lastCameraKey = key
      send({
        t: 'camera',
        pos: [c.position.x, c.position.y, c.position.z],
        yaw: c.rotation.y,
        pitch: c.rotation.x,
      })
    }, 1000 / EDITOR_CAMERA_HZ)
  }

  const connect = (): void => {
    const key = opts.keyOf()
    if (!key) return
    if (
      socket &&
      (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)
    ) {
      // The credential changed: reconnect deliberately rather than leaving a
      // socket authenticated as somebody else.
      if (key === credential) return
      socket.close(1000, 'credential_changed')
      socket = null
    }
    credential = key
    if (reconnectTimer !== null) clearTimeout(reconnectTimer)
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    // No credential in the URL: query strings end up in proxy logs and
    // browser history.
    const ws = new WebSocket(`${proto}://${location.host}/editor-ws`)
    socket = ws
    ws.addEventListener('open', () => {
      open = true
      send({ t: 'hello', key, name: opts.nameOf() })
      startTimers()
    })
    ws.addEventListener('message', (e) => onMessage(String(e.data)))
    ws.addEventListener('close', () => {
      if (socket !== ws) return
      open = false
      socket = null
      stopTimers()
      locks.disconnected()
      for (const p of remote.keys()) avatars.remove(p)
      remote.clear()
      opts.onChange()
      // An editor left open overnight should recover on its own.
      reconnectTimer = setTimeout(connect, 4000)
    })
    ws.addEventListener('error', () => ws.close())
  }

  const peerOf = (id: number, name: string, color: string): RemotePeer => {
    const existing = remote.get(id)
    if (existing) {
      existing.name = name
      existing.color = color
      return existing
    }
    const created: RemotePeer = { peerId: id, name, color, selection: [] }
    remote.set(id, created)
    return created
  }

  const onMessage = (raw: string): void => {
    const msg = decodeEditorServerMessage(raw)
    if (!msg) return
    switch (msg.t) {
      case 'welcome':
        peerId = msg.peerId
        locks.setPeerId(msg.peerId)
        opts.onChange()
        return
      case 'presence': {
        if (msg.peerId === peerId) return
        peerOf(msg.peerId, msg.name, msg.color)
        avatars.update(msg.peerId, msg.name, msg.pos, msg.yaw, msg.pitch)
        opts.onChange()
        return
      }
      case 'peerSelection': {
        if (msg.peerId === peerId) return
        peerOf(msg.peerId, msg.name, msg.color).selection = msg.ids
        opts.onChange()
        return
      }
      case 'peerGone':
        remote.delete(msg.peerId)
        avatars.remove(msg.peerId)
        opts.onChange()
        return
      case 'lockResult':
        if (msg.granted) locks.granted(msg.ids)
        else locks.denied(msg.ownerName ?? 'another editor')
        return
      case 'lockState': {
        const owners = new Map<string, EditorLockOwnerInfo>()
        for (const [id, info] of Object.entries(msg.owners)) owners.set(id, info)
        locks.setOwners(owners)
        return
      }
      case 'mapSaved':
        opts.onRemoteSaved()
        return
    }
  }

  return {
    connect,
    disconnect: () => {
      if (reconnectTimer !== null) clearTimeout(reconnectTimer)
      reconnectTimer = null
      stopTimers()
      socket?.close(1000, 'closing')
      socket = null
      open = false
    },
    sendSelection: (ids) => send({ t: 'selection', ids: [...ids] }),

    canInspect: () => true,
    isLockedByOther: (id) => locks.ownerOf(id) !== null,
    owns: (id) => locks.owns(id),
    ownsAll: (ids) => locks.ownsAll(ids),
    acquire: (ids, then) => locks.acquire(ids, then),
    release: (ids) => locks.release(ids),
    releaseAll: () => locks.releaseAll(),

    lockOwner: (id) => locks.ownerOf(id)?.name ?? null,
    lockOwners: () => new Map([...locks.remoteLocks()].map(([id, o]) => [id, o.name])),
    lockColors: () => new Map([...locks.remoteLocks()].map(([id, o]) => [id, o.color])),
    remoteSelectionColors: () => {
      const out = new Map<string, string>()
      for (const p of remote.values()) for (const id of p.selection) out.set(id, p.color)
      return out
    },
    peers: () => [...remote.values()],
    // Real peers, not "how many happen to have a non-empty selection".
    peerCount: () => remote.size,
    myPeerId: () => peerId,
    connected: () => open,
  }
}

export { Color3 }
