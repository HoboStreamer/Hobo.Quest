/**
 * What a press on the canvas means, given the active tool.
 *
 * One place decides: select, place, sculpt, paint or face-pick. Every branch
 * asks `InteractionController` first, so a gesture the gizmo or the camera
 * already owns can never also do something here — which is the whole
 * click-through story, expressed once rather than as a hover flag per
 * handler.
 */
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js'
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh.js'
import type { Scene } from '@babylonjs/core/scene.js'
import type { Tool } from '../catalog.js'
import type { InteractionController } from './interactionController.js'
export type SelectMode = 'replace' | 'add' | 'subtract'
export declare const selectModeOf: (e: {
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
}) => SelectMode
export interface ViewportHandlers {
  /** Something was clicked (or empty space, when `id` is null). */
  onSelect: (id: string | null, mode: SelectMode) => void
  onPlace: () => void
  /** Terrain stroke; sign is +1 for raise, -1 for lower. */
  onSculptStart: (sign: number) => void
  onSculptMove: () => void
  onStrokeEnd: () => void
  onPaintStart: () => void
  onPaintMove: () => void
  onFacePick: (mode: SelectMode) => void
  /** Light and Zone both create one object at the clicked point. */
  onPlaceLight: () => void
  onPlaceZone: () => void
  /** Frame update: hover highlight, brush cursor, placement preview. */
  onFrame: () => void
}
export interface ViewportInteractionOptions {
  canvas: HTMLCanvasElement
  scene: Scene
  interaction: InteractionController
  tool: () => Tool | null
  handlers: ViewportHandlers
  /** Resolve a picked mesh to a document id. */
  ownerOf: (mesh: AbstractMesh | null) => string | null
  /** Meshes the picker may hit (the ghost and helpers are excluded). */
  pickable: (mesh: AbstractMesh) => boolean
}
export declare class ViewportInteraction {
  private readonly opts
  /** 0 none, 1 primary (raise/paint), -1 secondary (lower). */
  private stroke
  private readonly disposers
  constructor(opts: ViewportInteractionOptions)
  private on
  dispose(): void
  get painting(): number
  /** What the editor's own picker resolves at a screen point. */
  pickIdAt(x: number, y: number): string | null
  pickPoint(): {
    id: string | null
    point: Vector3
    normal: Vector3
  } | null
  private onDown
  private onMove
  private onUp
}
//# sourceMappingURL=viewportInteraction.d.ts.map
