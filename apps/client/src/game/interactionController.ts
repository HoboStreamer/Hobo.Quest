import { CollisionLayer, type PhysicsWorld } from '@hobo/physics'
import { v3addScaled, vec3 } from '@hobo/shared'
import type { ContentRegistry } from '@hobo/content'
import type { Connection } from '../net/connection.js'
import type { EntityView } from '../render/entityView.js'
import type { ClientState } from '../state/clientState.js'
import type { InputAction, InputTracker } from '../input/inputTracker.js'
import type { LocalPlayer } from './localPlayer.js'

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
const SWING_COOLDOWN_MS = 350
const _eye = vec3()
const _dir = vec3()
const _to = vec3()

export interface AimTarget {
  entityId: string
  kind: 'prop' | 'resource'
  def: string | undefined
  frozen: boolean
  point: { x: number; y: number; z: number }
}

export class InteractionController {
  physgunActive = false
  /** Hold-E rotate mode while carrying (mouse steers the prop, not the view). */
  rotating = false
  /** Cosmetic hook: a swing was sent (viewmodel + body animation). */
  onSwing: (() => void) | null = null

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
  ) {
    input.captureLook = () => this.rotating && this.physgunActive
  }

  equippedToolKind(): 'physgun' | 'axe' | 'pickaxe' | 'hammer' | null {
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
    const hit = this.physics.raycast(_eye, _to, CollisionLayer.Prop)
    if (!hit) return null
    const entityId = this.view.entityIdForBody(hit.bodyId)
    if (!entityId) return null
    const entity = this.state.entities.get(entityId)
    if (!entity || (entity.kind !== 'prop' && entity.kind !== 'resource')) return null
    return {
      entityId,
      kind: entity.kind,
      def: entity.def,
      frozen: entity.motion === 'frozen',
      point: hit.point,
    }
  }

  handle(action: InputAction): void {
    const tool = this.equippedToolKind()
    switch (action.kind) {
      case 'primary_down': {
        if (tool === 'physgun') {
          this.connection.send({ t: 'physgun', a: 'grab' })
          this.physgunActive = true
        } else {
          this.swing()
        }
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
        }
        break
      }
      case 'use_down': {
        if (this.physgunActive) {
          this.rotating = true
          break
        }
        const target = this.aim()
        if (target) this.connection.send({ t: 'use', target: target.entityId })
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
        // message each (rate limiter would kill the connection).
        this.pendingRotate.dyaw += action.dyaw
        this.pendingRotate.dpitch += action.dpitch
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
    if (this.physgunActive && this.rotating && (dyaw !== 0 || dpitch !== 0)) {
      this.connection.send({
        t: 'physgun',
        a: 'rotate',
        dyaw: clampRot(dyaw),
        dpitch: clampRot(dpitch),
        snap: this.input.shiftHeld,
      })
    }
    this.pendingRotate.dyaw = 0
    this.pendingRotate.dpitch = 0

    // Shift (outside rotate mode) grid-locks the carried prop.
    const wantGrid = this.physgunActive && !this.rotating && this.input.shiftHeld
    if (wantGrid !== this.gridOn) {
      this.gridOn = wantGrid
      this.connection.send({ t: 'physgun', a: 'grid', on: wantGrid })
    }
  }

  onWheel(delta: number): void {
    if (this.physgunActive) {
      this.connection.send({ t: 'physgun', a: 'adjust', dist: -delta * 0.5 })
    }
  }

  onHotbarChanged(): void {
    if (this.physgunActive && this.equippedToolKind() !== 'physgun') {
      this.endCarry()
    }
  }

  private swing(): void {
    const now = performance.now()
    if (now - this.lastSwingMs < SWING_COOLDOWN_MS) return
    const target = this.aim()
    if (target?.kind !== 'resource') return
    this.lastSwingMs = now
    this.onSwing?.()
    this.connection.send({ t: 'use', target: target.entityId })
  }
}

function clampRot(v: number): number {
  return Math.max(-1, Math.min(1, v))
}
