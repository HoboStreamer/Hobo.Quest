/**
 * The transform gizmo, and the rule that a press belonging to it belongs to
 * it for the whole gesture.
 *
 * The original bug: the editor listened on raw DOM pointer events, while
 * Babylon's `UtilityLayerRenderer` only suppresses its OWN
 * `scene.onPointerObservable` when a gizmo is hit. The engine had no way to
 * say "the gizmo took this one", so a press on a handle ALSO ran scene
 * selection behind it — dragging a box on terrain reselected the terrain
 * mid-drag.
 *
 * The fix is ordering, not a hover flag. `new Scene(engine)` attaches
 * Babylon's input manager during construction, before any editor listener
 * exists, so the gizmo's `onDragStartObservable` has already run
 * synchronously inside the same DOM pointerdown by the time the editor's
 * canvas handler executes. The gesture is claimed by then, and
 * `canStartGesture()` is false for everything behind it. No timeouts, no
 * stale booleans.
 *
 * The gizmo always rides a PIVOT node, single selection included, so group
 * and single transforms are one code path and the gizmo never has to be
 * parented to something the document might rebuild.
 */
import { GizmoManager } from '@babylonjs/core/Gizmos/gizmoManager.js'
import type { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { Quaternion } from '@babylonjs/core/Maths/math.vector.js'
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js'
import type { Scene } from '@babylonjs/core/scene.js'
import type { InteractionController } from '../interaction/interactionController.js'
import type { EditorTransform } from './transformMath.js'
import type { TransformSpace } from './editorPreferences.js'

export type GizmoMode = 'move' | 'rotate' | 'scale'

export interface GizmoControllerOptions {
  scene: Scene
  interaction: InteractionController
  /** Begin a transform over these ids; false = do not start the drag. */
  onDragStart: (mode: GizmoMode) => boolean
  onDrag: (pivot: EditorTransform) => void
  onDragEnd: () => void
}

export class GizmoController {
  private readonly manager: GizmoManager
  private readonly pivot: TransformNode
  private readonly wired = new WeakSet<object>()
  private mode: GizmoMode = 'move'
  private space: TransformSpace = 'world'
  private snap = { translate: 0, rotate: 0, scale: 0 }

  constructor(private readonly opts: GizmoControllerOptions) {
    this.manager = new GizmoManager(opts.scene)
    // Attachment is driven by the selection, never by where the pointer is.
    this.manager.usePointerToAttachGizmos = false
    this.manager.attachToMesh(null)
    this.pivot = new TransformNode('gizmopivot', opts.scene)
    this.setMode('move')
  }

  get active(): boolean {
    return this.manager.attachedNode !== null
  }

  /** The pivot's current pose — what a drag frame reports. */
  pivotTransform(): EditorTransform {
    const q = this.pivot.rotationQuaternion ?? Quaternion.Identity()
    return {
      position: [this.pivot.position.x, this.pivot.position.y, this.pivot.position.z],
      rotation: [q.x, q.y, q.z, q.w],
      scale: [this.pivot.scaling.x, this.pivot.scaling.y, this.pivot.scaling.z],
    }
  }

  /**
   * Put the pivot at the group's centre with identity rotation and scale, so
   * the gizmo reports DELTAS — which is what the group inspector labels them
   * as, and what makes a group rotation rotate about the group rather than
   * about whichever member happened to be first.
   */
  setPivot(centre: readonly [number, number, number], orientation?: EditorTransform): void {
    this.pivot.position.set(centre[0], centre[1], centre[2])
    this.pivot.scaling.set(1, 1, 1)
    // Local space on a single selection aligns the handles with the object.
    const useLocal = this.space === 'local' && orientation
    this.pivot.rotationQuaternion = useLocal
      ? new Quaternion(
          orientation.rotation[0],
          orientation.rotation[1],
          orientation.rotation[2],
          orientation.rotation[3],
        )
      : Quaternion.Identity()
  }

  attach(on: boolean): void {
    this.manager.attachToNode(on ? this.pivot : null)
    if (on) this.wire()
  }

  setMode(mode: GizmoMode): void {
    this.mode = mode
    this.manager.positionGizmoEnabled = mode === 'move'
    this.manager.rotationGizmoEnabled = mode === 'rotate'
    this.manager.scaleGizmoEnabled = mode === 'scale'
    this.wire()
    this.applySnap()
  }

  get currentMode(): GizmoMode {
    return this.mode
  }

  /**
   * World vs local handle orientation. This changes the MATHS, not only the
   * label: in local space the handles align with the object's own axes, so
   * dragging "X" on a rotated wall slides along the wall.
   */
  setSpace(space: TransformSpace): void {
    this.space = space
    for (const g of [this.manager.gizmos.positionGizmo, this.manager.gizmos.scaleGizmo]) {
      if (g) g.updateGizmoRotationToMatchAttachedMesh = space === 'local'
    }
    const rot = this.manager.gizmos.rotationGizmo
    if (rot) rot.updateGizmoRotationToMatchAttachedMesh = space === 'local'
  }

  /** Snap increments; 0 disables. Applied to Babylon's own drag steps. */
  setSnap(translate: number, rotate: number, scale: number): void {
    this.snap = { translate, rotate, scale }
    this.applySnap()
  }

  private applySnap(): void {
    const p = this.manager.gizmos.positionGizmo
    if (p) p.snapDistance = this.snap.translate
    const r = this.manager.gizmos.rotationGizmo
    if (r) r.snapDistance = this.snap.rotate
    const s = this.manager.gizmos.scaleGizmo
    if (s) s.snapDistance = this.snap.scale
  }

  /** Screen position of a handle, for the browser test harness. */
  handleScreenPosition(axis: 'x' | 'y' | 'z'): TransformNode | null {
    const g =
      this.mode === 'move'
        ? this.manager.gizmos.positionGizmo
        : this.mode === 'rotate'
          ? this.manager.gizmos.rotationGizmo
          : this.manager.gizmos.scaleGizmo
    if (!g) return null
    const per = axis === 'x' ? g.xGizmo : axis === 'y' ? g.yGizmo : g.zGizmo
    return (per as unknown as { _rootMesh?: TransformNode })._rootMesh ?? null
  }

  get utilityScene(): Scene | null {
    return this.manager.utilityLayer?.utilityLayerScene ?? null
  }

  private wire(): void {
    for (const g of [
      this.manager.gizmos.positionGizmo,
      this.manager.gizmos.rotationGizmo,
      this.manager.gizmos.scaleGizmo,
    ]) {
      if (!g || this.wired.has(g)) continue
      this.wired.add(g)
      g.onDragStartObservable.add(() => {
        // Claimed BEFORE the editor's canvas pointerdown handler runs — this
        // is what stops the press leaking through to whatever is behind the
        // handle.
        this.opts.interaction.begin('gizmo-drag', {
          x: this.opts.scene.pointerX,
          y: this.opts.scene.pointerY,
          pointerId: 0,
        })
        if (!this.opts.onDragStart(this.mode)) {
          // Nothing transformable, or a lock refused: let the gesture go
          // rather than dragging a pivot that writes nowhere.
          this.opts.interaction.cancel()
        }
      })
      g.onDragObservable.add(() => this.opts.onDrag(this.pivotTransform()))
      g.onDragEndObservable.add(() => {
        this.opts.onDragEnd()
        this.opts.interaction.end()
      })
    }
    this.setSpace(this.space)
    this.applySnap()
  }

  /** Frame helper: the pivot's world position as a Vector3. */
  pivotPosition(): Vector3 {
    return this.pivot.position.clone()
  }

  dispose(): void {
    this.manager.dispose()
    this.pivot.dispose()
  }
}
