import type {
  ClientCraft,
  ClientInvMove,
  ClientPlace,
  ClientUse,
  ClientWeld,
  ServerActionResult,
} from '@hobo/protocol'
import { DEFAULT_MOVEMENT, type GameEntity, type LevelUp } from '@hobo/gameplay'
import type { ItemDef } from '@hobo/content'
import { asEntityId, qfromYaw, quat, v3dist, vec3 } from '@hobo/shared'
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
  const stack = session.inventory.get(session.activeHotbar)
  if (!stack) return undefined
  return session.content.item(stack.defId)?.tool
}

export interface GatherResult {
  outcome: ActionOutcome
  /** Entity whose remaining count changed (for replication), if any. */
  changed: GameEntity | null
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
): GatherResult {
  const none = { changed: null, levelUps: [], xpChanged: false }
  const entity = world.entities.get(asEntityId(msg.target))
  if (!entity?.resource) return { outcome: result('use', false, 'no_target'), ...none }
  const nodeType = world.content.nodeType(entity.resource.nodeTypeId)
  if (!nodeType) return { outcome: result('use', false, 'no_target'), ...none }

  const tool = equippedTool(session)
  const usingMatchingTool = tool !== undefined && tool.kind === nodeType.requiredTool
  if (nodeType.requiredTool && !usingMatchingTool) {
    return { outcome: result('use', false, `requires_${nodeType.requiredTool}`), ...none }
  }

  eyePosition(session, DEFAULT_MOVEMENT.eyeOffset, _eye)
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

  eyePosition(session, DEFAULT_MOVEMENT.eyeOffset, _eye)
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
