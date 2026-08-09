import type {
  ClientCraft,
  ClientInvMove,
  ClientPlace,
  ClientUse,
  ServerActionResult,
} from '@hobo/protocol'
import { DEFAULT_MOVEMENT } from '@hobo/gameplay'
import { asEntityId, qfromYaw, quat, v3dist, vec3 } from '@hobo/shared'
import type { GameWorld } from './gameWorld.js'
import { eyePosition, type PlayerSession } from './playerSession.js'

/**
 * Server-side validation + execution of explicit player actions. Every
 * request from the wire is treated as hostile: range, ownership, zone rules
 * and inventory contents are all checked against authoritative state.
 */

const USE_RANGE = 4
const _eye = vec3()

export type ActionOutcome = ServerActionResult

function result(action: ServerActionResult['action'], ok: boolean, error?: string): ActionOutcome {
  return { t: 'result', action, ok, ...(error !== undefined ? { error } : {}) }
}

/** Gathering from resource nodes (and future entity interactions). */
export function handleUse(
  session: PlayerSession,
  world: GameWorld,
  msg: ClientUse,
): { outcome: ActionOutcome; despawned: boolean; targetChanged: boolean } {
  const entity = world.entities.get(asEntityId(msg.target))
  if (!entity?.resource) {
    return { outcome: result('use', false, 'no_target'), despawned: false, targetChanged: false }
  }
  eyePosition(session, DEFAULT_MOVEMENT.eyeOffset, _eye)
  if (v3dist(_eye, entity.transform.pos) > USE_RANGE) {
    return { outcome: result('use', false, 'out_of_range'), despawned: false, targetChanged: false }
  }
  const res = entity.resource
  const take = Math.min(res.perUse, res.remaining)
  const leftover = session.inventory.add(res.itemId, take)
  const gathered = take - leftover
  if (gathered <= 0) {
    return {
      outcome: result('use', false, 'inventory_full'),
      despawned: false,
      targetChanged: false,
    }
  }
  res.remaining -= gathered
  entity.dirty = true
  session.dirty = true
  if (res.remaining <= 0) {
    world.despawn(entity.id)
    return { outcome: result('use', true), despawned: true, targetChanged: false }
  }
  return { outcome: result('use', true), despawned: false, targetChanged: true }
}

export function handleCraft(
  session: PlayerSession,
  world: GameWorld,
  msg: ClientCraft,
  tick: number,
  tickRate: number,
): ActionOutcome {
  const ctx = { nearbyWorkstations: nearbyWorkstationKinds(session, world) }
  const started = session.craftQueue.start(
    world.content,
    session.inventory,
    msg.recipe,
    ctx,
    tick,
    tickRate,
  )
  if (!started.ok) return result('craft', false, started.error)
  session.dirty = true
  return result('craft', true)
}

export function nearbyWorkstationKinds(
  session: PlayerSession,
  world: GameWorld,
): ReadonlySet<string> {
  const kinds = new Set<string>()
  for (const entity of world.entities.ofKind('prop')) {
    if (!entity.prop) continue
    const def = world.content.item(entity.prop.defId)
    if (!def?.workstation) continue
    if (v3dist(entity.transform.pos, session.move.pos) <= def.workstation.range) {
      kinds.add(def.workstation.kind)
    }
  }
  return kinds
}

export function handlePlace(
  session: PlayerSession,
  world: GameWorld,
  msg: ClientPlace,
): { outcome: ActionOutcome; placedId: string | null } {
  const stack = session.inventory.get(msg.slot)
  if (!stack) return { outcome: result('place', false, 'empty_slot'), placedId: null }
  const def = world.content.item(stack.defId)
  if (!def?.placeable || !def.world) {
    return { outcome: result('place', false, 'not_placeable'), placedId: null }
  }
  const pos = vec3(msg.pos[0], msg.pos[1], msg.pos[2])
  eyePosition(session, DEFAULT_MOVEMENT.eyeOffset, _eye)
  if (v3dist(_eye, pos) > def.placeable.maxRange + 0.75) {
    return { outcome: result('place', false, 'out_of_range'), placedId: null }
  }
  if (!world.zones.rulesAt(pos).build) {
    return { outcome: result('place', false, 'zone_forbids_build'), placedId: null }
  }
  const removed = session.inventory.removeFromSlot(msg.slot, 1)
  if (!removed) return { outcome: result('place', false, 'empty_slot'), placedId: null }
  const entity = world.spawnProp({
    defId: stack.defId,
    pos,
    rot: qfromYaw(quat(), msg.yaw),
    motion: 'dynamic',
    owner: session.playerId,
  })
  session.dirty = true
  return { outcome: result('place', true), placedId: entity.id }
}

export function handleInvMove(session: PlayerSession, msg: ClientInvMove): ActionOutcome {
  const moved = session.inventory.move(msg.from, msg.to, msg.count)
  if (!moved.ok) return result('inv_move', false, moved.error)
  session.dirty = true
  return result('inv_move', true)
}
