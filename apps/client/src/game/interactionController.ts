import { CollisionLayer, type PhysicsWorld } from '@hobo/physics'
import { v3addScaled, vec3 } from '@hobo/shared'
import type { ContentRegistry } from '@hobo/content'
import type { Connection } from '../net/connection.js'
import type { EntityView } from '../render/entityView.js'
import type { ClientState } from '../state/clientState.js'
import type { InputAction } from '../input/inputTracker.js'
import type { LocalPlayer } from './localPlayer.js'

/**
 * Turns raw input into protocol intents based on the EQUIPPED TOOL — the
 * client-side half of the tool system. Client rays exist only for UX
 * (prompts, target picking); the server re-validates everything.
 *
 * Primary fire by equipped tool:
 *   physgun — hold to grab, wheel push/pull, R+mouse rotate, F freeze
 *   axe/pickaxe — swing at the aimed resource node
 *   bare hands — gather hand-gatherable nodes (same as E)
 *
 * Building = craft pieces, place them, position with the physgun, freeze.
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
  /** Cosmetic hook: a swing was sent (viewmodel + body animation). */
  onSwing: (() => void) | null = null
  private lastSwingMs = 0
  private pendingRotate = { dyaw: 0, dpitch: 0 }

  constructor(
    private readonly physics: PhysicsWorld,
    private readonly player: LocalPlayer,
    private readonly view: EntityView,
    private readonly state: ClientState,
    private readonly content: ContentRegistry,
    private readonly connection: Connection,
  ) {}

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
      case 'use': {
        const target = this.aim()
        if (target?.kind === 'resource') {
          this.connection.send({ t: 'use', target: target.entityId })
        }
        break
      }
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
          this.physgunActive = false
        }
        break
      }
      case 'freeze':
        if (tool === 'physgun' && this.physgunActive) {
          this.connection.send({ t: 'physgun', a: 'freeze' })
          this.physgunActive = false
        }
        break
      case 'secondary': {
        // Q: unfreeze the aimed frozen prop (physgun equipped).
        if (tool === 'physgun') {
          const target = this.aim()
          if (target?.kind === 'prop' && target.frozen) {
            this.connection.send({ t: 'physgun', a: 'unfreeze', target: target.entityId })
          }
        }
        break
      }
      case 'rotate_held':
        // Coalesced: high-frequency mouse deltas must not become one wire
        // message each (rate limiter would kill the connection).
        this.pendingRotate.dyaw += action.dyaw
        this.pendingRotate.dpitch += action.dpitch
        break
      case 'place':
        this.tryPlace()
        break
      default:
        break
    }
  }

  /** Called once per fixed tick: flush coalesced rotation intent. */
  flushTick(): void {
    const { dyaw, dpitch } = this.pendingRotate
    if (this.physgunActive && (dyaw !== 0 || dpitch !== 0)) {
      this.connection.send({
        t: 'physgun',
        a: 'rotate',
        dyaw: clampRot(dyaw),
        dpitch: clampRot(dpitch),
      })
    }
    this.pendingRotate.dyaw = 0
    this.pendingRotate.dpitch = 0
  }

  onWheel(delta: number): void {
    if (this.physgunActive) {
      this.connection.send({ t: 'physgun', a: 'adjust', dist: -delta * 0.5 })
    }
  }

  onHotbarChanged(): void {
    if (this.physgunActive && this.equippedToolKind() !== 'physgun') {
      this.physgunActive = false
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

  private tryPlace(): void {
    const slot = this.state.activeHotbar
    const stack = this.state.inventory?.slots.find((s) => s.i === slot)
    if (!stack) return
    const def = this.content.item(stack.stack.def)
    if (!def?.placeable || !def.world) return

    _eye.x = this.player.eye.x
    _eye.y = this.player.eye.y
    _eye.z = this.player.eye.z
    this.player.viewDir(_dir)
    v3addScaled(_to, _eye, _dir, def.placeable.maxRange)
    const hit = this.physics.raycast(_eye, _to, CollisionLayer.Static | CollisionLayer.Prop)

    const shape = def.world.shape
    const halfHeight =
      shape.type === 'box'
        ? shape.size[1] / 2
        : shape.type === 'cylinder'
          ? shape.height / 2
          : shape.radius
    let px: number
    let py: number
    let pz: number
    if (hit) {
      px = hit.point.x + hit.normal.x * halfHeight
      py = hit.point.y + hit.normal.y * (halfHeight + 0.02)
      pz = hit.point.z + hit.normal.z * halfHeight
    } else {
      px = _to.x
      py = Math.max(_to.y, halfHeight + 0.02)
      pz = _to.z
    }
    // Face the placed object toward the player.
    let yaw = Math.atan2(_eye.x - px, _eye.z - pz) + Math.PI
    const snap = def.placeable.snapStep
    if (snap > 0) {
      px = Math.round(px / snap) * snap
      pz = Math.round(pz / snap) * snap
      yaw = Math.round(yaw / (Math.PI / 2)) * (Math.PI / 2)
    }
    this.connection.send({ t: 'place', slot, pos: [px, py, pz], yaw })
  }
}

function clampRot(v: number): number {
  return Math.max(-1, Math.min(1, v))
}
