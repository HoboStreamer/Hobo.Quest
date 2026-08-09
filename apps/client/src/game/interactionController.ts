import { CollisionLayer, type PhysicsWorld } from '@hobo/physics'
import { v3addScaled, vec3 } from '@hobo/shared'
import type { ContentRegistry } from '@hobo/content'
import type { Connection } from '../net/connection.js'
import type { EntityView } from '../render/entityView.js'
import type { ClientState } from '../state/clientState.js'
import type { InputAction } from '../input/inputTracker.js'
import type { LocalPlayer } from './localPlayer.js'

/**
 * Turns raw input actions into protocol intents, using client-side rays
 * only for UX (what is under the crosshair) — every action is re-validated
 * by the server against its own authoritative state.
 */

const AIM_RANGE = 8
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

  constructor(
    private readonly physics: PhysicsWorld,
    private readonly player: LocalPlayer,
    private readonly view: EntityView,
    private readonly state: ClientState,
    private readonly content: ContentRegistry,
    private readonly connection: Connection,
  ) {}

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
    switch (action.kind) {
      case 'use': {
        const target = this.aim()
        if (target?.kind === 'resource') {
          this.connection.send({ t: 'use', target: target.entityId })
        }
        break
      }
      case 'primary_down': {
        this.connection.send({ t: 'physgun', a: 'grab' })
        this.physgunActive = true
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
        this.connection.send({ t: 'physgun', a: 'freeze' })
        this.physgunActive = false
        break
      case 'unfreeze': {
        const target = this.aim()
        if (target?.kind === 'prop' && target.frozen) {
          this.connection.send({ t: 'physgun', a: 'unfreeze', target: target.entityId })
        }
        break
      }
      case 'rotate_held':
        this.connection.send({
          t: 'physgun',
          a: 'rotate',
          dyaw: clampRot(action.dyaw),
          dpitch: clampRot(action.dpitch),
        })
        break
      case 'place':
        this.tryPlace()
        break
      default:
        break
    }
  }

  onWheel(delta: number): void {
    if (this.physgunActive) {
      this.connection.send({ t: 'physgun', a: 'adjust', dist: -delta * 0.5 })
    }
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
