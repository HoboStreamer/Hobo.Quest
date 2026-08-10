import type {
  ClientCraft,
  ClientDrop,
  ClientInvMove,
  ClientUse,
  ClientWeld,
  ServerActionResult,
} from '@hobo/protocol'
import type { GameEntity, LevelUp } from '@hobo/gameplay'
import type { ItemDef } from '@hobo/content'
import { CollisionLayer } from '@hobo/physics'
import { asEntityId, qfromYaw, quat, v3dist, vec3 } from '@hobo/shared'
import { viewDirection } from './playerSession.js'
import type { GameWorld } from './gameWorld.js'
import { eyePosition, type PlayerSession } from './playerSession.js'

/**
 * Server-side validation + execution of explicit player actions. Every
 * request from the wire is treated as hostile: range, tools, zone rules
 * and inventory contents are all checked against authoritative state.
 */

const HAND_USE_RANGE = 3.5
const WELD_MAX_GAP = 3.5
const _eye = vec3()

export type ActionOutcome = ServerActionResult

function result(action: ServerActionResult['action'], ok: boolean, error?: string): ActionOutcome {
  return { t: 'result', action, ok, ...(error !== undefined ? { error } : {}) }
}

/** The tool capability of the session's active hotbar item, if any. */
export function equippedTool(session: PlayerSession): NonNullable<ItemDef['tool']> | undefined {
  if (session.holstered) return undefined
  const stack = session.inventory.get(session.activeHotbar)
  if (!stack) return undefined
  return session.content.item(stack.defId)?.tool
}

export interface GatherResult {
  outcome: ActionOutcome
  /** Entity whose remaining count changed (for replication), if any. */
  changed: GameEntity | null
  /** Entity picked up and removed from the world, if any. */
  pickedUp: GameEntity | null
  levelUps: LevelUp[]
  xpChanged: boolean
}

/**
 * Gathering: E-use for hand nodes, tool swings for gated nodes. The node
 * type (content) decides tool requirements, yield, XP and respawn.
 */
export function handleUse(
  session: PlayerSession,
  world: GameWorld,
  msg: ClientUse,
  nowMs: number,
  canManipulate: (entity: GameEntity) => boolean,
): GatherResult {
  const none = { changed: null, pickedUp: null, levelUps: [], xpChanged: false }
  const entity = world.entities.get(asEntityId(msg.target))

  // Props carry their own item: E picks them back up into the inventory.
  if (entity?.prop) {
    eyePosition(session, _eye)
    if (v3dist(_eye, entity.transform.pos) > HAND_USE_RANGE + 0.5) {
      return { outcome: result('use', false, 'out_of_range'), ...none }
    }
    if (!canManipulate(entity)) {
      return { outcome: result('use', false, 'not_owner'), ...none }
    }
    const count = Math.max(1, entity.prop.lootCount)
    if (!session.inventory.canFit(entity.prop.defId, count)) {
      return { outcome: result('use', false, 'inventory_full'), ...none }
    }
    session.inventory.add(entity.prop.defId, count)
    session.dirty = true
    const picked = entity
    world.despawn(entity.id)
    return { outcome: result('use', true), ...none, pickedUp: picked }
  }

  if (!entity?.resource) return { outcome: result('use', false, 'no_target'), ...none }
  const nodeType = world.content.nodeType(entity.resource.nodeTypeId)
  if (!nodeType) return { outcome: result('use', false, 'no_target'), ...none }

  const tool = equippedTool(session)
  const usingMatchingTool = tool !== undefined && tool.kind === nodeType.requiredTool
  if (nodeType.requiredTool && !usingMatchingTool) {
    return { outcome: result('use', false, `requires_${nodeType.requiredTool}`), ...none }
  }

  eyePosition(session, _eye)
  const range = usingMatchingTool ? (tool?.range ?? HAND_USE_RANGE) : HAND_USE_RANGE
  if (v3dist(_eye, entity.transform.pos) > range + nodeType.bodyOffsetY + 1) {
    return { outcome: result('use', false, 'out_of_range'), ...none }
  }

  const res = entity.resource
  if (res.remaining <= 0) {
    return { outcome: result('use', false, 'depleted'), ...none }
  }

  const yieldPerUse = nodeType.perUse * (usingMatchingTool ? (tool?.power ?? 1) : 1)
  const take = Math.min(yieldPerUse, res.remaining)
  const leftover = session.inventory.add(nodeType.item, take)
  const gathered = take - leftover
  if (gathered <= 0) {
    return { outcome: result('use', false, 'inventory_full'), ...none }
  }

  res.remaining -= gathered
  if (res.remaining <= 0) {
    res.remaining = 0
    res.depletedUntil = nowMs + nodeType.respawnSeconds * 1000
  }
  entity.dirty = true
  session.dirty = true
  const levelUps = session.skills.addXp(nodeType.skill, nodeType.xpPerGather)
  return {
    outcome: result('use', true),
    changed: entity,
    pickedUp: null,
    levelUps,
    xpChanged: nodeType.xpPerGather > 0,
  }
}

export function handleCraft(
  session: PlayerSession,
  world: GameWorld,
  msg: ClientCraft,
  tick: number,
  tickRate: number,
): ActionOutcome {
  const ctx = {
    nearbyWorkstations: nearbyWorkstationKinds(session, world),
    skillLevel: (id: string) => session.skills.levelOf(id),
  }
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

/**
 * Dropping IS placement: the stack leaves the inventory and becomes a
 * physical prop tossed gently in front of the player, ready for physgun
 * positioning. One prop carries the whole dropped count as loot.
 */
const _dropDir = vec3()

export function handleDrop(
  session: PlayerSession,
  world: GameWorld,
  msg: ClientDrop,
): { outcome: ActionOutcome; droppedId: string | null } {
  const stack = session.inventory.get(msg.slot)
  if (!stack) return { outcome: result('drop', false, 'empty_slot'), droppedId: null }
  const removed = session.inventory.removeFromSlot(msg.slot, msg.count)
  if (!removed) return { outcome: result('drop', false, 'empty_slot'), droppedId: null }

  eyePosition(session, _eye)
  viewDirection(session, _dropDir)
  // Clearance check: dropping against a wall or another prop must not spawn
  // the item INSIDE it (interpenetrated bodies sleep overlapped and never
  // separate). Pull the spawn point back to just in front of the first hit.
  let dropDist = 1.1
  const _probe = vec3(
    _eye.x + _dropDir.x * dropDist,
    _eye.y + _dropDir.y * dropDist - 0.15,
    _eye.z + _dropDir.z * dropDist,
  )
  const blocked = world.physics.raycast(_eye, _probe, CollisionLayer.Static | CollisionLayer.Prop)
  if (blocked) dropDist = Math.max(0.35, dropDist * blocked.fraction - 0.3)
  const spawnPos = vec3(
    _eye.x + _dropDir.x * dropDist,
    _eye.y + _dropDir.y * dropDist - 0.15,
    _eye.z + _dropDir.z * dropDist,
  )
  const entity = world.spawnProp({
    defId: removed.defId,
    pos: spawnPos,
    rot: qfromYaw(quat(), session.yaw),
    motion: 'dynamic',
    owner: session.playerId,
    lootCount: removed.count,
    velocity: vec3(_dropDir.x * 2.5, 1.2, _dropDir.z * 2.5),
  })
  session.dirty = true
  return { outcome: result('drop', true), droppedId: entity.id }
}

export interface WeldOutcome {
  outcome: ActionOutcome
  welded: { a: GameEntity; b: GameEntity } | null
}

/** Weld two props (constraint tools — no player-facing trigger yet). */
export function handleWeld(
  session: PlayerSession,
  world: GameWorld,
  msg: ClientWeld,
  canManipulate: (entity: GameEntity) => boolean,
): WeldOutcome {
  const tool = equippedTool(session)
  if (tool?.kind !== 'hammer')
    return { outcome: result('weld', false, 'requires_hammer'), welded: null }
  if (msg.a === msg.b) return { outcome: result('weld', false, 'same_target'), welded: null }
  const a = world.entities.get(asEntityId(msg.a))
  const b = world.entities.get(asEntityId(msg.b))
  if (!a?.prop || !b?.prop) return { outcome: result('weld', false, 'no_target'), welded: null }
  if (!canManipulate(a) || !canManipulate(b)) {
    return { outcome: result('weld', false, 'not_owner'), welded: null }
  }

  eyePosition(session, _eye)
  const reach = tool.range + 1.5
  if (v3dist(_eye, a.transform.pos) > reach || v3dist(_eye, b.transform.pos) > reach) {
    return { outcome: result('weld', false, 'out_of_range'), welded: null }
  }
  if (v3dist(a.transform.pos, b.transform.pos) > WELD_MAX_GAP) {
    return { outcome: result('weld', false, 'too_far_apart'), welded: null }
  }
  if (!world.zones.rulesAt(a.transform.pos).build) {
    return { outcome: result('weld', false, 'zone_forbids_build'), welded: null }
  }
  if (world.hasWeld(a.id, b.id)) {
    return { outcome: result('weld', false, 'already_welded'), welded: null }
  }
  if (world.weldCountFor(a.id) >= 12 || world.weldCountFor(b.id) >= 12) {
    return { outcome: result('weld', false, 'weld_limit'), welded: null }
  }
  const record = world.addWeld(a, b)
  if (!record) return { outcome: result('weld', false, 'no_target'), welded: null }
  session.skills.addXp('construction', 4)
  session.dirty = true
  return { outcome: result('weld', true), welded: { a, b } }
}

export function handleInvMove(session: PlayerSession, msg: ClientInvMove): ActionOutcome {
  const moved = session.inventory.move(msg.from, msg.to, msg.count)
  if (!moved.ok) return result('inv_move', false, moved.error)
  session.dirty = true
  return result('inv_move', true)
}
