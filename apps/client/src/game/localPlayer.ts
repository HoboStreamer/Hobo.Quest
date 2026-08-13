import { UniversalCamera } from '@babylonjs/core/Cameras/universalCamera.js'
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js'
import type { Scene } from '@babylonjs/core/scene.js'
import {
  Buttons,
  DEFAULT_MOVEMENT,
  createMoveState,
  eyeOffsetFor,
  stepMovement,
  type CollisionQueries,
  type MoveInput,
  type PlayerMoveState,
} from '@hobo/gameplay'
import { CollisionLayer, type PhysicsWorld } from '@hobo/physics'
import type { ClientInput, ServerSnapshot } from '@hobo/protocol'
import type { Connection } from '../net/connection.js'
import type { InputTracker } from '../input/inputTracker.js'
import type { ClientState } from '../state/clientState.js'

/**
 * Client-side prediction of the local player.
 *
 * Runs the EXACT same movement simulation as the server (same code, same
 * params, fixed timestep) against a local mirror of the collision world.
 * Every input is sent to the server and kept in a pending list; when a
 * snapshot acks seq N, prediction rewinds to the authoritative state and
 * replays inputs > N. With no mispredictions the replay lands where we
 * already are and nothing visibly changes.
 */

const MOVE = DEFAULT_MOVEMENT

export class LocalPlayer {
  readonly camera: UniversalCamera
  readonly move: PlayerMoveState
  private readonly queries: CollisionQueries
  private pending: ClientInput[] = []
  private seq = 0
  /** Previous/current tick positions for render interpolation. */
  private prevPos = new Vector3()
  private currPos = new Vector3()
  /** Interpolated render position (capsule center), updated each frame. */
  readonly renderPos = new Vector3()
  /** Smoothed eye height so stance changes glide instead of popping. */
  private eyeSmooth = DEFAULT_MOVEMENT.eyeOffset
  /** Reconciliation error, blended away over ~100ms instead of snapping —
   * this is what makes standing on moving props watchable. */
  private readonly corr = new Vector3()
  /** Vertical step-up smoothing: stairs move the FEET instantly but the
   * EYES glide (Source's smoothed stair climb). */
  private stepOffset = 0

  constructor(
    scene: Scene,
    private readonly physics: PhysicsWorld,
    private readonly input: InputTracker,
    private readonly connection: Connection,
    private readonly state: ClientState,
    spawn: { x: number; y: number; z: number },
  ) {
    this.move = createMoveState(spawn)
    this.camera = new UniversalCamera(
      'cam',
      new Vector3(spawn.x, spawn.y + MOVE.eyeOffset, spawn.z),
      scene,
    )
    this.camera.minZ = 0.05
    this.camera.fov = 1.1
    // We drive the camera entirely from simulation + mouse; Babylon's own
    // camera inputs stay detached.
    this.camera.inputs.clear()
    // Player layer included: remote players have static mirror capsules, so
    // prediction blocks on them just like the server does. No self-exclude
    // needed — the local player has no mirror body client-side.
    this.queries = {
      sweepCapsule: (from, to, radius, height) =>
        physics.sweepCapsule(
          from,
          to,
          radius,
          height,
          CollisionLayer.Static | CollisionLayer.Prop | CollisionLayer.Player,
        ),
    }
    this.prevPos.set(spawn.x, spawn.y, spawn.z)
    this.currPos.set(spawn.x, spawn.y, spawn.z)
  }

  /** One fixed simulation tick: capture, send, predict. */
  fixedUpdate(): void {
    const buttons =
      (this.input.keyDown('Space') ? Buttons.Jump : 0) |
      (this.input.keyDown('ShiftLeft') ? Buttons.Sprint : 0) |
      (this.input.keyDown('ControlLeft') || this.input.keyDown('KeyC') ? Buttons.Crouch : 0) |
      (this.input.keyDown('KeyZ') ? Buttons.Prone : 0)
    const moveX = (this.input.keyDown('KeyD') ? 1 : 0) - (this.input.keyDown('KeyA') ? 1 : 0)
    const moveZ = (this.input.keyDown('KeyW') ? 1 : 0) - (this.input.keyDown('KeyS') ? 1 : 0)

    const cmd: ClientInput = {
      t: 'input',
      seq: ++this.seq,
      moveX,
      moveZ,
      yaw: this.input.yaw,
      pitch: this.input.pitch,
      buttons,
    }
    this.connection.send(cmd)
    this.pending.push(cmd)
    if (this.pending.length > 90) this.pending.shift()

    this.prevPos.copyFrom(this.currPos)
    const yBefore = this.move.pos.y
    const groundedBefore = this.move.grounded
    this.applyInput(cmd)
    // Grounded vertical jumps up to step height = stairs/ramp crests: fold
    // them into a decaying eye offset so the view glides up instead of
    // popping per step.
    const dy = this.move.pos.y - yBefore
    if (groundedBefore && this.move.grounded && Math.abs(dy) > 0.04 && Math.abs(dy) < 0.55) {
      this.stepOffset -= dy
      this.stepOffset = Math.max(-0.5, Math.min(0.5, this.stepOffset))
    }
    this.currPos.set(this.move.pos.x, this.move.pos.y, this.move.pos.z)
  }

  private applyInput(cmd: ClientInput): void {
    const input: MoveInput = {
      moveX: cmd.moveX,
      moveZ: cmd.moveZ,
      yaw: cmd.yaw,
      pitch: cmd.pitch,
      buttons: cmd.buttons,
    }
    stepMovement(this.move, input, MOVE, this.queries, 1 / this.state.tickRate)
  }

  /** Reconcile against an authoritative snapshot. */
  /** Vehicle being driven (server-authoritative; disables prediction). */
  driving: string | null = null

  onSnapshot(snap: ServerSnapshot): void {
    const mine = snap.players.find((p) => p.id === this.state.myEntityId)
    if (!mine) return
    this.pending = this.pending.filter((c) => c.seq > snap.ack)
    this.driving = mine.driving ?? null
    if (this.driving) {
      // Driving: the vehicle moves us — adopt the authoritative pose
      // outright (no replay; inputs steer the cart, not the body).
      this.move.pos.x = mine.pos[0]
      this.move.pos.y = mine.pos[1]
      this.move.pos.z = mine.pos[2]
      this.move.vel.x = mine.vel[0]
      this.move.vel.y = mine.vel[1]
      this.move.vel.z = mine.vel[2]
      this.currPos.set(this.move.pos.x, this.move.pos.y, this.move.pos.z)
      this.corr.x = 0
      this.corr.y = 0
      this.corr.z = 0
      return
    }

    const beforeX = this.move.pos.x
    const beforeY = this.move.pos.y
    const beforeZ = this.move.pos.z

    // Rewind to server state and replay unacked inputs.
    this.move.pos.x = mine.pos[0]
    this.move.pos.y = mine.pos[1]
    this.move.pos.z = mine.pos[2]
    this.move.vel.x = mine.vel[0]
    this.move.vel.y = mine.vel[1]
    this.move.vel.z = mine.vel[2]
    this.move.grounded = mine.grounded
    this.move.stance = mine.stance
    if (mine.stanceT !== undefined) this.move.stanceT = mine.stanceT
    if (mine.stanceCd !== undefined) this.move.stanceCooldown = mine.stanceCd
    if (mine.proneBits !== undefined) {
      this.move.proneActive = (mine.proneBits & 1) !== 0
      this.move.proneHeld = (mine.proneBits & 2) !== 0
    }
    this.move.noclip = mine.noclip ?? false
    for (const cmd of this.pending) this.applyInput(cmd)
    this.currPos.set(this.move.pos.x, this.move.pos.y, this.move.pos.z)

    // Fold the correction into a decaying visual offset (large errors snap).
    this.corr.x += beforeX - this.move.pos.x
    this.corr.y += beforeY - this.move.pos.y
    this.corr.z += beforeZ - this.move.pos.z
    if (this.corr.length() > 1.5) this.corr.setAll(0)
  }

  /** Per-frame: camera follows interpolated predicted position. */
  frameUpdate(alpha: number, dt: number): void {
    const x = this.prevPos.x + (this.currPos.x - this.prevPos.x) * alpha
    const y = this.prevPos.y + (this.currPos.y - this.prevPos.y) * alpha
    const z = this.prevPos.z + (this.currPos.z - this.prevPos.z) * alpha
    const decay = Math.exp(-dt * 12)
    this.corr.scaleInPlace(decay)
    this.stepOffset *= Math.exp(-dt * 14)
    this.renderPos.set(x + this.corr.x, y + this.corr.y + this.stepOffset, z + this.corr.z)
    const targetEye = eyeOffsetFor(this.move.stance)
    this.eyeSmooth += (targetEye - this.eyeSmooth) * Math.min(1, dt * 9)
    this.camera.position.set(this.renderPos.x, this.renderPos.y + this.eyeSmooth, this.renderPos.z)
    this.camera.rotation.set(-this.input.pitch, this.input.yaw, 0)
  }

  get viewYaw(): number {
    return this.input.yaw
  }

  get viewPitch(): number {
    return this.input.pitch
  }

  get eye(): Vector3 {
    return this.camera.position
  }

  viewDir(out: { x: number; y: number; z: number }): void {
    const cp = Math.cos(this.input.pitch)
    out.x = Math.sin(this.input.yaw) * cp
    out.y = Math.sin(this.input.pitch)
    out.z = Math.cos(this.input.yaw) * cp
  }
}
