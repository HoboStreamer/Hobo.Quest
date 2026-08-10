import type { Vector3 } from '@babylonjs/core/Maths/math.vector.js'
import type { Scene } from '@babylonjs/core/scene.js'
/**
 * Physgun beam visuals. The beam always fires while the trigger is held —
 * a dim searching ray when nothing is latched, a bright thick beam plus a
 * muzzle flare once a prop is held (GMod). One beam per firing player.
 */
export interface BeamState {
  from: Vector3
  to: Vector3
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
  dispose(): void
}
//# sourceMappingURL=beams.d.ts.map
