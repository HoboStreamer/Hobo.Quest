import { stanceProgress, type GameEntity } from '@hobo/gameplay'
import type { ServerSnapshot, WireBodyState, WireEntity, WirePlayerState } from '@hobo/protocol'
import { v3distSq, type EntityId } from '@hobo/shared'
import type { GameWorld } from './gameWorld.js'
import type { PlayerSession } from './playerSession.js'

/**
 * Interest management + snapshot building.
 *
 * Relevance is currently a radius test over the entity store (fine at slice
 * scale). The contract to preserve as the world grows: replication cost per
 * client is proportional to *relevant* entities, never total entities — the
 * radius query will move to the spatial region index without changing
 * callers.
 */

export function wireEntityFor(world: GameWorld, entity: GameEntity): WireEntity {
  const { pos, rot } = entity.transform
  const base = {
    id: entity.id as string,
    pos: [pos.x, pos.y, pos.z] as [number, number, number],
    rot: [rot.x, rot.y, rot.z, rot.w] as [number, number, number, number],
  }
  if (entity.prop) {
    return {
      ...base,
      kind: 'prop',
      def: entity.prop.defId,
      motion: entity.prop.motion,
      ...(entity.owner !== undefined ? { owner: entity.owner as string } : {}),
      ...(entity.prop.plant
        ? {
            plant: {
              seed: entity.prop.plant.seedId,
              plantedAt: entity.prop.plant.plantedAt,
              growSeconds: world.content.item(entity.prop.plant.seedId)?.seed?.growSeconds ?? 240,
            },
          }
        : {}),
    }
  }
  if (entity.resource) {
    return {
      ...base,
      kind: 'resource',
      def: entity.resource.nodeTypeId,
      remaining: entity.resource.remaining,
    }
  }
  return { ...base, kind: 'player' }
}

export function wirePlayerFor(session: PlayerSession): WirePlayerState {
  const { pos, vel } = session.move
  const item = session.holstered ? undefined : session.inventory.get(session.activeHotbar)?.defId
  return {
    id: session.entityId as string,
    pos: [pos.x, pos.y, pos.z],
    vel: [vel.x, vel.y, vel.z],
    yaw: session.yaw,
    pitch: session.pitch,
    grounded: session.move.grounded,
    stance: session.move.stance,
    stanceP: stanceProgress(session.move),
    ...(item !== undefined ? { item } : {}),
  }
}

export interface InterestDiff {
  entered: GameEntity[]
  left: EntityId[]
}

/** Updates session.known in place and returns what changed. */
export function updateInterest(
  session: PlayerSession,
  world: GameWorld,
  radius: number,
): InterestDiff {
  const radiusSq = radius * radius
  const entered: GameEntity[] = []
  const current = new Set<EntityId>()
  for (const entity of world.entities.all()) {
    if (entity.id === session.entityId) continue
    if (v3distSq(entity.transform.pos, session.move.pos) > radiusSq) continue
    current.add(entity.id)
    if (!session.known.has(entity.id)) entered.push(entity)
  }
  const left: EntityId[] = []
  for (const id of session.known) {
    if (!current.has(id)) left.push(id)
  }
  session.known = current
  return { entered, left }
}

/** Snapshot for one session: relevant players + awake relevant prop bodies. */
export function buildSnapshot(
  session: PlayerSession,
  world: GameWorld,
  sessions: Iterable<PlayerSession>,
  tick: number,
): ServerSnapshot {
  const self = wirePlayerFor(session)
  // Reconciliation extras (own player only): the client must rewind the
  // FULL stance machine or replays re-fight toggles (prone flap, view jerk).
  self.stanceT = session.move.stanceT
  self.stanceCd = session.move.stanceCooldown
  self.proneBits = (session.move.proneActive ? 1 : 0) | (session.move.proneHeld ? 2 : 0)
  self.noclip = session.move.noclip
  const players: WirePlayerState[] = [self]
  for (const other of sessions) {
    if (other === session) continue
    if (session.known.has(other.entityId)) players.push(wirePlayerFor(other))
  }
  const bodies: WireBodyState[] = []
  for (const id of session.known) {
    const entity = world.entities.get(id)
    if (!entity?.prop || entity.prop.motion !== 'dynamic') continue
    if (world.isSettledEntity(id)) continue
    const { pos, rot } = entity.transform
    bodies.push({
      id: id as string,
      pos: [pos.x, pos.y, pos.z],
      rot: [rot.x, rot.y, rot.z, rot.w],
    })
  }
  return { t: 'snap', tick, ack: session.lastProcessedSeq, players, bodies }
}
