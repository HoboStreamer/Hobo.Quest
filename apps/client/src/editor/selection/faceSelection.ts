/**
 * Face selection identity and per-face overlay geometry.
 *
 * Two things were wrong before. Face selections were keyed by Babylon mesh
 * reference, so any material change or undo that rebuilt the mesh silently
 * orphaned them; and "highlighting a face" added the WHOLE mesh to the
 * HighlightLayer, so selecting one face of a box lit up all six.
 *
 * A face is now identified by `objectId:faceKey`, which survives mesh
 * rebuilds, and each selected face gets its own small overlay mesh built from
 * just that face's triangles.
 */
import { Color3 } from '@babylonjs/core/Maths/math.color.js'
import { Mesh } from '@babylonjs/core/Meshes/mesh.js'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js'
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer.js'
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData.js'
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh.js'
import type { Scene } from '@babylonjs/core/scene.js'

/**
 * Which surface of an object is selected. `face` is a box face index 0..5;
 * `null` means the whole surface (cylinders, spheres, terrain), where finer
 * sub-surface semantics do not exist yet.
 */
export interface FaceRef {
  objectId: string
  face: number | null
}

export const faceKey = (r: FaceRef): string => `${r.objectId}:${r.face ?? 'all'}`

export const parseFaceKey = (key: string): FaceRef => {
  const i = key.lastIndexOf(':')
  const face = key.slice(i + 1)
  return { objectId: key.slice(0, i), face: face === 'all' ? null : Number(face) }
}

/** Babylon's box face order, matching `Math.floor(pickInfo.faceId / 2)`. */
export const FACE_NAMES = ['Front', 'Back', 'Right', 'Left', 'Top', 'Bottom'] as const

export const faceLabel = (r: FaceRef): string =>
  r.face === null ? 'whole surface' : (FACE_NAMES[r.face] ?? `face ${r.face}`)

/**
 * Ordered set of selected faces. Insertion order fixes which one is primary,
 * so the Face panel's "lift" always reads from a predictable surface.
 */
export class FaceSelection {
  private _keys: string[] = []

  get size(): number {
    return this._keys.length
  }
  keys(): string[] {
    return [...this._keys]
  }
  refs(): FaceRef[] {
    return this._keys.map(parseFaceKey)
  }
  primary(): FaceRef | null {
    const k = this._keys[0]
    return k ? parseFaceKey(k) : null
  }
  has(r: FaceRef): boolean {
    return this._keys.includes(faceKey(r))
  }

  replace(r: FaceRef): void {
    this._keys = [faceKey(r)]
  }
  /** Ctrl-click: add, or toggle off when the face is already selected. */
  toggle(r: FaceRef): void {
    const k = faceKey(r)
    const i = this._keys.indexOf(k)
    if (i >= 0) this._keys.splice(i, 1)
    else this._keys.push(k)
  }
  clear(): void {
    this._keys = []
  }
  /** Drop faces whose object no longer exists (after undo / remote merge). */
  retain(exists: (objectId: string) => boolean): void {
    this._keys = this._keys.filter((k) => exists(parseFaceKey(k).objectId))
  }
  describe(): string {
    if (this._keys.length === 0) return 'click a face · Ctrl adds · RMB applies current'
    if (this._keys.length === 1)
      return `1 face selected — ${faceLabel(parseFaceKey(this._keys[0]!))}`
    return `${this._keys.length} faces selected`
  }
}

/**
 * Draws one translucent overlay per selected face, built from that face's own
 * triangles. Overlays are editor-only: not pickable, and rendered in a later
 * rendering group with a negative z-offset so they sit on the surface without
 * z-fighting.
 */
export class FaceOverlayManager {
  private overlays = new Map<string, Mesh>()
  private readonly matPrimary: StandardMaterial
  private readonly matSecondary: StandardMaterial
  private readonly matHover: StandardMaterial

  constructor(private readonly scene: Scene) {
    const mk = (name: string, color: Color3, alpha: number): StandardMaterial => {
      const m = new StandardMaterial(name, scene)
      m.emissiveColor = color
      m.diffuseColor = Color3.Black()
      m.specularColor = Color3.Black()
      m.disableLighting = true
      m.alpha = alpha
      m.backFaceCulling = false
      // Pull the overlay towards the camera so it never z-fights the face.
      m.zOffset = -2
      return m
    }
    this.matPrimary = mk('faceovl:primary', Color3.FromHexString('#ff9d2e'), 0.45)
    this.matSecondary = mk('faceovl:secondary', Color3.FromHexString('#ffd28f'), 0.3)
    this.matHover = mk('faceovl:hover', Color3.FromHexString('#cfe8ff'), 0.18)
  }

  get count(): number {
    return this.overlays.size
  }
  keys(): string[] {
    return [...this.overlays.keys()]
  }

  /**
   * Rebuild overlays to exactly match `refs`. `meshOf` resolves an object id
   * to its CURRENT mesh, so a rebuilt mesh simply produces a fresh overlay.
   */
  sync(
    refs: readonly FaceRef[],
    meshOf: (objectId: string) => AbstractMesh | null,
    hover: FaceRef | null = null,
  ): void {
    const wanted = new Set<string>()
    refs.forEach((r, i) => {
      const key = faceKey(r)
      wanted.add(key)
      this.build(key, r, meshOf(r.objectId), i === 0 ? this.matPrimary : this.matSecondary)
    })
    if (hover) {
      const key = `hover:${faceKey(hover)}`
      if (!wanted.has(faceKey(hover))) {
        wanted.add(key)
        this.build(key, hover, meshOf(hover.objectId), this.matHover)
      }
    }
    for (const [key, mesh] of [...this.overlays]) {
      if (wanted.has(key)) continue
      mesh.dispose()
      this.overlays.delete(key)
    }
  }

  clear(): void {
    for (const m of this.overlays.values()) m.dispose()
    this.overlays.clear()
  }

  dispose(): void {
    this.clear()
    this.matPrimary.dispose()
    this.matSecondary.dispose()
    this.matHover.dispose()
  }

  private build(
    key: string,
    ref: FaceRef,
    source: AbstractMesh | null,
    material: StandardMaterial,
  ): void {
    this.overlays.get(key)?.dispose()
    this.overlays.delete(key)
    if (!source) return
    const positions = source.getVerticesData(VertexBuffer.PositionKind)
    const indices = source.getIndices()
    if (!positions || !indices) return

    // A box face is two triangles: indices [face*6, face*6+6). Anything else
    // (cylinder, sphere, terrain) highlights its whole surface, which is the
    // honest representation until sub-surface selection exists for them.
    const from = ref.face === null ? 0 : ref.face * 6
    const to = ref.face === null ? indices.length : Math.min(indices.length, from + 6)
    if (from >= indices.length) return

    const overlay = new Mesh(`faceovl:${key}`, this.scene)
    const vd = new VertexData()
    vd.positions = Array.from(positions)
    vd.indices = Array.from(indices).slice(from, to)
    const normals: number[] = []
    VertexData.ComputeNormals(vd.positions, vd.indices, normals)
    vd.normals = normals
    vd.applyToMesh(overlay, false)
    overlay.material = material
    overlay.isPickable = false
    // Ride the source's transform so the overlay tracks moves and scales.
    overlay.parent = source
    overlay.renderingGroupId = 1
    this.overlays.set(key, overlay)
  }
}
