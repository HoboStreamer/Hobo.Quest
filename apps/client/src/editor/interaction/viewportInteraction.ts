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

export const selectModeOf = (e: {
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
}): SelectMode => (e.altKey ? 'subtract' : e.ctrlKey || e.metaKey ? 'add' : 'replace')

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

export class ViewportInteraction {
  /** 0 none, 1 primary (raise/paint), -1 secondary (lower). */
  private stroke = 0
  private readonly disposers: (() => void)[] = []

  constructor(private readonly opts: ViewportInteractionOptions) {
    const { canvas } = opts
    this.on(canvas, 'pointerdown', (e) => this.onDown(e as PointerEvent))
    this.on(window, 'pointerup', () => this.onUp())
    this.on(canvas, 'pointermove', () => this.onMove())
    // A press that starts on the canvas and ends outside must still end.
    this.on(window, 'blur', () => this.onUp())
    this.on(canvas, 'contextmenu', (e) => e.preventDefault())
  }

  private on(target: EventTarget, type: string, fn: (e: Event) => void): void {
    target.addEventListener(type, fn)
    this.disposers.push(() => target.removeEventListener(type, fn))
  }

  dispose(): void {
    for (const d of this.disposers) d()
    this.disposers.length = 0
  }

  get painting(): number {
    return this.stroke
  }

  /** What the editor's own picker resolves at a screen point. */
  pickIdAt(x: number, y: number): string | null {
    const pick = this.opts.scene.pick(x, y, this.opts.pickable)
    return pick?.hit ? this.opts.ownerOf(pick.pickedMesh) : null
  }

  pickPoint(): { id: string | null; point: Vector3; normal: Vector3 } | null {
    const { scene } = this.opts
    const pick = scene.pick(scene.pointerX, scene.pointerY, this.opts.pickable)
    if (!pick?.hit || !pick.pickedPoint) return null
    return {
      id: this.opts.ownerOf(pick.pickedMesh),
      point: pick.pickedPoint,
      normal: pick.getNormal(true) ?? new Vector3(0, 1, 0),
    }
  }

  private onDown(e: PointerEvent): void {
    if (e.button !== 0 && e.button !== 2) return
    // The gizmo's drag-start has already run synchronously by now if the
    // press was on a handle, so this is false and nothing leaks through.
    if (!this.opts.interaction.canStartGesture()) return

    const tool = this.opts.tool()
    const { handlers } = this.opts
    const sign = e.button === 2 ? -1 : 1

    switch (tool) {
      case 'terrain':
        this.stroke = sign
        handlers.onSculptStart(sign)
        return
      case 'paint':
        if (e.button !== 0) return
        this.stroke = 1
        handlers.onPaintStart()
        return
      case 'mesh':
      case 'entity':
        if (e.button === 0) handlers.onPlace()
        return
      case 'face':
        if (e.button === 0) handlers.onFacePick(selectModeOf(e))
        return
      default: {
        // Select is also what "no tool" does: with nothing active you can
        // still choose things and look at them, just not change them.
        if (e.button !== 0) return
        const hit = this.pickIdAt(this.opts.scene.pointerX, this.opts.scene.pointerY)
        handlers.onSelect(hit, selectModeOf(e))
      }
    }
  }

  private onMove(): void {
    if (this.stroke === 0) return
    const tool = this.opts.tool()
    if (tool === 'terrain') this.opts.handlers.onSculptMove()
    else if (tool === 'paint') this.opts.handlers.onPaintMove()
  }

  private onUp(): void {
    if (this.stroke === 0) return
    this.stroke = 0
    this.opts.handlers.onStrokeEnd()
  }
}
