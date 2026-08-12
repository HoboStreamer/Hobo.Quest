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
import { type TerrainPatchData } from '@hobo/content'
import { type BodyId, type PhysicsWorld } from '@hobo/physics'
/**
 * What the collision body is made of. Deliberately NOT the whole object:
 * `surface` (textures, tints, paint layers) is excluded, which is what makes
 * a repaint free on the server.
 */
export declare function terrainCollisionSignature(t: TerrainPatchData): string
type BodyPhysics = Pick<PhysicsWorld, 'addBody' | 'removeBody'>
export declare class MapTerrainLayer {
  private readonly physics
  private readonly bodies
  /**
   * Cumulative bodies created and destroyed. Exposed so "an identical save
   * causes no churn" is checkable from outside the process rather than
   * inferred from a count that would look the same either way.
   */
  rebuilds: number
  constructor(physics: BodyPhysics)
  get size(): number
  bodyOf(id: string): BodyId | undefined
  /** Bring collision into line with `terrains`, touching only what changed. */
  reconcile(terrains: readonly TerrainPatchData[]): void
  clear(): void
  private addBody
}
export {}
//# sourceMappingURL=mapTerrainLayer.d.ts.map
