import type { Scene } from '@babylonjs/core/scene.js'
import { type PhysicsWorld } from '@hobo/physics'
import { type ContentRegistry } from '@hobo/content'
/**
 * Placement preview: a translucent ghost of the equipped placeable item,
 * following the crosshair onto world surfaces. Green = the server should
 * accept; red = zone forbids building here. Purely client-side comfort —
 * the placement itself goes through the `place` message and the server
 * re-validates everything.
 */
export interface GhostPose {
  x: number
  y: number
  z: number
  yaw: number
}
declare const _dir: import('@hobo/shared').Vec3
export declare class PlacementGhost {
  private readonly scene
  private readonly physics
  private readonly content
  private mesh
  private meshDef
  private readonly okMat
  private readonly badMat
  private readonly zones
  /** Extra yaw applied by the player (wheel), relative to their facing. */
  private spin
  /** Current pose when visible + buildable; null otherwise. */
  pose: GhostPose | null
  /** Pose is valid to send (zone allows building). */
  valid: boolean
  constructor(scene: Scene, physics: PhysicsWorld, content: ContentRegistry)
  /** Map edits can change zones live. */
  refreshZones(): void
  rotate(delta: number): void
  /**
   * Per-frame: shows the ghost for the equipped placeable def (or hides it
   * for null). Shift snaps position to the item's snapStep grid.
   */
  update(
    defId: string | null,
    eye: {
      x: number
      y: number
      z: number
    },
    viewDir: (out: typeof _dir) => void,
    playerYaw: number,
    snap: boolean,
  ): void
  hide(): void
}
export {}
//# sourceMappingURL=placementGhost.d.ts.map
