import { UniversalCamera } from '@babylonjs/core/Cameras/universalCamera.js'
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js'
import type { Scene } from '@babylonjs/core/scene.js'
import { type PlayerMoveState } from '@hobo/gameplay'
import { type PhysicsWorld } from '@hobo/physics'
import type { ServerSnapshot } from '@hobo/protocol'
import type { Connection } from '../net/connection.js'
import type { InputTracker } from '../input/inputTracker.js'
import type { ClientState } from '../state/clientState.js'
export declare class LocalPlayer {
  private readonly physics
  private readonly input
  private readonly connection
  private readonly state
  readonly camera: UniversalCamera
  readonly move: PlayerMoveState
  private readonly queries
  private pending
  private seq
  /** Previous/current tick positions for render interpolation. */
  private prevPos
  private currPos
  /** Interpolated render position (capsule center), updated each frame. */
  readonly renderPos: Vector3
  /** Smoothed eye height so stance changes glide instead of popping. */
  private eyeSmooth
  /** Reconciliation error, blended away over ~100ms instead of snapping —
   * this is what makes standing on moving props watchable. */
  private readonly corr
  constructor(
    scene: Scene,
    physics: PhysicsWorld,
    input: InputTracker,
    connection: Connection,
    state: ClientState,
    spawn: {
      x: number
      y: number
      z: number
    },
  )
  /** One fixed simulation tick: capture, send, predict. */
  fixedUpdate(): void
  private applyInput
  /** Reconcile against an authoritative snapshot. */
  onSnapshot(snap: ServerSnapshot): void
  /** Per-frame: camera follows interpolated predicted position. */
  frameUpdate(alpha: number, dt: number): void
  get viewYaw(): number
  get viewPitch(): number
  get eye(): Vector3
  viewDir(out: { x: number; y: number; z: number }): void
}
//# sourceMappingURL=localPlayer.d.ts.map
