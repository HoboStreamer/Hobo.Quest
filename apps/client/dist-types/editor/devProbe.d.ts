import type { Scene } from '@babylonjs/core/scene.js'
import type { FreeCamera } from '@babylonjs/core/Cameras/freeCamera.js'
import type { AssetController } from './assets/assetController.js'
import type { EditorConnection } from './collaboration/editorConnection.js'
import type { EditorDocument } from './document/editorDocument.js'
import type { CommandHistory } from './history/commandHistory.js'
import type { InteractionController } from './interaction/interactionController.js'
import type { ViewportInteraction } from './interaction/viewportInteraction.js'
import type { SaveController } from './net/saveController.js'
import type { FaceOverlayManager, FaceSelection } from './selection/faceSelection.js'
import type { SelectionManager } from './selection/selectionManager.js'
import type { ToolManager } from './tools/toolManager.js'
import type { EditorCameraController } from './viewport/editorCameraController.js'
import type { EditorViewRegistry } from './viewport/editorViewRegistry.js'
import type { GizmoController } from './viewport/gizmoController.js'
import type { TransformSession } from './viewport/transformSession.js'
import type { EditorUi } from './ui/editorUi.js'
/** Everything the probe reads. Live references, resolved at call time. */
export interface EditorProbeDeps {
  doc: EditorDocument
  views: EditorViewRegistry
  selection: SelectionManager
  history: CommandHistory
  tools: ToolManager
  gizmo: GizmoController
  xform: TransformSession
  interaction: InteractionController
  viewport: ViewportInteraction
  cameraController: EditorCameraController
  camera: FreeCamera
  canvas: HTMLCanvasElement
  scene: Scene
  faceSelection: FaceSelection
  faceOverlays: FaceOverlayManager
  saveController: SaveController
  connection: EditorConnection
  assets: AssetController
  ui: EditorUi
  /** The terrain a stroke is currently targeting — mutable, hence a getter. */
  strokeTargetId: () => string | null
  placeModel: (modelId: string) => void
  withLock: (ids: readonly string[], then: () => void) => boolean
  refreshPivot: () => void
}
/** Attach the harness surface to `window`. Called once, at the end of boot. */
export declare function installEditorProbe(d: EditorProbeDeps): void
//# sourceMappingURL=devProbe.d.ts.map
