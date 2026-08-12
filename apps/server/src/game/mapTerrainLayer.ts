/**
 * Map-authored terrain collision, keyed by stable id.
 *
 * `rebuildTerrain()` removed and recreated EVERY terrain body on every save,
 * so retinting one surface tore down and rebuilt the collision for the whole
 * map. A trimesh body is the single most expensive thing this server
 * allocates, the editor saves constantly, and rendering and physics are
 * separate costs — only one of them moved.
 *
 * Reconciled by id, with the signature covering only what collision actually
 * depends on: a surface-only edit touches no body at all, a sculpt rebuilds
 * exactly the terrain that was sculpted, and an identical repeated save does
 * nothing.
 */
import { buildPatchGrid, scalePatchPositions, type TerrainPatchData } from '@hobo/content'
import { CollisionLayer, type BodyId, type PhysicsWorld } from '@hobo/physics'
import { qfromEuler, quat, vec3 } from '@hobo/shared'

/**
 * What the collision body is made of. Deliberately NOT the whole object:
 * `surface` (textures, tints, paint layers) is excluded, which is what makes
 * a repaint free on the server.
 */
export function terrainCollisionSignature(t: TerrainPatchData): string {
  return JSON.stringify([
    t.origin,
    t.rot ?? null,
    t.scale ?? null,
    t.halfExtent,
    t.sub,
    // The heights themselves: a sculpt must rebuild, a rename must not.
    hashHeights(t.heights),
  ])
}

/** Cheap order-sensitive digest; collisions here only cost a rebuild. */
function hashHeights(heights: Float32Array): number {
  let h = 0x811c9dc5
  for (let i = 0; i < heights.length; i++) {
    h ^= Math.round((heights[i] ?? 0) * 1000)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

type BodyPhysics = Pick<PhysicsWorld, 'addBody' | 'removeBody'>

export class MapTerrainLayer {
  private readonly bodies = new Map<string, { body: BodyId; signature: string }>()

  /**
   * Cumulative bodies created and destroyed. Exposed so "an identical save
   * causes no churn" is checkable from outside the process rather than
   * inferred from a count that would look the same either way.
   */
  rebuilds = 0

  constructor(private readonly physics: BodyPhysics) {}

  get size(): number {
    return this.bodies.size
  }

  bodyOf(id: string): BodyId | undefined {
    return this.bodies.get(id)?.body
  }

  /** Bring collision into line with `terrains`, touching only what changed. */
  reconcile(terrains: readonly TerrainPatchData[]): void {
    const next = new Map<string, TerrainPatchData>()
    for (const t of terrains) if (t.id) next.set(t.id, t)

    for (const [id, entry] of this.bodies) {
      const after = next.get(id)
      if (after && terrainCollisionSignature(after) === entry.signature) continue
      this.physics.removeBody(entry.body)
      this.rebuilds++
      this.bodies.delete(id)
    }
    for (const [id, t] of next) {
      if (this.bodies.has(id)) continue
      this.bodies.set(id, { body: this.addBody(t), signature: terrainCollisionSignature(t) })
    }
  }

  clear(): void {
    for (const { body } of this.bodies.values()) this.physics.removeBody(body)
    this.bodies.clear()
  }

  private addBody(patch: TerrainPatchData): BodyId {
    const grid = buildPatchGrid(patch.halfExtent, patch.sub, patch.heights)
    const rot = patch.rot ? qfromEuler(quat(), patch.rot[0], patch.rot[1], patch.rot[2]) : quat()
    // Scale the VERTICES rather than the body: Babylon/Havok apply
    // scale→rotate→translate, matching the client mesh's `scaling`, so the
    // two cannot disagree about where the ground is.
    const positions = scalePatchPositions(grid.positions, patch.scale)
    return this.physics.addBody({
      shape: { type: 'trimesh', positions, indices: grid.indices },
      motion: 'static',
      pos: vec3(patch.origin[0], patch.origin[1], patch.origin[2]),
      rot,
      layer: CollisionLayer.Static,
      collidesWith: CollisionLayer.Prop | CollisionLayer.Player,
    })
  }
}
