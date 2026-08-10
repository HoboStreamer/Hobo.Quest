import { Vector3 } from '@babylonjs/core/Maths/math.vector.js'
import type { Scene } from '@babylonjs/core/scene.js'
/**
 * Physgun beam visuals, GMod-style: the beam leaves the muzzle ALONG THE
 * BARREL and bends toward the held point on a cubic Bezier — carrying a
 * prop off to the side visibly flexes the beam instead of pivoting a
 * straight stick. Idle (unlatched) beams are a dim, nearly-straight ray.
 * Tubes are updatable meshes: same point count every frame, zero realloc.
 */
export interface BeamState {
  from: Vector3
  to: Vector3
  /** Direction the beam LEAVES the muzzle (usually the view/barrel axis). */
  tangent?: Vector3
  /** A prop is latched: bright beam + flare; otherwise dim searching ray. */
  latched: boolean
}
export declare class BeamRenderer {
  private readonly scene
  private readonly beams
  private readonly idleMat
  private readonly strongMat
  private readonly flareMat
  private time
  constructor(scene: Scene)
  /** Reconcile active beams: key -> beam state. */
  update(dt: number, active: Map<string, BeamState>): void
  /**
   * Cubic Bezier from the muzzle: P0 at the tip, P1 pushed along the barrel
   * tangent (so the beam LEAVES straight out of the gun), P2 eased back
   * toward the target's approach, P3 at the grab point. Control lengths
   * scale with distance, giving a taut short beam and a lazy long arc.
   */
  private fillPath
  dispose(): void
}
//# sourceMappingURL=beams.d.ts.map
