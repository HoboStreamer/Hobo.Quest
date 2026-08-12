import { CollisionLayer, type PhysicsWorld } from '@hobo/physics'
import type { ClientConstraint } from '@hobo/protocol'
import { v3addScaled, vec3 } from '@hobo/shared'
import { WATER_LEVEL, terrainHeight, type ContentRegistry } from '@hobo/content'
import type { Connection } from '../net/connection.js'
import type { EntityView } from '../render/entityView.js'
import type { ClientState } from '../state/clientState.js'
import type { InputAction, InputTracker } from '../input/inputTracker.js'
import type { LocalPlayer } from './localPlayer.js'
import { physgunGridSize, physgunSnapDeg } from '../weapons/physgunModule.js'
import {
  riggingHingeLimitDeg,
  riggingKind,
  riggingMotorSpeed,
  riggingRopeSlack,
  riggingSliderTravel,
  riggingSpringStiffness,
} from '../weapons/riggingModule.js'
import type { WeaponSettings } from '../weapons/registry.js'

/**
 * Turns raw input into protocol intents based on the EQUIPPED TOOL — the
 * client-side half of the tool system. Client rays exist only for UX
 * (prompts, target picking); the server re-validates everything.
 *
 * Physgun (GMod scheme):
 *   hold LMB — grab (grabbing a frozen prop unfreezes it) · release — let go
 *   RMB — freeze in place · wheel — push/pull
 *   hold E — rotate like a globe (Shift+E snaps to 15°)
 *   hold Shift — grid-lock the carried prop's position
 * Everything else:
 *   LMB — swing tool / gather · E — gather / pick up props · G — drop item
 */

const AIM_RANGE = 8
/** Physgun beam reach (matches server PHYSGUN_MAX_RANGE). */
const BEAM_RANGE = 25
const SWING_COOLDOWN_MS = 350
const _eye = vec3()
const _dir = vec3()
const _to = vec3()

export interface AimTarget {
  entityId: string
  kind: 'prop' | 'resource' | 'player'
  def: string | undefined
  frozen: boolean
  point: { x: number; y: number; z: number }
  /** Surface normal at the hit (rigging tool takes joint axes from it). */
  normal: { x: number; y: number; z: number }
}

/** First endpoint picked with the rigging tool (awaiting the second). */
export interface RiggingPick {
  entityId: string
  point: { x: number; y: number; z: number }
}

export class InteractionController {
  physgunActive = false
  /** Hold-E rotate mode while carrying (mouse steers the prop, not the view). */
  rotating = false
  /** Cosmetic hook: a swing was sent (viewmodel + body animation). */
  onSwing: (() => void) | null = null
  /** True when the last 'use' this client sent targeted another player. */
  lastTargetWasPlayer = false
  /** Hook: player pressed E on a trading post. */
  onShopOpen: (() => void) | null = null
  /** Rigging tool: first selected endpoint (highlight + prompt read this). */
  riggingFirst: RiggingPick | null = null
  /** Ghost preview pose supplier (wired by main; null = no valid ghost). */
  placementPose: (() => { x: number; y: number; z: number; yaw: number } | null) | null = null
  /** Wheel rotates the placement ghost while a placeable is equipped. */
  onPlacementRotate: ((delta: number) => void) | null = null

  private lastSwingMs = 0
  private pendingRotate = { dyaw: 0, dpitch: 0 }
  private gridOn = false

  constructor(
    private readonly physics: PhysicsWorld,
    private readonly player: LocalPlayer,
    private readonly view: EntityView,
    private readonly state: ClientState,
    private readonly content: ContentRegistry,
    private readonly connection: Connection,
    private readonly input: InputTracker,
    private readonly weaponSettings: WeaponSettings,
  ) {
    input.captureLook = () => this.rotating && this.physgunActive
  }

  equippedToolKind(): 'physgun' | 'axe' | 'pickaxe' | 'rigging' | null {
    const defId = this.state.activeItemDef()
    if (!defId) return null
    return this.content.item(defId)?.tool?.kind ?? null
  }

  /** What the crosshair points at right now (client-side, UX only). */
  aim(): AimTarget | null {
    _eye.x = this.player.eye.x
    _eye.y = this.player.eye.y
    _eye.z = this.player.eye.z
    this.player.viewDir(_dir)
    v3addScaled(_to, _eye, _dir, AIM_RANGE)
    const hit = this.physics.raycast(_eye, _to, CollisionLayer.Prop | CollisionLayer.Player)
    if (!hit) return null
    const entityId = this.view.entityIdForBody(hit.bodyId)
    if (!entityId) return null
    const entity = this.state.entities.get(entityId)
    if (
      !entity ||
      (entity.kind !== 'prop' && entity.kind !== 'resource' && entity.kind !== 'player')
    )
      return null
    return {
      entityId,
      kind: entity.kind,
      def: entity.def,
      frozen: entity.motion === 'frozen',
      point: hit.point,
      normal: hit.normal,
    }
  }

  /**
   * Where the beam visually ends right now: first surface (world or prop)
   * under the crosshair, else max range. The beam always fires — hitting
   * nothing is not an error, it just shines (GMod).
   */
  beamTarget(out: { x: number; y: number; z: number }): void {
    _eye.x = this.player.eye.x
    _eye.y = this.player.eye.y
    _eye.z = this.player.eye.z
    this.player.viewDir(_dir)
    v3addScaled(_to, _eye, _dir, BEAM_RANGE)
    const hit = this.physics.raycast(_eye, _to, CollisionLayer.Static | CollisionLayer.Prop)
    const p = hit ? hit.point : _to
    out.x = p.x
    out.y = p.y
    out.z = p.z
  }

  handle(action: InputAction): void {
    const tool = this.equippedToolKind()
    switch (action.kind) {
      case 'primary_down': {
        if (tool === 'physgun') {
          this.connection.send({ t: 'physgun', a: 'grab' })
          this.physgunActive = true
          break
        }
        if (tool === 'rigging') {
          this.riggingPick()
          break
        }
        // Placement: LMB with a placeable equipped places at the ghost.
        const defId = this.state.activeItemDef()
        const itemDef = defId ? this.content.item(defId) : undefined
        if (itemDef?.placeable && itemDef.world) {
          const pose = this.placementPose?.()
          if (pose) {
            this.connection.send({
              t: 'place',
              slot: this.state.activeHotbar,
              pos: [pose.x, pose.y, pose.z],
              yaw: pose.yaw,
            })
            this.onSwing?.()
          }
          break
        }
        // Eating: primary fire with food equipped consumes it.
        if (defId && this.content.item(defId)?.food) {
          this.connection.send({ t: 'consume', slot: this.state.activeHotbar })
          this.onSwing?.()
          break
        }
        this.swing()
        break
      }
      case 'primary_up': {
        if (this.physgunActive) {
          this.connection.send({ t: 'physgun', a: 'release' })
          this.endCarry()
        }
        break
      }
      case 'rmb_down': {
        if (this.physgunActive) {
          this.connection.send({ t: 'physgun', a: 'freeze' })
          this.endCarry()
          break
        }
        if (tool === 'rigging') {
          // Cut: remove every constraint on the aimed prop. A pending first
          // pick is cancelled instead.
          if (this.riggingFirst) {
            this.riggingFirst = null
            break
          }
          const target = this.aim()
          if (target?.kind === 'prop') {
            this.connection.send({ t: 'constraint_remove', target: target.entityId })
          }
        }
        break
      }
      case 'use_down': {
        if (this.physgunActive) {
          this.rotating = true
          break
        }
        const target = this.aim()
        if (!target) {
          if (this.standingInWater()) this.connection.send({ t: 'drink' })
          break
        }
        this.lastTargetWasPlayer = target.kind === 'player'
        if (target.def && this.content.item(target.def)?.shop) {
          this.onShopOpen?.()
          break
        }
        // Containers open on E instead of being picked up.
        if (target.def && this.content.item(target.def)?.container) {
          this.connection.send({ t: 'container_open', target: target.entityId })
          break
        }
        this.connection.send({ t: 'use', target: target.entityId })
        break
      }
      case 'use_up':
        this.rotating = false
        break
      case 'drop': {
        const slot = this.state.activeHotbar
        const stack = this.state.inventory?.slots.find((s) => s.i === slot)
        if (stack) this.connection.send({ t: 'drop', slot, count: 1 })
        break
      }
      case 'rotate_held':
        // Coalesced: high-frequency mouse deltas must not become one wire
        // message each (rate limiter would kill the connection). Negated:
        // the prop rolls like a globe under the cursor (drag right = prop
        // turns left toward you), which is how GMod's rotate feels.
        this.pendingRotate.dyaw -= action.dyaw
        this.pendingRotate.dpitch -= action.dpitch
        break
      default:
        break
    }
  }

  private endCarry(): void {
    this.physgunActive = false
    this.rotating = false
    this.gridOn = false
  }

  /** Called once per fixed tick: flush coalesced rotate + grid-lock state. */
  flushTick(): void {
    const { dyaw, dpitch } = this.pendingRotate
    // Send every tick while rotating (even zero deltas): the snap flag must
    // reach the server the moment Shift goes down, not on the next drag.
    if (this.physgunActive && this.rotating) {
      this.connection.send({
        t: 'physgun',
        a: 'rotate',
        dyaw: clampRot(dyaw),
        dpitch: clampRot(dpitch),
        snap: this.input.shiftHeld,
        snapStep: (physgunSnapDeg(this.weaponSettings) * Math.PI) / 180,
      })
    }
    this.pendingRotate.dyaw = 0
    this.pendingRotate.dpitch = 0

    // Shift (outside rotate mode) grid-locks the carried prop.
    const wantGrid = this.physgunActive && !this.rotating && this.input.shiftHeld
    if (wantGrid !== this.gridOn) {
      this.gridOn = wantGrid
      this.connection.send({
        t: 'physgun',
        a: 'grid',
        on: wantGrid,
        size: physgunGridSize(this.weaponSettings),
      })
    }
  }

  onWheel(delta: number): void {
    if (this.physgunActive) {
      this.connection.send({ t: 'physgun', a: 'adjust', dist: -delta * 0.5 })
      return
    }
    const defId = this.state.activeItemDef()
    const def = defId ? this.content.item(defId) : undefined
    if (def?.placeable && def.world) {
      this.onPlacementRotate?.(delta * (Math.PI / 12))
    }
  }

  onHotbarChanged(): void {
    if (this.physgunActive && this.equippedToolKind() !== 'physgun') {
      this.endCarry()
    }
    if (this.equippedToolKind() !== 'rigging') this.riggingFirst = null
  }

  /**
   * Rigging tool LMB: first click marks an endpoint, second click sends the
   * constraint request built from the equipment-panel settings. The server
   * re-validates everything (points, ownership, skill, materials, zone).
   */
  private riggingPick(): void {
    this.onSwing?.()
    const target = this.aim()
    if (target?.kind !== 'prop') return
    if (!this.riggingFirst) {
      this.riggingFirst = { entityId: target.entityId, point: target.point }
      return
    }
    const first = this.riggingFirst
    this.riggingFirst = null
    if (first.entityId === target.entityId) return
    const kind = riggingKind(this.weaponSettings)
    const pointA: [number, number, number] = [first.point.x, first.point.y, first.point.z]
    const pointB: [number, number, number] = [target.point.x, target.point.y, target.point.z]
    const msg: ClientConstraint = {
      t: 'constraint',
      kind,
      a: first.entityId,
      b: target.entityId,
      pointA,
      pointB,
    }
    if (kind === 'hinge' || kind === 'axis' || kind === 'slider' || kind === 'motor') {
      // The joint axis comes from the second surface clicked (its normal);
      // clicking the top of a plank hinges it flat, clicking the side
      // hinges it like a door.
      const n = target.normal
      msg.axis = [n.x, n.y, n.z]
    }
    if (kind === 'rope') {
      const gap = Math.hypot(pointB[0] - pointA[0], pointB[1] - pointA[1], pointB[2] - pointA[2])
      msg.length = Math.max(0.3, gap * (1 + riggingRopeSlack(this.weaponSettings)))
    }
    if (kind === 'hinge') {
      const deg = riggingHingeLimitDeg(this.weaponSettings)
      if (deg > 0) {
        const rad = (deg * Math.PI) / 180
        msg.limits = { min: -rad, max: rad }
      }
    }
    if (kind === 'slider') {
      const travel = riggingSliderTravel(this.weaponSettings)
      if (travel > 0) msg.limits = { min: -travel, max: travel }
    }
    if (kind === 'spring') {
      msg.stiffness = riggingSpringStiffness(this.weaponSettings)
      msg.damping = 15
    }
    if (kind === 'motor') {
      msg.motorVel = riggingMotorSpeed(this.weaponSettings)
      msg.motorForce = 500
    }
    this.connection.send(msg)
  }

  private swing(): void {
    const now = performance.now()
    if (now - this.lastSwingMs < SWING_COOLDOWN_MS) return
    this.lastSwingMs = now
    // The swing always animates (punching air is allowed); it DOES
    // something when a resource, player or damageable prop is under the
    // crosshair. Resources gather (use); the rest is an attack.
    this.onSwing?.()
    const target = this.aim()
    if (!target) return
    if (target.kind === 'resource') {
      this.lastTargetWasPlayer = false
      this.connection.send({ t: 'use', target: target.entityId })
      return
    }
    if (target.kind === 'player') {
      this.lastTargetWasPlayer = true
      this.connection.send({ t: 'attack', target: target.entityId })
      return
    }
    // Props: only structures with a health capability are attackable.
    if (target.def && this.content.item(target.def)?.health) {
      this.lastTargetWasPlayer = false
      this.connection.send({ t: 'attack', target: target.entityId })
    }
  }

  /** Standing in water (thirst refill by drinking). */
  standingInWater(): boolean {
    return (
      terrainHeight(this.content.world, this.player.move.pos.x, this.player.move.pos.z) <
      WATER_LEVEL - 0.03
    )
  }
}

function clampRot(v: number): number {
  return Math.max(-1, Math.min(1, v))
}
