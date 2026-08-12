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
import type { FreeCamera } from '@babylonjs/core/Cameras/freeCamera.js'
import type { Scene } from '@babylonjs/core/scene.js'
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
export declare function createEditorConnection(opts: EditorConnectionOptions): EditorConnection
export { Color3 }
//# sourceMappingURL=editorConnection.d.ts.map
