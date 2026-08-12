/**
 * The Babylon projections of document objects.
 *
 * One view per object kind. Each owns its meshes, materials and editor-only
 * helper geometry (terrain wireframes, light widgets, zone volumes) and knows
 * how to bring them into line with a changed document value — cheaply where
 * it can, by asking for a rebuild where it cannot.
 *
 * Views hold NO authored data. Everything they draw is read from the document
 * object handed to them, so there is no second copy to drift.
 */
import { Color3 } from '@babylonjs/core/Maths/math.color.js'
import { Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector.js'
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder.js'
import { CreateCylinder } from '@babylonjs/core/Meshes/Builders/cylinderBuilder.js'
import { CreateSphere } from '@babylonjs/core/Meshes/Builders/sphereBuilder.js'
import { Mesh } from '@babylonjs/core/Meshes/mesh.js'
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData.js'
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer.js'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js'
import type { Scene } from '@babylonjs/core/scene.js'
import type { TransformNode } from '@babylonjs/core/Meshes/transformNode.js'
import {
  buildPatchGrid,
  decodeHeights,
  encodeHeights,
  migrateLegacyMix,
  type ContentRegistry,
  type MapLightV2,
  type MapNodeV2,
  type MapPropV2,
  type MapZoneV2,
  type StaticObjectV2,
  type SurfaceMaterialData,
  type TerrainObjectV2,
} from '@hobo/content'
import { NODE_LOOKS } from '../../catalog.js'
import { meshForShape } from '../../../render/sceneSetup.js'
import { applyStaticStyle, instantiateMapLight } from '../../../render/mapStyle.js'
import { LayeredSurfaceMaterial } from '../../../render/layeredSurface.js'
import { PaintMask } from '../../materials/paintMask.js'
import type { ModelCache } from '../../assets/modelCache.js'
import type { EditorObject, EditorObjectKind } from '../../document/editorDocument.js'
import type { EditorView } from '../editorViewRegistry.js'

/** Everything a view needs that is not the object itself. */
export interface ViewContext {
  scene: Scene
  content: ContentRegistry
  modelCache: ModelCache
  /** Shared wireframe material for terrain sculpt overlays. */
  wireMat: StandardMaterial
  /** Highest authored terrain at (x, z); 0 where none covers it. */
  sampleGround: (x: number, z: number) => number
  /** glb source for an imported model id, or null. */
  modelSource: (id: string) => string | null
  /** Ask for a rebuild after async work changed the mesh set. */
  reindex: (id: string) => void
  newId: (prefix: string) => string
}

const setPose = (
  mesh: TransformNode,
  pos: readonly number[],
  euler: readonly number[] | null,
  scale?: readonly number[],
): void => {
  mesh.position.set(pos[0]!, pos[1]!, pos[2]!)
  mesh.rotationQuaternion = null
  if (euler) mesh.rotation.set(euler[0]!, euler[1]!, euler[2]!)
  if (scale) mesh.scaling.set(scale[0]!, scale[1]!, scale[2]!)
}

const shapeHeight = (shape: StaticObjectV2['shape']): number =>
  shape.type === 'box' ? shape.size[1] : shape.type === 'cylinder' ? shape.height : shape.radius * 2

// ── Static geometry / imported model instances ────────────────────────

/** Keys a static view can apply without rebuilding its mesh. */
const STATIC_CHEAP = new Set(['pos', 'rot', 'yaw', 'scale'])

class StaticView implements EditorView {
  readonly kind = 'static' as const
  readonly root: Mesh
  private modelDisposer: (() => void) | null = null
  private alive = true

  constructor(
    readonly id: string,
    private body: StaticObjectV2,
    private readonly ctx: ViewContext,
  ) {
    this.root = meshForShape(ctx.scene, `static:${id}`, body.shape, body.color)
    applyStaticStyle(ctx.scene, this.root, body)
    this.applyPose()
    if (body.model) this.attachModel(body.model)
  }

  private applyPose(): void {
    const b = this.body
    setPose(this.root, b.pos, b.rot ?? [0, b.yaw, 0], b.scale ?? [1, 1, 1])
  }

  private attachModel(modelId: string): void {
    const glb = this.ctx.modelSource(modelId)
    if (!glb) return
    // Parsed once and instanced per placement (see assets/modelCache.ts).
    void this.ctx.modelCache.instantiate(modelId, glb).then((inst) => {
      if (!inst) return
      if (!this.alive) {
        inst.dispose()
        return
      }
      inst.root.parent = this.root
      this.root.visibility = 0.12 // faint proxy so it stays selectable
      // Child meshes never absorb picks; the registry resolves the owner
      // through the parent chain instead.
      for (const m of inst.root.getChildMeshes()) m.isPickable = false
      this.modelDisposer = () => inst.dispose()
      this.ctx.reindex(this.id)
    })
  }

  meshes(): Mesh[] {
    return [this.root]
  }

  update(object: EditorObject, keys: readonly string[]): boolean {
    this.body = object as StaticObjectV2
    if (keys.every((k) => STATIC_CHEAP.has(k))) {
      this.applyPose()
      return true
    }
    // Colour, texture, faces and per-face styles restyle in place; a shape
    // or model change needs a new mesh.
    if (keys.some((k) => k === 'shape' || k === 'model')) return false
    applyStaticStyle(this.ctx.scene, this.root, this.body)
    this.applyPose()
    return true
  }

  setVisible(on: boolean): void {
    this.root.setEnabled(on)
  }

  dispose(): void {
    this.alive = false
    this.modelDisposer?.()
    this.root.dispose(false, true)
  }
}

// ── Resource nodes and props (gameplay stand-ins) ─────────────────────

class NodeView implements EditorView {
  readonly kind = 'node' as const
  readonly root: Mesh

  constructor(
    readonly id: string,
    private node: MapNodeV2,
    private readonly ctx: ViewContext,
  ) {
    const look = NODE_LOOKS[node.node] ?? {
      color: '#888888',
      shape: { type: 'sphere', radius: 0.6 } as const,
    }
    this.root = meshForShape(ctx.scene, `node:${id}`, look.shape, look.color)
    this.root.metadata = { height: shapeHeight(look.shape) }
    this.applyPose()
  }

  private applyPose(): void {
    const n = this.node
    const h = (this.root.metadata as { height: number }).height
    this.root.position.set(
      n.pos[0],
      n.pos[1] + this.ctx.sampleGround(n.pos[0], n.pos[2]) + h / 2,
      n.pos[2],
    )
  }

  meshes(): Mesh[] {
    return [this.root]
  }

  update(object: EditorObject, keys: readonly string[]): boolean {
    this.node = object as MapNodeV2
    // The look is driven by the node TYPE, so changing it needs a new mesh.
    if (keys.includes('node')) return false
    this.applyPose()
    return true
  }

  setVisible(on: boolean): void {
    this.root.setEnabled(on)
  }

  dispose(): void {
    this.root.dispose(false, true)
  }
}

class PropView implements EditorView {
  readonly kind = 'prop' as const
  readonly root: Mesh

  constructor(
    readonly id: string,
    private prop: MapPropV2,
    private readonly ctx: ViewContext,
  ) {
    const rep = ctx.content.worldRepOf(prop.item)
    this.root = meshForShape(ctx.scene, `prop:${id}`, rep.shape, rep.color)
    this.root.metadata = { height: shapeHeight(rep.shape) }
    this.applyPose()
  }

  private applyPose(): void {
    const p = this.prop
    const h = (this.root.metadata as { height: number }).height
    this.root.position.set(
      p.pos[0],
      p.pos[1] + this.ctx.sampleGround(p.pos[0], p.pos[2]) + h / 2,
      p.pos[2],
    )
    this.root.rotation.y = p.yaw ?? 0
  }

  meshes(): Mesh[] {
    return [this.root]
  }

  update(object: EditorObject, keys: readonly string[]): boolean {
    this.prop = object as MapPropV2
    if (keys.includes('item')) return false
    this.applyPose()
    return true
  }

  setVisible(on: boolean): void {
    this.root.setEnabled(on)
  }

  dispose(): void {
    this.root.dispose(false, true)
  }
}

// ── Lights: widget mesh + a LIVE Babylon light ────────────────────────

export const lightQuat = (l: MapLightV2): Quaternion =>
  l.dir
    ? Quaternion.FromUnitVectorsToRef(
        new Vector3(0, -1, 0),
        new Vector3(l.dir[0], l.dir[1], l.dir[2]).normalize(),
        new Quaternion(),
      )
    : Quaternion.Identity()

class LightView implements EditorView {
  readonly kind = 'light' as const
  readonly root: Mesh
  private instance: ReturnType<typeof instantiateMapLight> | null = null
  private readonly material: StandardMaterial

  constructor(
    readonly id: string,
    private light: MapLightV2,
    private readonly ctx: ViewContext,
  ) {
    this.root = CreateSphere(`light:${id}`, { diameter: 0.55, segments: 10 }, ctx.scene)
    this.material = new StandardMaterial(`lightm:${id}`, ctx.scene)
    this.material.disableLighting = true
    this.root.material = this.material
    if (light.type !== 'point') {
      // Direction cone (apex points along the light's -Y "beam" axis).
      const arrow = CreateCylinder(
        `lighta:${id}`,
        { diameterTop: 0.26, diameterBottom: 0.02, height: 0.7, tessellation: 10 },
        ctx.scene,
      )
      arrow.parent = this.root
      arrow.position.y = -0.65
      arrow.material = this.material
      arrow.isPickable = false
    }
    this.sync()
  }

  private sync(): void {
    const l = this.light
    this.root.position.set(l.pos[0], l.pos[1], l.pos[2])
    this.root.rotationQuaternion = lightQuat(l)
    this.material.emissiveColor = Color3.FromHexString(l.color ?? '#ffffff')
    this.instance?.dispose()
    this.instance = instantiateMapLight(this.ctx.scene, l)
  }

  meshes(): Mesh[] {
    return [this.root]
  }

  update(object: EditorObject, keys: readonly string[]): boolean {
    const next = object as MapLightV2
    // The widget's arrow exists only for directional types.
    if (keys.includes('type') && next.type !== this.light.type) return false
    this.light = next
    this.sync()
    return true
  }

  setVisible(on: boolean): void {
    this.root.setEnabled(on)
  }

  dispose(): void {
    this.instance?.dispose()
    this.instance = null
    this.root.dispose(false, true)
  }
}

// ── Spawn point ───────────────────────────────────────────────────────

class SpawnView implements EditorView {
  readonly kind = 'spawn' as const
  readonly root: Mesh

  constructor(
    readonly id: string,
    private spawn: { pos: [number, number, number]; yaw: number },
    ctx: ViewContext,
  ) {
    // A pole with a pennant, so the facing is readable at a glance.
    this.root = CreateCylinder('spawnpole', { diameter: 0.12, height: 3 }, ctx.scene)
    const flag = meshForShape(
      ctx.scene,
      'spawnpennant',
      { type: 'box', size: [1.2, 0.5, 0.06] },
      '#e8b54a',
    )
    flag.parent = this.root
    flag.position.set(0.65, 1.1, 0)
    this.root.getChildMeshes().forEach((m) => (m.isPickable = true))
    this.apply()
  }

  private apply(): void {
    this.root.position.set(this.spawn.pos[0], this.spawn.pos[1] + 1.5, this.spawn.pos[2])
    this.root.rotation.y = this.spawn.yaw
  }

  meshes(): Mesh[] {
    return [this.root]
  }

  update(object: EditorObject): boolean {
    this.spawn = object as { pos: [number, number, number]; yaw: number }
    this.apply()
    return true
  }

  setVisible(on: boolean): void {
    this.root.setEnabled(on)
  }

  dispose(): void {
    this.root.dispose(false, true)
  }
}

// ── Zones: a translucent volume you can see the rules of ──────────────

class ZoneView implements EditorView {
  readonly kind = 'zone' as const
  readonly root: Mesh
  private readonly wire: Mesh

  constructor(
    readonly id: string,
    private zone: MapZoneV2,
    ctx: ViewContext,
  ) {
    this.root = CreateBox(`zone:${id}`, { size: 1 }, ctx.scene)
    const mat = new StandardMaterial(`zonem:${id}`, ctx.scene)
    mat.alpha = 0.12
    mat.disableLighting = true
    mat.emissiveColor = new Color3(0.35, 0.7, 1)
    mat.backFaceCulling = false
    this.root.material = mat

    this.wire = CreateBox(`zonew:${id}`, { size: 1 }, ctx.scene)
    const wm = new StandardMaterial(`zonewm:${id}`, ctx.scene)
    wm.wireframe = true
    wm.disableLighting = true
    wm.emissiveColor = new Color3(0.5, 0.85, 1)
    this.wire.material = wm
    this.wire.parent = this.root
    this.wire.isPickable = false
    this.apply()
  }

  private apply(): void {
    const z = this.zone
    this.root.position.set(
      (z.min[0] + z.max[0]) / 2,
      (z.min[1] + z.max[1]) / 2,
      (z.min[2] + z.max[2]) / 2,
    )
    this.root.scaling.set(
      Math.max(0.01, z.max[0] - z.min[0]),
      Math.max(0.01, z.max[1] - z.min[1]),
      Math.max(0.01, z.max[2] - z.min[2]),
    )
  }

  meshes(): Mesh[] {
    return [this.root]
  }

  update(object: EditorObject): boolean {
    this.zone = object as MapZoneV2
    this.apply()
    return true
  }

  setVisible(on: boolean): void {
    this.root.setEnabled(on)
  }

  dispose(): void {
    this.root.dispose(false, true)
  }
}

// ── Terrain ───────────────────────────────────────────────────────────

/**
 * A terrain's heights live in the document as base64 and in the view as a
 * decoded `Float32Array`. The decoded copy is WORKING STATE for sculpting —
 * decoding 260 000 floats per brush dab is not viable — and the view is the
 * only thing that holds it. `flushHeights()` is the one path back to the
 * document, so the two cannot silently disagree.
 */
export class TerrainView implements EditorView {
  readonly kind = 'terrain' as const
  readonly root: Mesh
  readonly wire: Mesh
  heights: Float32Array
  sub: number
  halfExtent: number
  surface: LayeredSurfaceMaterial
  mask: PaintMask
  private terrain: TerrainObjectV2

  constructor(
    readonly id: string,
    terrain: TerrainObjectV2,
    private readonly ctx: ViewContext,
  ) {
    this.terrain = terrain
    this.heights = decodeHeights(terrain.heights)
    this.sub = terrain.sub
    this.halfExtent = terrain.halfExtent

    const grid = buildPatchGrid(terrain.halfExtent, terrain.sub, this.heights)
    this.root = new Mesh(`terrain:${id}`, ctx.scene)
    const vd = new VertexData()
    vd.positions = grid.positions.slice()
    vd.indices = grid.indices
    vd.uvs = grid.uvs
    const normals: number[] = []
    VertexData.ComputeNormals(vd.positions, grid.indices, normals)
    vd.normals = normals
    vd.applyToMesh(this.root, true)

    // Wireframe overlay (same grid, +3 cm) — every terrain gets one.
    this.wire = new Mesh(`terrainwire:${id}`, ctx.scene)
    const wvd = new VertexData()
    wvd.positions = (vd.positions as number[] | Float32Array).slice() as number[]
    wvd.indices = grid.indices
    wvd.applyToMesh(this.wire, true)
    this.wire.material = ctx.wireMat
    this.wire.isPickable = false
    this.wire.position.y = 0.03
    this.wire.parent = this.root
    this.wire.setEnabled(false)

    this.mask = new PaintMask(ctx.scene, `pmask:${id}`)
    const data = this.surfaceData()
    if (data.paint?.mask) {
      const img = new Image()
      img.onload = () => this.mask.drawImage(img)
      img.crossOrigin = 'anonymous'
      img.src = data.paint.mask
    }
    this.surface = new LayeredSurfaceMaterial(ctx.scene, `psurf:${id}`, data, {
      baseTiling: Math.max(2, terrain.halfExtent / 2),
      layerTiling: Math.max(2, terrain.halfExtent / 2),
      backFaceCulling: false,
    })
    this.surface.setMaskTexture(this.mask.texture)
    this.root.material = this.surface.material
    this.applyPose()
  }

  /** The document surface, defaulted so a plain terrain still paints. */
  surfaceData(): SurfaceMaterialData {
    const t = this.terrain as TerrainObjectV2 & { tex?: string; color?: string; mix?: string }
    if (t.surface) return t.surface as SurfaceMaterialData
    let seq = 0
    return {
      base: {
        ...(t.tex && t.tex !== 'none' ? { tex: t.tex } : {}),
        ...(t.color ? { color: t.color } : {}),
      },
      ...(t.mix ? { paint: migrateLegacyMix(t.mix, () => `pl-${this.id}-${seq++}`)! } : {}),
    }
  }

  private applyPose(): void {
    const t = this.terrain
    setPose(this.root, t.pos, t.rot ?? [0, 0, 0], t.scale ?? [1, 1, 1])
  }

  /** Push the working heightfield into the mesh (and its wire overlay). */
  refreshHeights(): void {
    const buf = this.root.getVerticesData(VertexBuffer.PositionKind) as Float32Array
    const n = this.sub
    for (let j = 0; j <= n; j++) {
      for (let i = 0; i <= n; i++) {
        buf[((n - j) * (n + 1) + i) * 3 + 1] = this.heights[j * (n + 1) + i] ?? 0
      }
    }
    this.root.updateVerticesData(VertexBuffer.PositionKind, buf, true)
    const idx = this.root.getIndices() as Uint32Array
    const normals: number[] = []
    VertexData.ComputeNormals(buf, idx, normals)
    this.root.updateVerticesData(VertexBuffer.NormalKind, normals, true)
    this.wire.updateVerticesData(VertexBuffer.PositionKind, buf, true)
  }

  /** The encoded heights, for writing back to the document. */
  encodedHeights(): string {
    return encodeHeights(this.heights)
  }

  /** Re-read the material after a base/layer change. */
  refreshSurface(data: SurfaceMaterialData): void {
    this.surface.update(data)
    this.surface.setMaskTexture(this.mask.texture)
  }

  setWireVisible(on: boolean): void {
    this.wire.setEnabled(on)
  }

  wireVisible(): boolean {
    return this.wire.isEnabled()
  }

  meshes(): Mesh[] {
    return [this.root]
  }

  update(object: EditorObject, keys: readonly string[]): boolean {
    const next = object as TerrainObjectV2
    // Resolution or extent means a different grid entirely.
    if (next.sub !== this.sub || next.halfExtent !== this.halfExtent) return false
    this.terrain = next
    if (keys.includes('heights')) {
      // Undo/redo and remote merges write heights straight to the document;
      // the working buffer follows.
      this.heights = decodeHeights(next.heights)
      this.refreshHeights()
    }
    if (keys.includes('surface')) this.refreshSurface(this.surfaceData())
    this.applyPose()
    return true
  }

  setVisible(on: boolean): void {
    this.root.setEnabled(on)
  }

  dispose(): void {
    this.surface.material.dispose()
    this.mask.texture.dispose()
    this.root.dispose(false, true)
  }
}

/** The factory the registry uses. */
export function createViewFactory(ctx: ViewContext) {
  return (id: string, kind: EditorObjectKind, object: EditorObject): EditorView => {
    switch (kind) {
      case 'terrain':
        return new TerrainView(id, object as TerrainObjectV2, ctx)
      case 'static':
        return new StaticView(id, object as StaticObjectV2, ctx)
      case 'node':
        return new NodeView(id, object as MapNodeV2, ctx)
      case 'prop':
        return new PropView(id, object as MapPropV2, ctx)
      case 'light':
        return new LightView(id, object as MapLightV2, ctx)
      case 'zone':
        return new ZoneView(id, object as MapZoneV2, ctx)
      case 'spawn':
        return new SpawnView(id, object as { pos: [number, number, number]; yaw: number }, ctx)
    }
  }
}
