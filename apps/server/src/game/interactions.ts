import type {
  ClientConstraint,
  ClientCraft,
  ClientDrop,
  ClientInvMove,
  ClientPlace,
  ClientUse,
  ServerActionResult,
} from '@hobo/protocol'
import {
  CONSTRAINT_COST,
  CONSTRAINT_LIMITS,
  CONSTRAINT_SKILL,
  createPlant,
  fertilizePlant,
  harvestPlant,
  isMature,
  updatePlant,
  validateConstraintParams,
  waterPlant,
  type ConstraintParams,
  type GameEntity,
  type LevelUp,
  type PlantContext,
} from '@hobo/gameplay'
import type { ItemDef } from '@hobo/content'
import { CollisionLayer } from '@hobo/physics'
import { asEntityId, qfromYaw, qrotateVecInv, quat, v3dist, vec3, type Vec3 } from '@hobo/shared'
import { viewDirection } from './playerSession.js'
import type { ConstraintRecord, GameWorld } from './gameWorld.js'
import { eyePosition, type PlayerSession } from './playerSession.js'

/**
 * Server-side validation + execution of explicit player actions. Every
 * request from the wire is treated as hostile: range, tools, zone rules
 * and inventory contents are all checked against authoritative state.
 */

const HAND_USE_RANGE = 3.5
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
  /** Entity spawned as a side effect (felled tree trunk), if any. */
  spawned: GameEntity | null
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
  env: PlantContext = { nowMs, raining: false, ambientC: 20 },
): GatherResult {
  const none = { changed: null, pickedUp: null, spawned: null, levelUps: [], xpChanged: false }
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
    const targetDef = world.content.item(entity.prop.defId)
    const held = session.holstered ? null : session.inventory.get(session.activeHotbar)
    const heldDef = held ? world.content.item(held.defId) : undefined

    // Water tanks: a watering can pours in / fills up on E.
    if (targetDef?.waterTank && heldDef?.fluidContainer && held) {
      const tankCap = targetDef.waterTank.capacity
      const canCap = heldDef.fluidContainer.capacity
      const canFluid = Number(held.meta?.fluid ?? 0)
      const tankFluid = entity.prop.waterAmount ?? 0
      if (canFluid > 0 && tankFluid < tankCap) {
        const move = Math.min(canFluid, tankCap - tankFluid)
        entity.prop.waterAmount = tankFluid + move
        held.meta = { ...held.meta, fluid: canFluid - move }
        entity.dirty = true
        session.dirty = true
        return { outcome: result('use', true), ...none, changed: entity }
      }
      if (canFluid < canCap && tankFluid > 0) {
        const move = Math.min(canCap - canFluid, tankFluid)
        entity.prop.waterAmount = tankFluid - move
        held.meta = { ...held.meta, fluid: canFluid + move }
        entity.dirty = true
        session.dirty = true
        return { outcome: result('use', true), ...none, changed: entity }
      }
      return { outcome: result('use', false, 'nothing_to_transfer'), ...none }
    }

    // Planters: water / fertilize / harvest / plant, in that priority.
    if (targetDef?.planter) {
      const plant = entity.prop.plant
      if (plant) {
        const crop = world.content.crop(plant.crop)
        if (!crop) {
          delete entity.prop.plant // content removed the crop: clear the bed
          entity.dirty = true
          return { outcome: result('use', true), ...none, changed: entity }
        }
        updatePlant(plant, crop, env)
        // Watering can on a growing plant.
        if (heldDef?.fluidContainer && held) {
          const fluid = Number(held.meta?.fluid ?? 0)
          if (fluid < 1) return { outcome: result('use', false, 'can_empty'), ...none }
          if (!waterPlant(plant)) {
            return { outcome: result('use', false, 'not_thirsty'), ...none }
          }
          held.meta = { ...held.meta, fluid: fluid - 1 }
          entity.dirty = true
          session.dirty = true
          const levelUps = session.skills.addXp('farming', 1)
          return {
            outcome: result('use', true),
            ...none,
            changed: entity,
            levelUps,
            xpChanged: true,
          }
        }
        // Fertilizer.
        if (heldDef?.fertilizer && held) {
          if (!fertilizePlant(plant, heldDef.fertilizer.boost)) {
            return { outcome: result('use', false, 'already_fertilized'), ...none }
          }
          session.inventory.removeFromSlot(session.activeHotbar, 1)
          entity.dirty = true
          session.dirty = true
          const levelUps = session.skills.addXp('farming', 2)
          return {
            outcome: result('use', true),
            ...none,
            changed: entity,
            levelUps,
            xpChanged: true,
          }
        }
        if (!isMature(plant, crop)) {
          return { outcome: result('use', false, 'still_growing'), ...none }
        }
        // Harvest: everything or nothing (no partial-yield dupes).
        const fits = crop.yield.every((y) => session.inventory.canFit(y.item, y.count))
        if (!fits) return { outcome: result('use', false, 'inventory_full'), ...none }
        for (const y of crop.yield) session.inventory.add(y.item, y.count)
        if (harvestPlant(plant, crop, nowMs) === 'cleared') delete entity.prop.plant
        entity.dirty = true
        session.dirty = true
        const levelUps = session.skills.addXp('farming', 8)
        return {
          outcome: result('use', true),
          ...none,
          changed: entity,
          levelUps,
          xpChanged: true,
        }
      }
      const seed = heldDef?.seed
      if (held && seed) {
        const crop = world.content.crop(seed.crop)
        if (!crop) return { outcome: result('use', false, 'no_such_crop'), ...none }
        if (session.skills.levelOf('farming') < crop.requiredLevel) {
          return { outcome: result('use', false, 'missing_skill'), ...none }
        }
        session.inventory.removeFromSlot(session.activeHotbar, 1)
        entity.prop.plant = createPlant(crop.id, nowMs)
        entity.dirty = true
        session.dirty = true
        const levelUps = session.skills.addXp('farming', 3)
        return {
          outcome: result('use', true),
          ...none,
          changed: entity,
          levelUps,
          xpChanged: true,
        }
      }
      // Empty planter without seeds equipped: fall through to pickup.
    }
    // Repair: E with the matching material equipped on a damaged prop.
    const healthCap = world.content.item(entity.prop.defId)?.health
    if (
      healthCap?.repair &&
      entity.prop.health !== undefined &&
      entity.prop.health < healthCap.max
    ) {
      const stack = session.inventory.get(session.activeHotbar)
      if (!session.holstered && stack?.defId === healthCap.repair.item) {
        const repair = healthCap.repair
        const consumed = session.inventory.consume([{ item: repair.item, count: repair.count }])
        if (consumed.ok) {
          entity.prop.health = Math.min(healthCap.max, entity.prop.health + repair.restore)
          if (entity.prop.health >= healthCap.max) delete entity.prop.health
          entity.dirty = true
          session.dirty = true
          const levelUps = session.skills.addXp('construction', 2)
          return {
            outcome: result('use', true),
            ...none,
            changed: entity,
            levelUps,
            xpChanged: true,
          }
        }
      }
    }
    // Installed (frozen) doors swing on E instead of being picked up.
    if (
      world.content.item(entity.prop.defId)?.door &&
      entity.prop.motion !== 'dynamic' &&
      world.toggleDoor(entity)
    ) {
      return { outcome: result('use', true), ...none, changed: entity }
    }
    // A stocked container refuses pickup — its contents would vanish.
    if (entity.prop.container?.some((slot) => slot !== null)) {
      return { outcome: result('use', false, 'not_empty'), ...none }
    }
    // Same for a tank holding water or a machine mid-job.
    if (targetDef?.waterTank && (entity.prop.waterAmount ?? 0) >= 1) {
      return { outcome: result('use', false, 'not_empty'), ...none }
    }
    if (entity.prop.machine?.job) {
      return { outcome: result('use', false, 'machine_busy'), ...none }
    }
    // A damaged prop refuses pickup — repairing it first prevents the
    // "pocket the wreck, redeploy it pristine" laundering exploit.
    if (healthCap && entity.prop.health !== undefined && entity.prop.health < healthCap.max) {
      return { outcome: result('use', false, 'damaged'), ...none }
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

  // Minecraft-style: ANYTHING can work a node — bare fists, a log, a rock.
  // The matching tool is just much better (perUse x power vs a single unit).
  const tool = equippedTool(session)
  const usingMatchingTool = tool !== undefined && tool.kind === nodeType.requiredTool

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
  let spawned: GameEntity | null = null
  if (res.remaining <= 0) {
    res.remaining = 0
    res.depletedUntil = nowMs + nodeType.respawnSeconds * 1000
    // Timber! Felling a tree spawns a real physical trunk that tips away
    // from the chopper and crashes down under the physics engine.
    if (nodeType.visual === 'tree') {
      const away = vec3(
        entity.transform.pos.x - session.move.pos.x,
        0,
        entity.transform.pos.z - session.move.pos.z,
      )
      const len = Math.hypot(away.x, away.z) || 1
      away.x /= len
      away.z /= len
      spawned = world.spawnProp({
        defId: 'tree_trunk',
        pos: vec3(entity.transform.pos.x, entity.transform.pos.y + 1.75, entity.transform.pos.z),
        rot: qfromYaw(quat(), session.yaw),
        motion: 'dynamic',
        owner: session.playerId,
        lootCount: 1,
        velocity: vec3(away.x * 1.2, 0.3, away.z * 1.2),
        // Tip over the axis perpendicular to the fall direction.
        angularVelocity: vec3(away.z * 2.2, 0, -away.x * 2.2),
      })
    }
  }
  entity.dirty = true
  session.dirty = true
  const levelUps = session.skills.addXp(nodeType.skill, nodeType.xpPerGather)
  return {
    outcome: result('use', true),
    changed: entity,
    pickedUp: null,
    spawned,
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

/**
 * Ghost-preview placement: the stack leaves the inventory and becomes a
 * DYNAMIC prop at the requested pose. Never frozen on spawn — if the
 * client lied about a clear spot, physics depenetration resolves it
 * honestly instead of leaving a teleported wall inside someone's head.
 */
export function handlePlace(
  session: PlayerSession,
  world: GameWorld,
  msg: ClientPlace,
): { outcome: ActionOutcome; placedId: string | null } {
  const none = { placedId: null }
  const stack = session.inventory.get(msg.slot)
  if (!stack) return { outcome: result('place', false, 'empty_slot'), ...none }
  const def = world.content.item(stack.defId)
  if (!def?.placeable || !def.world) {
    return { outcome: result('place', false, 'not_placeable'), ...none }
  }
  const pos = vec3(msg.pos[0], msg.pos[1], msg.pos[2])
  eyePosition(session, _eye)
  if (v3dist(_eye, pos) > def.placeable.maxRange + 1.5) {
    return { outcome: result('place', false, 'out_of_range'), ...none }
  }
  if (!world.zones.rulesAt(pos).build) {
    return { outcome: result('place', false, 'zone_forbids_build'), ...none }
  }
  const bound = world.content.world.groundHalfExtent + 2
  if (Math.abs(pos.x) > bound || Math.abs(pos.z) > bound) {
    return { outcome: result('place', false, 'out_of_bounds'), ...none }
  }
  const removed = session.inventory.removeFromSlot(msg.slot, 1)
  if (!removed) return { outcome: result('place', false, 'empty_slot'), ...none }
  const entity = world.spawnProp({
    defId: removed.defId,
    pos,
    rot: qfromYaw(quat(), msg.yaw),
    motion: 'dynamic',
    owner: session.playerId,
    lootCount: 1,
  })
  session.dirty = true
  return { outcome: result('place', true), placedId: entity.id }
}

export interface ConstraintOutcome {
  outcome: ActionOutcome
  created: ConstraintRecord | null
}

const _localA = vec3()
const _localB = vec3()
const _axisLocalA = vec3()
const _axisLocalB = vec3()
const _worldAxis = vec3()
const _pA = vec3()
const _pB = vec3()

/** World point → body-local anchor, clamped to a plausible prop radius. */
function toLocalAnchor(out: Vec3, entity: GameEntity, point: Vec3): [number, number, number] {
  out.x = point.x - entity.transform.pos.x
  out.y = point.y - entity.transform.pos.y
  out.z = point.z - entity.transform.pos.z
  qrotateVecInv(out, entity.transform.rot, out)
  const len = Math.hypot(out.x, out.y, out.z)
  const max = CONSTRAINT_LIMITS.maxAnchorOffset
  if (len > max) {
    const k = max / len
    out.x *= k
    out.y *= k
    out.z *= k
  }
  return [out.x, out.y, out.z]
}

/**
 * Rigging tool: create a constraint between two props. Every field of the
 * request is hostile until proven otherwise — tool, targets, ownership,
 * reach, gap, zone, per-entity limits, skill level, materials and the
 * parameter space itself are all validated server-side.
 */
export function handleConstraint(
  session: PlayerSession,
  world: GameWorld,
  msg: ClientConstraint,
  canManipulate: (entity: GameEntity) => boolean,
): ConstraintOutcome {
  const none = { created: null }
  const fail = (error: string): ConstraintOutcome => ({
    outcome: result('constraint', false, error),
    ...none,
  })
  const tool = equippedTool(session)
  if (tool?.kind !== 'rigging') return fail('requires_rigging_tool')
  if (msg.a === msg.b) return fail('same_target')
  const a = world.entities.get(asEntityId(msg.a))
  const b = world.entities.get(asEntityId(msg.b))
  if (!a?.prop || !b?.prop) return fail('no_target')
  if (!canManipulate(a) || !canManipulate(b)) return fail('not_owner')

  _pA.x = msg.pointA[0]
  _pA.y = msg.pointA[1]
  _pA.z = msg.pointA[2]
  _pB.x = msg.pointB[0]
  _pB.y = msg.pointB[1]
  _pB.z = msg.pointB[2]
  // The claimed grab points must actually be on/near their props.
  if (
    v3dist(_pA, a.transform.pos) > CONSTRAINT_LIMITS.maxAnchorOffset + 1 ||
    v3dist(_pB, b.transform.pos) > CONSTRAINT_LIMITS.maxAnchorOffset + 1
  ) {
    return fail('bad_anchor')
  }

  eyePosition(session, _eye)
  const reach = tool.range + 1.5
  if (v3dist(_eye, a.transform.pos) > reach || v3dist(_eye, b.transform.pos) > reach) {
    return fail('out_of_range')
  }
  const gap = v3dist(_pA, _pB)
  const maxGap = msg.kind === 'rope' || msg.kind === 'spring' ? 8 : CONSTRAINT_LIMITS.maxGap
  if (gap > maxGap) return fail('too_far_apart')
  if (!world.zones.rulesAt(a.transform.pos).build || !world.zones.rulesAt(b.transform.pos).build) {
    return fail('zone_forbids_build')
  }
  if (world.hasConstraint(a.id, b.id, msg.kind)) return fail('already_linked')
  if (
    world.constraintCountFor(a.id) >= CONSTRAINT_LIMITS.perEntity ||
    world.constraintCountFor(b.id) >= CONSTRAINT_LIMITS.perEntity
  ) {
    return fail('constraint_limit')
  }
  if (session.skills.levelOf('construction') < CONSTRAINT_SKILL[msg.kind]) {
    return fail('missing_skill')
  }

  // Assemble body-local params from the world-space request.
  const params: ConstraintParams = {
    anchorA: toLocalAnchor(_localA, a, _pA),
    anchorB: toLocalAnchor(_localB, b, _pB),
  }
  if (msg.kind === 'rope' || msg.kind === 'spring') {
    params.length = msg.length ?? Math.max(gap, 0.3)
  }
  if (
    msg.kind === 'hinge' ||
    msg.kind === 'axis' ||
    msg.kind === 'slider' ||
    msg.kind === 'motor'
  ) {
    if (!msg.axis) return fail('bad_axis')
    _worldAxis.x = msg.axis[0]
    _worldAxis.y = msg.axis[1]
    _worldAxis.z = msg.axis[2]
    const len = Math.hypot(_worldAxis.x, _worldAxis.y, _worldAxis.z)
    if (!Number.isFinite(len) || len < 1e-3) return fail('bad_axis')
    _worldAxis.x /= len
    _worldAxis.y /= len
    _worldAxis.z /= len
    qrotateVecInv(_axisLocalA, a.transform.rot, _worldAxis)
    qrotateVecInv(_axisLocalB, b.transform.rot, _worldAxis)
    params.axisA = [_axisLocalA.x, _axisLocalA.y, _axisLocalA.z]
    params.axisB = [_axisLocalB.x, _axisLocalB.y, _axisLocalB.z]
    if (msg.kind === 'hinge' && msg.limits) params.limits = msg.limits
    if (msg.kind === 'slider' && msg.limits) params.limits = msg.limits
    if (msg.kind === 'motor') {
      params.motor = {
        targetVelocity: msg.motorVel ?? 3,
        maxForce: msg.motorForce ?? 500,
      }
    }
  }
  if (msg.kind === 'spring') {
    params.stiffness = msg.stiffness ?? 400
    params.damping = msg.damping ?? 15
  }
  const valid = validateConstraintParams(msg.kind, params)
  if (!valid.ok) return fail(valid.error)

  // Materials are consumed atomically, AFTER all validation.
  const cost = CONSTRAINT_COST[msg.kind]
  if (cost) {
    const consumed = session.inventory.consume([cost])
    if (!consumed.ok) return fail('missing_materials')
  }

  const record = world.addConstraintRecord(a, b, msg.kind, params)
  if (!record) {
    // Refund: creation failed after materials were taken (body vanished).
    if (cost) session.inventory.add(cost.item, cost.count)
    return fail('no_target')
  }
  session.skills.addXp('construction', 4)
  session.dirty = true
  return { outcome: result('constraint', true), created: record }
}

export function handleInvMove(session: PlayerSession, msg: ClientInvMove): ActionOutcome {
  const moved = session.inventory.move(msg.from, msg.to, msg.count)
  if (!moved.ok) return result('inv_move', false, moved.error)
  session.dirty = true
  return result('inv_move', true)
}
