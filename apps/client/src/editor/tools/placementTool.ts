/**
 * Placing things: the ghost preview, where a click lands, and what object
 * that becomes.
 *
 * Two behaviours worth naming:
 *
 * The BLANK-MAP BOOTSTRAP. A brand-new map has no geometry, so a placement
 * ray hits nothing and the first object could never be placed at all. When
 * the authored count is zero the first object commits at exactly the origin
 * wherever the user clicks — rather than the old answer, which was to keep a
 * hidden ground plane around purely so the ray had something to hit.
 *
 * SURFACE ALIGNMENT. A placed object's local +Y aligns to the surface normal,
 * so a box dropped on a slope sits on it rather than through it, and the
 * wheel yaw then turns it about that normal. Nodes, props and the spawn flag
 * stay upright regardless: a tree growing sideways out of a hill is never
 * what was meant.
 */
import { Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector.js'
import type { Mesh } from '@babylonjs/core/Meshes/mesh.js'
import type { Scene } from '@babylonjs/core/scene.js'
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh.js'
import { blankHeights, type MapModelV2, type StaticObjectV2 } from '@hobo/content'
import { NODE_LOOKS, newId, type Placeable } from '../catalog.js'
import { meshForShape } from '../../render/sceneSetup.js'
import type { EditorObjectKind } from '../document/editorDocument.js'

export interface PlacePose {
  pos: Vector3
  rot: Quaternion
}

export interface PlacementContext {
  scene: Scene
  /** How many authored objects exist — drives the origin bootstrap. */
  authoredCount: () => number
  models: () => readonly MapModelV2[]
  /** Snap step in metres; 0 or a held bypass disables it. */
  snapStep: () => number
  snapBypassed: () => boolean
}

export const shapeHeight = (shape: StaticObjectV2['shape']): number =>
  shape.type === 'box' ? shape.size[1] : shape.type === 'cylinder' ? shape.height : shape.radius * 2

export function placeableShape(
  def: Placeable,
  models: readonly MapModelV2[],
): StaticObjectV2['shape'] {
  if (def.kind === 'static') return def.shape!
  if (def.kind === 'node') return NODE_LOOKS[def.node!]?.shape ?? { type: 'sphere', radius: 0.6 }
  if (def.kind === 'model') {
    const b = models.find((m) => m.id === def.modelId)?.bounds ?? [1, 1, 1]
    return { type: 'box', size: [b[0]!, b[1]!, b[2]!] }
  }
  return { type: 'box', size: [0.3, 3, 0.3] } // spawn flag pole
}

/** Kinds that always stand upright, whatever they were dropped on. */
const UPRIGHT = new Set(['node', 'spawn', 'prop'])

export class PlacementTool {
  private ghost: Mesh | null = null
  private ghostKey = ''
  private yaw = 0

  constructor(private readonly ctx: PlacementContext) {}

  get placeYaw(): number {
    return this.yaw
  }

  /** The wheel rotates the preview while a placement tool is active. */
  rotatePreview(delta: number): void {
    this.yaw += delta
  }

  resetYaw(): void {
    this.yaw = 0
  }

  private snap(v: number): number {
    const step = this.ctx.snapStep()
    if (this.ctx.snapBypassed() || step <= 0) return v
    return Math.round(v / step) * step
  }

  /** Build/refresh the translucent preview for `def`. */
  ensureGhost(def: Placeable | null, key: string): Mesh | null {
    if (!def) {
      this.clearGhost()
      return null
    }
    if (this.ghost && this.ghostKey === key) return this.ghost
    this.ghost?.dispose()
    const shape = placeableShape(def, this.ctx.models())
    const color =
      def.kind === 'static'
        ? (def.color ?? '#8a8d90')
        : def.kind === 'node'
          ? (NODE_LOOKS[def.node!]?.color ?? '#888888')
          : '#e8b54a'
    this.ghost = meshForShape(this.ctx.scene, 'ghost', shape, color)
    this.ghost.visibility = 0.5
    this.ghost.isPickable = false
    this.ghostKey = key
    return this.ghost
  }

  clearGhost(): void {
    this.ghost?.dispose()
    this.ghost = null
    this.ghostKey = ''
  }

  get preview(): Mesh | null {
    return this.ghost
  }

  /** Where the object would go, or null when the ray hits nothing. */
  computePose(def: Placeable | null): PlacePose | null {
    if (!def) return null
    const upright = Quaternion.RotationAxis(new Vector3(0, 1, 0), this.yaw)
    // Blank map: the first object goes to the origin wherever you click.
    if (this.ctx.authoredCount() === 0) return { pos: new Vector3(0, 0, 0), rot: upright }

    const { scene } = this.ctx
    const pick = scene.pick(
      scene.pointerX,
      scene.pointerY,
      (m: AbstractMesh) => m !== this.ghost && m.isEnabled() && m.isPickable,
    )
    if (!pick?.hit || !pick.pickedPoint) return null

    const shape = placeableShape(def, this.ctx.models())
    const n = pick.getNormal(true) ?? new Vector3(0, 1, 0)
    const rot =
      UPRIGHT.has(def.kind) || n.y > 0.95
        ? upright
        : Quaternion.FromUnitVectorsToRef(
            new Vector3(0, 1, 0),
            n.normalizeToNew(),
            new Quaternion(),
          ).multiply(upright)
    const off = n.scale(shapeHeight(shape) / 2 + 0.001)
    return {
      pos: new Vector3(
        this.snap(pick.pickedPoint.x + off.x),
        pick.pickedPoint.y + off.y,
        this.snap(pick.pickedPoint.z + off.z),
      ),
      rot,
    }
  }

  updatePreview(def: Placeable | null, key: string): void {
    const g = this.ensureGhost(def, key)
    const pose = this.computePose(def)
    if (g && pose) {
      g.setEnabled(true)
      g.position.copyFrom(pose.pos)
      g.rotationQuaternion = pose.rot
    } else g?.setEnabled(false)
  }
}

/**
 * The document object a placement produces. Returning the value rather than
 * inserting it keeps this pure — the caller wraps it in a command, which is
 * what makes placement undoable without this knowing history exists.
 */
export function objectForPlacement(
  def: Placeable,
  pose: PlacePose,
  models: readonly MapModelV2[],
): { kind: EditorObjectKind; object: Record<string, unknown> } | null {
  const e = pose.rot.toEulerAngles()
  const tilted = Math.abs(e.x) > 0.01 || Math.abs(e.z) > 0.01
  const rot = tilted ? { rot: [e.x, e.y, e.z] } : {}

  switch (def.kind) {
    case 'static':
      return {
        kind: 'static',
        object: {
          id: newId('s'),
          shape: structuredClone(def.shape!),
          pos: [pose.pos.x, pose.pos.y, pose.pos.z],
          yaw: e.y,
          ...rot,
          color: def.color ?? '#8a8d90',
          ...(def.tex ? { tex: def.tex } : {}),
          ...(def.decor ? { decor: def.decor } : {}),
        },
      }
    case 'model': {
      const model = models.find((m) => m.id === def.modelId)
      if (!model) return null
      return {
        kind: 'static',
        object: {
          id: newId('s'),
          // The primitive stays the physics proxy; the glb is what renders.
          shape: { type: 'box', size: [...model.bounds] },
          pos: [pose.pos.x, pose.pos.y, pose.pos.z],
          yaw: e.y,
          ...rot,
          color: '#8a8d90',
          model: model.id,
        },
      }
    }
    case 'node':
      return {
        kind: 'node',
        object: { id: newId('n'), node: def.node!, pos: [pose.pos.x, 0, pose.pos.z] },
      }
    case 'prop':
      return {
        kind: 'prop',
        object: { id: newId('pr'), item: def.node!, pos: [pose.pos.x, 1, pose.pos.z], yaw: e.y },
      }
    case 'spawn':
      return {
        kind: 'spawn',
        object: { id: 'spawn', pos: [pose.pos.x, pose.pos.y, pose.pos.z], yaw: e.y },
      }
    case 'patch': {
      const sub = 32
      return {
        kind: 'terrain',
        object: {
          id: newId('terrain'),
          pos: [pose.pos.x, pose.pos.y, pose.pos.z],
          halfExtent: 16,
          sub,
          heights: blankHeights(sub),
        },
      }
    }
  }
}
