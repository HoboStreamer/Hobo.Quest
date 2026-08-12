/**
 * Turning a pick into a paint stroke, for any paintable thing.
 *
 * The old control path was terrain-shaped end to end: find the terrain under
 * the cursor, check the view is a `TerrainView`, reach into its single mask,
 * stamp planar UVs. Everything else in the editor was unpaintable because
 * that path had nowhere to put them.
 *
 * Here a pick resolves to a `PaintHit` — owner id, surface id, the mask, and
 * where in that mask the cursor is — and the brush neither knows nor cares
 * whether it landed on a heightfield, one face of a box, a cylinder's wrap or
 * a slot of an imported model. The projection per shape lives in
 * `paintableSurface.ts`; this decides WHICH surface was hit and reads the
 * authored data for it out of the document.
 */
import { Vector3, type Matrix } from '@babylonjs/core/Maths/math.vector.js'
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh.js'
import type { Scene } from '@babylonjs/core/scene.js'
import {
  MAX_PAINT_LAYERS,
  allocateLayer,
  type SurfaceMaterialData,
  type StaticObjectV2,
  type TerrainObjectV2,
} from '@hobo/content'
import type { EditorDocument } from '../document/editorDocument.js'
import type { EditorViewRegistry } from '../viewport/editorViewRegistry.js'
import { TerrainView } from '../viewport/views/index.js'
import {
  WHOLE_SURFACE,
  cylindricalUV,
  faceIndexFromNormal,
  faceSurfaceId,
  faceUV,
  modelSurfaceId,
  planarUV,
  sphericalUV,
  toPaintUV,
  type PaintUV,
  type ProjectionMode,
} from './paintableSurface.js'
import type { PaintSurfaceRegistry, PaintSurfaceState } from './paintSurfaceRegistry.js'

export interface PaintHit {
  ownerId: string
  surfaceId: string
  projection: ProjectionMode
  uv: PaintUV
  /** Live mask state for this exact surface. */
  state: PaintSurfaceState
  /** The authored surface data as the document currently holds it. */
  data: SurfaceMaterialData
}

export interface PaintControllerOptions {
  scene: Scene
  doc: EditorDocument
  views: EditorViewRegistry
  registry: PaintSurfaceRegistry
  newId: (prefix: string) => string
}

/**
 * The surface data for (owner, surface), defaulted so that painting a
 * never-painted object PRESERVES how it already looks.
 *
 * A legacy static carries `color` / `tex` / `uv` / `faces`; a legacy terrain
 * carries `tex` / `color`. Those become the BASE of the v2 surface on first
 * paint, so the first brush stroke adds coverage on top of the existing
 * appearance instead of resetting the object to grey.
 */
export function surfaceDataFor(
  doc: EditorDocument,
  ownerId: string,
  surfaceId: string,
): SurfaceMaterialData {
  const kind = doc.typeOf(ownerId)
  if (kind === 'terrain') {
    const t = doc.get(ownerId, 'terrain') as
      (TerrainObjectV2 & { tex?: string; color?: string }) | null
    if (t?.surface) return structuredClone(t.surface) as SurfaceMaterialData
    return {
      base: {
        ...(t?.tex && t.tex !== 'none' ? { tex: t.tex } : {}),
        ...(t?.color ? { color: t.color } : {}),
      },
    }
  }
  const s = doc.get(ownerId, 'static') as StaticObjectV2 | null
  if (!s) return { base: {} }
  const perSurface = s.surfaces?.[surfaceId]
  if (perSurface) return structuredClone(perSurface) as SurfaceMaterialData
  if (surfaceId === WHOLE_SURFACE && s.surface)
    return structuredClone(s.surface) as SurfaceMaterialData

  // First paint on this surface: inherit the object's existing look.
  const faceIndex = /^face:(\d+)$/.exec(surfaceId)?.[1]
  const face = faceIndex !== undefined ? s.faces?.[faceIndex] : undefined
  const legacy = face ?? s.uv
  return {
    base: {
      ...(legacy?.tex && legacy.tex !== 'none'
        ? { tex: legacy.tex }
        : s.tex && s.tex !== 'none'
          ? { tex: s.tex }
          : {}),
      ...(legacy?.color ? { color: legacy.color } : s.color ? { color: s.color } : {}),
      ...(legacy ? { uv: legacy } : {}),
    },
  }
}

/** Write surface data back to the right place for the owner's kind. */
export function writeSurfaceData(
  doc: EditorDocument,
  ownerId: string,
  surfaceId: string,
  data: SurfaceMaterialData,
): void {
  const kind = doc.typeOf(ownerId)
  if (kind === 'terrain') {
    doc.update(ownerId, { surface: data as never })
    return
  }
  if (kind !== 'static') return
  if (surfaceId === WHOLE_SURFACE) {
    doc.update(ownerId, { surface: data as never })
    return
  }
  const s = doc.get(ownerId, 'static')
  doc.update(ownerId, {
    surfaces: { ...(s?.surfaces ?? {}), [surfaceId]: data } as never,
  })
}

export class PaintController {
  constructor(private readonly opts: PaintControllerOptions) {}

  /**
   * Resolve whatever is under the cursor into a paint target, or null.
   *
   * The owning object comes from the view registry (stable document id), NOT
   * from a Babylon mesh name — instance names vary between loads, so identity
   * inferred from one would not survive a reload.
   */
  hitTest(brushRadius: number): PaintHit | null {
    const { scene, doc, views } = this.opts
    const pick = scene.pick(
      scene.pointerX,
      scene.pointerY,
      (m: AbstractMesh) => m.isEnabled() && m.isPickable,
    )
    if (!pick?.hit || !pick.pickedPoint || !pick.pickedMesh) return null
    const ownerId = views.ownerOf(pick.pickedMesh)
    if (ownerId === null) return null

    const kind = doc.typeOf(ownerId)
    if (kind === 'terrain') return this.terrainHit(ownerId, pick.pickedPoint, brushRadius)
    if (kind === 'static')
      return this.staticHit(
        ownerId,
        pick.pickedMesh,
        pick.pickedPoint,
        pick.getNormal(true) ?? new Vector3(0, 1, 0),
        brushRadius,
      )
    return null
  }

  private terrainHit(ownerId: string, world: Vector3, brushRadius: number): PaintHit | null {
    const view = this.opts.views.viewOf(ownerId)
    if (!(view instanceof TerrainView)) return null
    const t = this.opts.doc.get(ownerId, 'terrain')
    if (!t) return null
    const l = toLocal(view.root, world)
    const uv = planarUV({ x: l.x, z: l.z }, t.halfExtent)
    const data = surfaceDataFor(this.opts.doc, ownerId, WHOLE_SURFACE)
    const state = this.opts.registry.ensure(ownerId, WHOLE_SURFACE, data)
    return {
      ownerId,
      surfaceId: WHOLE_SURFACE,
      projection: 'planar',
      uv: toPaintUV(uv, state.mask.size, brushRadius, t.halfExtent * 2),
      state,
      data,
    }
  }

  private staticHit(
    ownerId: string,
    mesh: AbstractMesh,
    world: Vector3,
    worldNormal: Vector3,
    brushRadius: number,
  ): PaintHit | null {
    const { doc, views, registry } = this.opts
    const s = doc.get(ownerId, 'static')
    if (!s) return null
    const root = views.rootOf(ownerId)
    if (!root) return null

    const local = toLocal(root, world)
    const localNormal = toLocalDirection(root, worldNormal)
    const shape = s.shape
    const scale = s.scale ?? [1, 1, 1]

    // An imported model instance: the picked CHILD identifies the slot, and
    // the slot id is derived from the child's position in the hierarchy so it
    // is the same after every reload.
    if (s.model && mesh !== root) {
      const surfaceId = modelSurfaceId(nodePath(mesh, root), mesh.subMeshes?.length ? 0 : 0)
      const extent = extentOf(shape, scale)
      const uv = modelUV(mesh, world, local, localNormal, extent)
      const data = surfaceDataFor(doc, ownerId, surfaceId)
      const state = registry.ensure(ownerId, surfaceId, data)
      return {
        ownerId,
        surfaceId,
        projection: uv.projection,
        uv: toPaintUV(uv.uv, state.mask.size, brushRadius, Math.max(...extent)),
        state,
        data,
      }
    }

    if (shape.type === 'box') {
      // One wall, not all six.
      const faceIndex = faceIndexFromNormal(localNormal)
      const surfaceId = faceSurfaceId(faceIndex)
      const size: [number, number, number] = [
        shape.size[0] * scale[0],
        shape.size[1] * scale[1],
        shape.size[2] * scale[2],
      ]
      const uv = faceUV(local, size, faceIndex)
      const data = surfaceDataFor(doc, ownerId, surfaceId)
      const state = registry.ensure(ownerId, surfaceId, data)
      return {
        ownerId,
        surfaceId,
        projection: 'face',
        uv: toPaintUV(uv, state.mask.size, brushRadius, Math.max(size[0], size[1], size[2])),
        state,
        data,
      }
    }

    const surfaceId = WHOLE_SURFACE
    const data = surfaceDataFor(doc, ownerId, surfaceId)
    const state = registry.ensure(ownerId, surfaceId, data)
    if (shape.type === 'cylinder') {
      const height = shape.height * scale[1]
      return {
        ownerId,
        surfaceId,
        projection: 'cylindrical',
        uv: toPaintUV(cylindricalUV(local, height), state.mask.size, brushRadius, height),
        state,
        data,
      }
    }
    const radius = shape.radius * Math.max(...scale.map(Math.abs))
    return {
      ownerId,
      surfaceId,
      projection: 'spherical',
      uv: toPaintUV(sphericalUV(local), state.mask.size, brushRadius, radius * 2),
      state,
      data,
    }
  }

  /**
   * Allocate (or reuse) the layer the brush paints into, writing the result
   * to the document so a new layer is itself part of the map.
   *
   * Returns null at the layer budget rather than swapping a texture out —
   * silently replacing someone's paint is the behaviour the layered surface
   * model was built to end.
   */
  ensureLayer(
    hit: PaintHit,
    tex: string,
    tint: string | undefined,
  ): { channel: string; data: SurfaceMaterialData } | null {
    const data = structuredClone(hit.data)
    const alloc = allocateLayer(data.paint, tex, () => this.opts.newId('pl'), tint)
    if (!alloc) return null
    data.paint = alloc.paint
    if (alloc.created) writeSurfaceData(this.opts.doc, hit.ownerId, hit.surfaceId, data)
    return { channel: alloc.layer.channel, data }
  }

  get layerBudget(): number {
    return MAX_PAINT_LAYERS
  }
}

/** Anything with a world matrix — a mesh or a transform node. */
interface Placed {
  getWorldMatrix: () => Matrix
}

/** World point → the node's local space. */
function toLocal(root: Placed, world: Vector3): Vector3 {
  return Vector3.TransformCoordinates(world, root.getWorldMatrix().clone().invert())
}

function toLocalDirection(root: Placed, worldDir: Vector3): Vector3 {
  return Vector3.TransformNormal(worldDir, root.getWorldMatrix().clone().invert()).normalize()
}

/**
 * A stable path for a child of an imported model.
 *
 * Babylon appends an instance suffix to cloned node names, so the raw name
 * differs between loads and between instances of the same model. The INDEX
 * chain from the root is stable for a given glb, which is what a persisted
 * surface id needs.
 */
function nodePath(mesh: AbstractMesh, root: unknown): string {
  const parts: number[] = []
  let node: AbstractMesh | null = mesh
  for (let depth = 0; node && node !== root && depth < 16; depth++) {
    const parent = node.parent as { getChildren?: () => unknown[] } | null
    const siblings = parent?.getChildren?.() ?? []
    const index = siblings.indexOf(node)
    parts.unshift(index < 0 ? 0 : index)
    node = parent as AbstractMesh | null
  }
  return parts.join('/') || '0'
}

const extentOf = (
  shape: StaticObjectV2['shape'],
  scale: readonly number[],
): [number, number, number] =>
  shape.type === 'box'
    ? [shape.size[0] * scale[0]!, shape.size[1] * scale[1]!, shape.size[2] * scale[2]!]
    : shape.type === 'cylinder'
      ? [shape.radius * 2 * scale[0]!, shape.height * scale[1]!, shape.radius * 2 * scale[2]!]
      : [shape.radius * 2 * scale[0]!, shape.radius * 2 * scale[1]!, shape.radius * 2 * scale[2]!]

/**
 * UVs for an imported model surface.
 *
 * Prefers the authored UV0 — that is the space the glTF's own material is
 * sampled in, so paint lands exactly where the renderer expects. Falls back to
 * a deterministic box projection when the mesh has none, because Paint doing
 * nothing at all is the worst outcome: the user cannot tell whether they
 * missed, the texture failed, or the feature is unsupported.
 */
function modelUV(
  mesh: AbstractMesh,
  world: Vector3,
  local: Vector3,
  localNormal: Vector3,
  extent: [number, number, number],
): { uv: { u: number; v: number }; projection: ProjectionMode } {
  const uvs = mesh.isVerticesDataPresent?.('uv') ? mesh.getVerticesData('uv') : null
  if (uvs && uvs.length >= 4) {
    const sampled = sampleUvAt(mesh, world)
    if (sampled) return { uv: sampled, projection: 'uv0' }
  }
  return { uv: faceUV(local, extent, faceIndexFromNormal(localNormal)), projection: 'box' }
}

/**
 * The UV under a world-space point, by barycentric interpolation across the
 * picked triangle. Uses the mesh's own UV0, so the mask lines up with the
 * material the renderer already samples.
 */
function sampleUvAt(mesh: AbstractMesh, world: Vector3): { u: number; v: number } | null {
  const positions = mesh.getVerticesData('position')
  const uvs = mesh.getVerticesData('uv')
  const indices = mesh.getIndices()
  if (!positions || !uvs || !indices) return null
  const inverse = mesh.getWorldMatrix().clone().invert()
  const p = Vector3.TransformCoordinates(world, inverse)

  let best: { u: number; v: number } | null = null
  let bestDistance = Infinity
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const [a, b, c] = [indices[i]!, indices[i + 1]!, indices[i + 2]!]
    const va = new Vector3(positions[a * 3]!, positions[a * 3 + 1]!, positions[a * 3 + 2]!)
    const vb = new Vector3(positions[b * 3]!, positions[b * 3 + 1]!, positions[b * 3 + 2]!)
    const vc = new Vector3(positions[c * 3]!, positions[c * 3 + 1]!, positions[c * 3 + 2]!)
    const bary = barycentric(p, va, vb, vc)
    if (!bary) continue
    const distance = Math.abs(bary.distance)
    if (distance >= bestDistance) continue
    bestDistance = distance
    best = {
      u: uvs[a * 2]! * bary.u + uvs[b * 2]! * bary.v + uvs[c * 2]! * bary.w,
      v: uvs[a * 2 + 1]! * bary.u + uvs[b * 2 + 1]! * bary.v + uvs[c * 2 + 1]! * bary.w,
    }
    if (distance < 1e-4) break
  }
  return best
}

function barycentric(
  p: Vector3,
  a: Vector3,
  b: Vector3,
  c: Vector3,
): { u: number; v: number; w: number; distance: number } | null {
  const v0 = b.subtract(a)
  const v1 = c.subtract(a)
  const v2 = p.subtract(a)
  const d00 = Vector3.Dot(v0, v0)
  const d01 = Vector3.Dot(v0, v1)
  const d11 = Vector3.Dot(v1, v1)
  const d20 = Vector3.Dot(v2, v0)
  const d21 = Vector3.Dot(v2, v1)
  const denom = d00 * d11 - d01 * d01
  if (Math.abs(denom) < 1e-12) return null
  const v = (d11 * d20 - d01 * d21) / denom
  const w = (d00 * d21 - d01 * d20) / denom
  const u = 1 - v - w
  if (u < -0.001 || v < -0.001 || w < -0.001) return null
  // Distance from the triangle's plane, so the closest face wins.
  const normal = Vector3.Cross(v0, v1).normalize()
  return { u, v, w, distance: Vector3.Dot(v2, normal) }
}
