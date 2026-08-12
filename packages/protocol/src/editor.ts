/**
 * The map editor's collaboration wire, defined once for both sides.
 *
 * It used to be ad-hoc object literals written independently in the client
 * and the server, and they had drifted into being incompatible: the client
 * never sent the `hi` the server demanded as its first message, listened for
 * a `presence` tag the server never emitted (it sends `peer`), never sent the
 * camera stream at all, and used a different id limit. Collaboration was
 * effectively dead and nothing failed loudly enough to say so.
 *
 * Two rules make that unrepeatable:
 *
 *  - ONE definition. Both sides import these types and these decoders, so a
 *    tag can no longer be renamed on one side only.
 *  - DECODE, don't cast. Everything arriving over a socket is untrusted —
 *    from a hostile client or a stale build — so it is validated into a
 *    known shape before it can touch any state. A malformed message is
 *    rejected whole; it never partially applies.
 *
 * Kept dependency-free (no Zod) because the server decodes on every camera
 * frame from every peer and these shapes are small and fixed.
 */

// ── Shared limits ─────────────────────────────────────────────────────
// One definition each, so client and server cannot disagree about what is
// too big. They previously used 512 and 200 for the same field.

/** Longest single socket message, bytes. */
export const EDITOR_MAX_MESSAGE_BYTES = 8192
/** Most object ids in one selection or lock request. */
export const EDITOR_MAX_IDS = 200
/** Longest document id (matches the v2 schema's own limit). */
export const EDITOR_MAX_ID_LENGTH = 64
/** Longest display name. */
export const EDITOR_MAX_NAME_LENGTH = 24
/** Camera presence is streamed at this rate at most. */
export const EDITOR_CAMERA_HZ = 8
/**
 * Heartbeat period. Comfortably inside the 45 s lease, so an editor that
 * owns a lock and simply stops moving does not lose it.
 */
export const EDITOR_HEARTBEAT_MS = 12_000

// ── Client → server ───────────────────────────────────────────────────

export interface EditorHello {
  t: 'hello'
  /** Editor credential. Sent in the body, never in the URL. */
  key: string
  name: string
}

export interface EditorCameraMessage {
  t: 'camera'
  pos: [number, number, number]
  yaw: number
  pitch: number
}

export interface EditorSelectionMessage {
  t: 'selection'
  ids: string[]
}

export interface EditorLockRequest {
  t: 'lockRequest'
  ids: string[]
}

export interface EditorLockRelease {
  t: 'lockRelease'
  /** Absent means "everything I hold". */
  ids?: string[]
}

export interface EditorHeartbeat {
  t: 'heartbeat'
}

export type EditorClientMessage =
  | EditorHello
  | EditorCameraMessage
  | EditorSelectionMessage
  | EditorLockRequest
  | EditorLockRelease
  | EditorHeartbeat

// ── Server → client ───────────────────────────────────────────────────

export interface EditorWelcome {
  t: 'welcome'
  /** Assigned by the server; a client cannot choose or spoof it. */
  peerId: number
  color: string
}

export interface EditorPresence {
  t: 'presence'
  peerId: number
  name: string
  color: string
  pos: [number, number, number]
  yaw: number
  pitch: number
}

export interface EditorPeerSelection {
  t: 'peerSelection'
  peerId: number
  name: string
  color: string
  ids: string[]
}

export interface EditorLockResult {
  t: 'lockResult'
  granted: boolean
  ids: string[]
  /** On denial: who is holding one of them. */
  ownerName?: string
  ownerColor?: string
}

export interface EditorLockOwnerInfo {
  peerId: number
  name: string
  color: string
}

export interface EditorLockState {
  t: 'lockState'
  /** object id → owner. Authoritative; the client keeps no locks of its own. */
  owners: Record<string, EditorLockOwnerInfo>
}

export interface EditorMapSaved {
  t: 'mapSaved'
  revision: string
}

export interface EditorPeerGone {
  t: 'peerGone'
  peerId: number
}

export type EditorServerMessage =
  | EditorWelcome
  | EditorPresence
  | EditorPeerSelection
  | EditorLockResult
  | EditorLockState
  | EditorMapSaved
  | EditorPeerGone

// ── Decoding ──────────────────────────────────────────────────────────

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

const str = (v: unknown, max: number): string | null =>
  typeof v === 'string' && v.length > 0 && v.length <= max ? v : null

const finite = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null

const vec3 = (v: unknown): [number, number, number] | null => {
  if (!Array.isArray(v) || v.length !== 3) return null
  const x = finite(v[0])
  const y = finite(v[1])
  const z = finite(v[2])
  return x !== null && y !== null && z !== null ? [x, y, z] : null
}

/**
 * Document ids from the wire. Anything unusable is DROPPED rather than
 * failing the whole message: a peer running an older build should not be
 * able to break this one's selection display by including one bad id.
 */
const ids = (v: unknown): string[] => {
  if (!Array.isArray(v)) return []
  const out: string[] = []
  for (const item of v) {
    const id = str(item, EDITOR_MAX_ID_LENGTH)
    if (id !== null) out.push(id)
    if (out.length >= EDITOR_MAX_IDS) break
  }
  return out
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/
const color = (v: unknown): string | null => (typeof v === 'string' && HEX_COLOR.test(v) ? v : null)

/** Parse untrusted JSON text into a known client message, or null. */
export function decodeEditorClientMessage(raw: string): EditorClientMessage | null {
  if (raw.length > EDITOR_MAX_MESSAGE_BYTES) return null
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(value)) return null
  switch (value['t']) {
    case 'hello': {
      const key = str(value['key'], 512)
      const name = str(value['name'], EDITOR_MAX_NAME_LENGTH)
      return key === null ? null : { t: 'hello', key, name: name ?? 'editor' }
    }
    case 'camera': {
      const pos = vec3(value['pos'])
      const yaw = finite(value['yaw'])
      const pitch = finite(value['pitch'])
      return pos === null || yaw === null || pitch === null
        ? null
        : { t: 'camera', pos, yaw, pitch }
    }
    case 'selection':
      return { t: 'selection', ids: ids(value['ids']) }
    case 'lockRequest':
      return { t: 'lockRequest', ids: ids(value['ids']) }
    case 'lockRelease':
      return value['ids'] === undefined
        ? { t: 'lockRelease' }
        : { t: 'lockRelease', ids: ids(value['ids']) }
    case 'heartbeat':
      return { t: 'heartbeat' }
    default:
      return null
  }
}

/** Parse untrusted JSON text into a known server message, or null. */
export function decodeEditorServerMessage(raw: string): EditorServerMessage | null {
  if (raw.length > EDITOR_MAX_MESSAGE_BYTES * 4) return null
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(value)) return null
  const peerId = finite(value['peerId'])
  switch (value['t']) {
    case 'welcome': {
      const c = color(value['color'])
      return peerId === null || c === null ? null : { t: 'welcome', peerId, color: c }
    }
    case 'presence': {
      const pos = vec3(value['pos'])
      const yaw = finite(value['yaw'])
      const pitch = finite(value['pitch'])
      const name = str(value['name'], EDITOR_MAX_NAME_LENGTH)
      const c = color(value['color'])
      return peerId === null || pos === null || yaw === null || pitch === null || c === null
        ? null
        : { t: 'presence', peerId, name: name ?? 'editor', color: c, pos, yaw, pitch }
    }
    case 'peerSelection': {
      const name = str(value['name'], EDITOR_MAX_NAME_LENGTH)
      const c = color(value['color'])
      return peerId === null || c === null
        ? null
        : {
            t: 'peerSelection',
            peerId,
            name: name ?? 'editor',
            color: c,
            ids: ids(value['ids']),
          }
    }
    case 'lockResult': {
      if (typeof value['granted'] !== 'boolean') return null
      const ownerName = str(value['ownerName'], EDITOR_MAX_NAME_LENGTH)
      const ownerColor = color(value['ownerColor'])
      return {
        t: 'lockResult',
        granted: value['granted'],
        ids: ids(value['ids']),
        ...(ownerName ? { ownerName } : {}),
        ...(ownerColor ? { ownerColor } : {}),
      }
    }
    case 'lockState': {
      const raw2 = value['owners']
      if (!isRecord(raw2)) return null
      const owners: Record<string, EditorLockOwnerInfo> = {}
      for (const [id, info] of Object.entries(raw2)) {
        if (str(id, EDITOR_MAX_ID_LENGTH) === null || !isRecord(info)) continue
        const pid = finite(info['peerId'])
        const c = color(info['color'])
        if (pid === null || c === null) continue
        owners[id] = {
          peerId: pid,
          name: str(info['name'], EDITOR_MAX_NAME_LENGTH) ?? 'editor',
          color: c,
        }
      }
      return { t: 'lockState', owners }
    }
    case 'mapSaved':
      return { t: 'mapSaved', revision: str(value['revision'], 128) ?? '' }
    case 'peerGone':
      return peerId === null ? null : { t: 'peerGone', peerId }
    default:
      return null
  }
}

export const encodeEditorMessage = (msg: EditorClientMessage | EditorServerMessage): string =>
  JSON.stringify(msg)
