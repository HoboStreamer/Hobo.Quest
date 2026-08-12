/**
 * The game client's map layers, reconciled by stable id.
 *
 * A `map_reload` used to rebuild every category wholesale: dispose every
 * terrain mesh, every terrain collider, every map static, every map light,
 * and make them all again. Moving one box therefore re-parsed and re-uploaded
 * the geometry of the entire map to the GPU, and rebuilt collision the player
 * was standing on — which is visible as a hitch and, mid-jump, as a fall.
 *
 * The same `diffMapFileV2` the server uses says exactly what changed, and
 * `affectsCollision` says whether a change is appearance-only. Everything
 * here keys on the document's stable ids, so client rendering, client
 * prediction physics and server physics stay in agreement about which object
 * is which.
 */
import type { Scene } from '@babylonjs/core/scene.js'
import type { Mesh } from '@babylonjs/core/Meshes/mesh.js'
import type { Light } from '@babylonjs/core/Lights/light.js'
import { affectsCollision, diffMapFileV2, type MapDiff, type MapFileV2 } from '@hobo/content'
import { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator.js'
import type { IShadowLight } from '@babylonjs/core/Lights/shadowLight.js'
import { instantiateMapLight } from './mapStyle.js'

export type { MapDiff }

/** Compute the diff once and hand each layer only its own category. */
export const mapDiff = (previous: MapFileV2, next: MapFileV2): MapDiff =>
  diffMapFileV2(previous, next)

/**
 * Which terrains need their COLLISION rebuilt, and which only their look.
 * Returned separately because the two have very different costs.
 */
export function terrainWork(diff: MapDiff): {
  collision: string[]
  appearanceOnly: string[]
  removed: string[]
  added: string[]
} {
  return {
    added: diff.terrains.added.map((t) => t.id),
    removed: diff.terrains.removed.map((t) => t.id),
    collision: diff.terrains.changed.filter((c) => affectsCollision(c.keys)).map((c) => c.id),
    appearanceOnly: diff.terrains.changed.filter((c) => !affectsCollision(c.keys)).map((c) => c.id),
  }
}

/** Keys that change a static's collider, as opposed to only its look. */
const STATIC_COLLISION_KEYS = new Set(['pos', 'rot', 'yaw', 'scale', 'shape'])

export function staticWork(diff: MapDiff): {
  added: string[]
  removed: string[]
  collision: string[]
  appearanceOnly: string[]
} {
  const changedCollision = diff.statics.changed.filter((c) =>
    c.keys.some((k) => STATIC_COLLISION_KEYS.has(k)),
  )
  return {
    added: diff.statics.added.map((s) => s.id),
    removed: diff.statics.removed.map((s) => s.id),
    collision: changedCollision.map((c) => c.id),
    appearanceOnly: diff.statics.changed
      .filter((c) => !changedCollision.includes(c))
      .map((c) => c.id),
  }
}

/**
 * Map lights, one Babylon light per document id.
 *
 * `buildMapLights` disposed and recreated all of them on every reload, so a
 * texture change made every light in the scene blink. A light's type decides
 * which Babylon class it is, so changing THAT recreates one light; everything
 * else is set on the existing one.
 */
/** Shadow generators are expensive; only a few lights get one. */
const SHADOW_BUDGET = 3
const SHADOWABLE = new Set(['spot', 'directional', 'point'])

export class MapLightLayer {
  private readonly lights = new Map<
    string,
    { light: Light; type: string; shadow: ShadowGenerator | null }
  >()

  constructor(private readonly scene: Scene) {}

  get size(): number {
    return this.lights.size
  }

  has(id: string): boolean {
    return this.lights.has(id)
  }

  /** Build (or rebuild) every light — boot, and a whole-document replace. */
  reconcile(next: MapFileV2['lights']): void {
    for (const id of [...this.lights.keys()]) this.drop(id)
    for (const spec of next.slice(0, 24)) this.create(spec)
  }

  /**
   * Only the lights the diff says changed. A texture edit used to make every
   * light in the scene blink, because the whole set was disposed and rebuilt.
   */
  reconcileFromDiff(diff: MapDiff, next: MapFileV2['lights']): void {
    const touched = new Set([
      ...diff.lights.added.map((l) => l.id),
      ...diff.lights.changed.map((c) => c.id),
    ])
    if (touched.size === 0 && diff.lights.removed.length === 0) return
    for (const removed of diff.lights.removed) this.drop(removed.id)
    for (const spec of next) {
      if (!touched.has(spec.id)) continue
      this.drop(spec.id)
      this.create(spec)
    }
  }

  private drop(id: string): void {
    const entry = this.lights.get(id)
    if (!entry) return
    // The generator owns render targets; dropping the light without it leaks.
    entry.shadow?.dispose()
    entry.light.dispose()
    this.lights.delete(id)
  }

  private create(spec: MapFileV2['lights'][number]): void {
    const light = instantiateMapLight(this.scene, spec)
    if (!light) return
    let shadow: ShadowGenerator | null = null
    const used = [...this.lights.values()].filter((e) => e.shadow !== null).length
    if (spec.shadows && SHADOWABLE.has(spec.type) && used < SHADOW_BUDGET) {
      shadow = new ShadowGenerator(1024, light as unknown as IShadowLight)
      shadow.useBlurExponentialShadowMap = true
      shadow.blurKernel = 16
      for (const m of this.scene.meshes) {
        const n = m.name
        if (n.startsWith('static:') || n.startsWith('mapstatic:') || n.startsWith('patch:')) {
          shadow.addShadowCaster(m as Mesh, true)
          m.receiveShadows = true
        }
        if (n === 'terrain') m.receiveShadows = true
      }
    }
    this.lights.set(spec.id, { light, type: spec.type, shadow })
  }

  dispose(): void {
    for (const id of [...this.lights.keys()]) this.drop(id)
  }
}

/** Dispose meshes whose name matches a prefix + id, for the visual layers. */
export function disposeById(scene: Scene, prefix: string, ids: readonly string[]): void {
  if (ids.length === 0) return
  const wanted = new Set(ids.map((id) => `${prefix}${id}`))
  for (const mesh of [...scene.meshes]) {
    if (wanted.has(mesh.name)) (mesh as Mesh).dispose(false, true)
  }
}
