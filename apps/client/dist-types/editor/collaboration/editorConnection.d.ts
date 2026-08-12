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
  remoteSelections: () => Map<
    number,
    {
      color: Color3
      ids: string[]
    }
  >
  remoteSelectionColors: () => Map<string, string>
  peerCount: () => number
}
export declare function createEditorConnection(opts: EditorConnectionOptions): EditorConnection
//# sourceMappingURL=editorConnection.d.ts.map
