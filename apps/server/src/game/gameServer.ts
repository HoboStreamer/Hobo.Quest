import {
  DEFAULT_MOVEMENT,
  Inventory,
  stepMovement,
  type CollisionQueries,
  type GameEntity,
} from '@hobo/gameplay'
import type { PersistenceStore, PlayerDto } from '@hobo/persistence'
import { CollisionLayer, type BodyId } from '@hobo/physics'
import {
  PROTOCOL_VERSION,
  encodeServerMessage,
  type ClientHello,
  type ClientMessage,
  type ClientPhysgun,
  type ServerMessage,
} from '@hobo/protocol'
import {
  asPlayerId,
  newEntityId,
  newPlayerId,
  qfromYaw,
  quat,
  vec3,
  type EntityId,
  type Logger,
  type PlayerId,
} from '@hobo/shared'
import type { ServerConfig } from '../config.js'
import type { ServerMetrics } from '../observability/metrics.js'
import type { GameWorld } from './gameWorld.js'
import {
  handleCraft,
  handleInvMove,
  handlePlace,
  handleUse,
  nearbyWorkstationKinds,
} from './interactions.js'
import { adjustDistance, driveHeld, freezeHeld, release, rotateHeld, tryGrab } from './physgun.js'
import {
  createSession,
  eyePosition,
  HOTBAR_SIZE,
  INVENTORY_SIZE,
  type PlayerSession,
} from './playerSession.js'
import { buildSnapshot, updateInterest, wireEntityFor } from './replication.js'

/** A network connection as the game sees it — transport-agnostic. */
export interface GameConnection {
  send(text: string): void
  close(code: number, reason: string): void
}

const MOVE = DEFAULT_MOVEMENT
const MAX_INPUT_QUEUE = 6

export class GameServer {
  private readonly sessions = new Map<PlayerId, PlayerSession>()
  private readonly sessionsByConn = new Map<GameConnection, PlayerSession>()
  private readonly playerBodies = new Map<PlayerId, BodyId>()
  private readonly heldEntityIds = new Set<string>()
  private tick = 0
  private readonly moveQueries: CollisionQueries
  private lastFlushTick = 0

  constructor(
    private readonly config: ServerConfig,
    private readonly world: GameWorld,
    private readonly store: PersistenceStore,
    private readonly metrics: ServerMetrics,
    private readonly log: Logger,
  ) {
    this.moveQueries = {
      sweepCapsule: (from, to, radius, height) =>
        world.physics.sweepCapsule(
          from,
          to,
          radius,
          height,
          CollisionLayer.Static | CollisionLayer.Prop,
        ),
    }
  }

  get currentTick(): number {
    return this.tick
  }

  // ── Connection lifecycle ───────────────────────────────────────────

  onMessage(conn: GameConnection, msg: ClientMessage): void {
    const session = this.sessionsByConn.get(conn)
    if (!session) {
      if (msg.t === 'hello') this.handleHello(conn, msg)
      else conn.close(4001, 'hello_first')
      return
    }
    switch (msg.t) {
      case 'hello':
        break // duplicate hello ignored
      case 'input':
        if (session.inputQueue.length < MAX_INPUT_QUEUE) session.inputQueue.push(msg)
        break
      case 'use': {
        const { outcome, despawned, targetChanged } = handleUse(session, this.world, msg)
        this.send(session, outcome)
        if (outcome.ok) this.sendInventory(session)
        if (despawned) this.broadcastDespawn(msg.target)
        else if (targetChanged) {
          const entity = this.world.entities.get(msg.target as EntityId)
          if (entity?.resource) {
            this.broadcastToKnowing(entity.id, {
              t: 'entity',
              id: entity.id,
              remaining: entity.resource.remaining,
            })
          }
        }
        break
      }
      case 'craft': {
        const outcome = handleCraft(session, this.world, msg, this.tick, this.config.tickRate)
        this.send(session, outcome)
        if (outcome.ok) {
          this.sendInventory(session)
          this.sendCraftState(session)
        }
        break
      }
      case 'place': {
        const { outcome, placedId } = handlePlace(session, this.world, msg)
        this.send(session, outcome)
        if (outcome.ok) {
          this.sendInventory(session)
          if (placedId) {
            const entity = this.world.entities.get(placedId as EntityId)
            if (entity) this.broadcastSpawn(entity)
          }
        }
        break
      }
      case 'inv_move': {
        const outcome = handleInvMove(session, msg)
        this.send(session, outcome)
        this.sendInventory(session)
        break
      }
      case 'hotbar':
        if (msg.slot < HOTBAR_SIZE) session.activeHotbar = msg.slot
        break
      case 'physgun':
        this.handlePhysgun(session, msg)
        break
    }
  }

  onDisconnect(conn: GameConnection): void {
    const session = this.sessionsByConn.get(conn)
    if (!session) return
    this.sessionsByConn.delete(conn)
    this.sessions.delete(session.playerId)
    if (session.held) {
      this.heldEntityIds.delete(session.held.entityId)
      session.held = null
    }
    const bodyId = this.playerBodies.get(session.playerId)
    if (bodyId !== undefined) {
      this.world.physics.removeBody(bodyId)
      this.playerBodies.delete(session.playerId)
    }
    this.world.entities.remove(session.entityId)
    this.savePlayer(session)
    this.broadcastDespawn(session.entityId)
    this.metrics.sessions = this.sessions.size
    this.log.info('player disconnected', { playerId: session.playerId, name: session.name })
  }

  private handleHello(conn: GameConnection, msg: ClientHello): void {
    if (msg.v !== PROTOCOL_VERSION) {
      conn.send(encodeServerMessage({ t: 'reject', reason: 'protocol_mismatch' }))
      conn.close(4002, 'protocol_mismatch')
      return
    }
    if (this.sessions.size >= this.config.maxPlayers) {
      conn.send(encodeServerMessage({ t: 'reject', reason: 'server_full' }))
      conn.close(4003, 'server_full')
      return
    }

    const existing = this.store.players.findByToken(msg.token)
    // A token can only drive one live session; kick the older one.
    if (existing) {
      for (const s of this.sessions.values()) {
        if (s.token === msg.token) {
          s.closeConnection(4004, 'session_superseded')
        }
      }
    }

    const world = this.world.content.world
    const playerId = existing ? asPlayerId(existing.id) : newPlayerId()
    const spawn = existing
      ? vec3(existing.pos[0], existing.pos[1], existing.pos[2])
      : vec3(world.spawnPoint[0], world.spawnPoint[1], world.spawnPoint[2])
    const inventory = existing
      ? Inventory.fromDto(existing.inventory, this.world.content)
      : new Inventory(INVENTORY_SIZE, HOTBAR_SIZE, this.world.content)

    const session = createSession({
      playerId,
      entityId: newEntityId(),
      token: msg.token,
      name: msg.name,
      spawn,
      yaw: existing?.yaw ?? world.spawnYaw,
      inventory,
      send: (text) => conn.send(text),
      closeConnection: (code, reason) => conn.close(code, reason),
    })
    this.sessions.set(playerId, session)
    this.sessionsByConn.set(conn, session)

    // Player entity (transient — players persist via the player repository).
    const entity: GameEntity = {
      id: session.entityId,
      kind: 'player',
      transform: { pos: session.move.pos, rot: qfromYaw(quat(), session.yaw) },
      persistent: false,
      dirty: false,
    }
    this.world.entities.add(entity)

    // Kinematic capsule so props collide with players.
    const bodyId = this.world.physics.addBody({
      shape: { type: 'capsule', radius: MOVE.capsuleRadius, height: MOVE.capsuleHeight },
      motion: 'kinematic',
      pos: session.move.pos,
      layer: CollisionLayer.Player,
      collidesWith: CollisionLayer.Static | CollisionLayer.Prop,
    })
    this.playerBodies.set(playerId, bodyId)

    this.send(session, {
      t: 'welcome',
      v: PROTOCOL_VERSION,
      playerId: playerId as string,
      entityId: session.entityId as string,
      tick: this.tick,
      tickRate: this.config.tickRate,
      snapshotRate: this.config.tickRate / this.config.snapshotEvery,
    })
    this.sendInventory(session)
    this.metrics.sessions = this.sessions.size
    this.log.info('player connected', {
      playerId: playerId as string,
      name: msg.name,
      restored: existing !== null,
    })
  }

  private handlePhysgun(session: PlayerSession, msg: ClientPhysgun): void {
    if (msg.a === 'grab') {
      if (session.held) return
      const grabbed = tryGrab(session, this.world, this.heldEntityIds, MOVE.eyeOffset)
      if (typeof grabbed === 'string') {
        this.send(session, { t: 'result', action: 'physgun', ok: false, error: grabbed })
        return
      }
      this.heldEntityIds.add(grabbed.id)
      this.broadcastAll({ t: 'physgun_state', player: session.entityId, target: grabbed.id })
    } else if (msg.a === 'release') {
      this.releaseHeld(session)
    } else if (msg.a === 'adjust') {
      adjustDistance(session, msg.dist)
    } else if (msg.a === 'rotate') {
      rotateHeld(session, msg.dyaw, msg.dpitch, msg.snap ?? false)
    } else if (msg.a === 'freeze') {
      const frozen = freezeHeld(session, this.world)
      if (frozen) {
        this.heldEntityIds.delete(frozen.id)
        this.broadcastToKnowing(frozen.id, {
          t: 'entity',
          id: frozen.id,
          motion: 'frozen',
          pos: [frozen.transform.pos.x, frozen.transform.pos.y, frozen.transform.pos.z],
          rot: [
            frozen.transform.rot.x,
            frozen.transform.rot.y,
            frozen.transform.rot.z,
            frozen.transform.rot.w,
          ],
        })
        this.broadcastAll({ t: 'physgun_state', player: session.entityId, target: null })
      }
    } else if (msg.a === 'unfreeze') {
      const entity = this.world.entities.get(msg.target as EntityId)
      if (!entity?.prop || entity.prop.motion !== 'frozen') return
      eyePosition(session, MOVE.eyeOffset, _eyeScratch)
      if (
        Math.hypot(
          entity.transform.pos.x - _eyeScratch.x,
          entity.transform.pos.y - _eyeScratch.y,
          entity.transform.pos.z - _eyeScratch.z,
        ) > 10
      ) {
        return
      }
      this.world.setPropMotion(entity, 'dynamic')
      this.broadcastToKnowing(entity.id, { t: 'entity', id: entity.id, motion: 'dynamic' })
    }
  }

  private releaseHeld(session: PlayerSession): void {
    if (!session.held) return
    this.heldEntityIds.delete(session.held.entityId)
    release(session)
    this.broadcastAll({ t: 'physgun_state', player: session.entityId, target: null })
  }

  // ── Simulation tick ────────────────────────────────────────────────

  step(): void {
    const tickStart = performance.now()
    this.tick++

    // 1. Movement from queued inputs (server-simulated, never client positions).
    for (const session of this.sessions.values()) {
      this.stepSessionMovement(session)
    }

    // 2. Physgun drives held bodies via velocity control.
    for (const session of this.sessions.values()) {
      if (session.held) driveHeld(session, this.world, MOVE.eyeOffset)
    }

    // 3. Fixed-step physics.
    const physStart = performance.now()
    this.world.physics.step(1 / this.config.tickRate)
    const physMs = performance.now() - physStart

    // 4. Sync awake props; announce settles so clients pin final transforms.
    const { awake, settledCount } = this.world.syncFromPhysics({
      onSettle: (entity) => {
        this.broadcastToKnowing(entity.id, {
          t: 'entity',
          id: entity.id,
          pos: [entity.transform.pos.x, entity.transform.pos.y, entity.transform.pos.z],
          rot: [
            entity.transform.rot.x,
            entity.transform.rot.y,
            entity.transform.rot.z,
            entity.transform.rot.w,
          ],
        })
      },
    })
    this.metrics.awakeBodies = awake
    this.metrics.settledBodies = settledCount

    // 5. Crafting queues.
    for (const session of this.sessions.values()) {
      const completed = session.craftQueue.update(this.tick, this.world.content, session.inventory)
      if (completed.length > 0) {
        session.dirty = true
        this.sendInventory(session)
        this.sendCraftState(session)
      }
    }

    // 6. Replication.
    if (this.tick % this.config.snapshotEvery === 0) {
      this.replicate()
    }

    // 7. Periodic persistence flush.
    if (this.tick - this.lastFlushTick >= this.config.persistFlushSeconds * this.config.tickRate) {
      this.lastFlushTick = this.tick
      this.flush()
    }

    this.metrics.tick = this.tick
    this.metrics.entities = this.world.entities.size
    this.metrics.recordTick(performance.now() - tickStart, physMs)
  }

  private stepSessionMovement(session: PlayerSession): void {
    // Process at most 2 queued inputs per tick (catch-up), else repeat the
    // last input — the queue bound caps client-driven speedup.
    const budget = session.inputQueue.length > 2 ? 2 : 1
    let simulated = 0
    for (let i = 0; i < budget; i++) {
      const input = session.inputQueue.shift()
      if (!input) break
      session.lastInput = input
      session.starvedTicks = 0
      session.lastProcessedSeq = input.seq
      session.yaw = input.yaw
      session.pitch = input.pitch
      session.buttons = input.buttons
      stepMovement(session.move, input, MOVE, this.moveQueries, 1 / this.config.tickRate)
      simulated++
    }
    if (simulated === 0 && session.lastInput) {
      // Bridge short network jitter by repeating the last command, but only
      // briefly — a silent client must coast to a stop, not walk forever.
      session.starvedTicks++
      const input =
        session.starvedTicks <= 3
          ? session.lastInput
          : { ...session.lastInput, moveX: 0, moveZ: 0, buttons: 0 }
      stepMovement(session.move, input, MOVE, this.moveQueries, 1 / this.config.tickRate)
    }
    const bodyId = this.playerBodies.get(session.playerId)
    if (bodyId !== undefined) {
      this.world.physics.setTransform(bodyId, session.move.pos)
    }
    const entity = this.world.entities.get(session.entityId)
    if (entity) qfromYaw(entity.transform.rot, session.yaw)
  }

  private replicate(): void {
    for (const session of this.sessions.values()) {
      const diff = updateInterest(session, this.world, this.config.interestRadius)
      if (diff.entered.length > 0) {
        this.send(session, {
          t: 'spawn',
          entities: diff.entered.map((e) => wireEntityFor(this.world, e)),
        })
      }
      if (diff.left.length > 0) {
        this.send(session, { t: 'despawn', ids: diff.left as string[] })
      }
      const snapshot = buildSnapshot(session, this.world, this.sessions.values(), this.tick)
      const encoded = encodeServerMessage(snapshot)
      this.metrics.snapshotBytes = encoded.length
      this.sendRaw(session, encoded)
    }
  }

  // ── Persistence ────────────────────────────────────────────────────

  flush(): void {
    const wrote = this.world.flushDirty(this.store)
    const dirtyPlayers: PlayerDto[] = []
    for (const session of this.sessions.values()) {
      if (!session.dirty) continue
      dirtyPlayers.push(this.playerToDto(session))
      session.dirty = false
    }
    if (dirtyPlayers.length > 0) this.store.players.upsertMany(dirtyPlayers)
    this.metrics.dbDirtyQueue = 0
    if (wrote > 0 || dirtyPlayers.length > 0) {
      this.log.debug('persistence flush', { entities: wrote, players: dirtyPlayers.length })
    }
  }

  /** Full save on shutdown. */
  shutdown(): void {
    for (const session of this.sessions.values()) this.savePlayer(session)
    this.flush()
    this.log.info('world saved on shutdown', {})
  }

  private savePlayer(session: PlayerSession): void {
    this.store.players.upsert(this.playerToDto(session))
    session.dirty = false
  }

  private playerToDto(session: PlayerSession): PlayerDto {
    const { pos } = session.move
    return {
      id: session.playerId as string,
      token: session.token,
      name: session.name,
      pos: [pos.x, pos.y, pos.z],
      yaw: session.yaw,
      inventory: session.inventory.toDto(),
      updatedAt: Date.now(),
    }
  }

  // ── Messaging helpers ──────────────────────────────────────────────

  private send(session: PlayerSession, msg: ServerMessage): void {
    this.sendRaw(session, encodeServerMessage(msg))
  }

  private sendRaw(session: PlayerSession, encoded: string): void {
    session.send(encoded)
    this.metrics.bytesOut += encoded.length
    this.metrics.messagesOut++
  }

  private sendInventory(session: PlayerSession): void {
    const dto = session.inventory.toDto()
    this.send(session, {
      t: 'inventory',
      inv: {
        size: dto.size,
        hotbar: dto.hotbar,
        slots: dto.slots.map(({ i, stack }) => ({
          i,
          stack: {
            def: stack.defId,
            count: stack.count,
            ...(stack.meta !== undefined ? { meta: stack.meta } : {}),
          },
        })),
      },
      activeHotbar: session.activeHotbar,
    })
  }

  private sendCraftState(session: PlayerSession): void {
    this.send(session, {
      t: 'craft_state',
      jobs: session.craftQueue.pending.map((j) => ({ recipe: j.recipeId, readyTick: j.readyTick })),
    })
  }

  private broadcastAll(msg: ServerMessage): void {
    const encoded = encodeServerMessage(msg)
    for (const session of this.sessions.values()) this.sendRaw(session, encoded)
  }

  private broadcastSpawn(entity: GameEntity): void {
    // Deliver immediately to sessions in range; interest diff would send it
    // next snapshot anyway, but placement feedback should be instant.
    const wire = wireEntityFor(this.world, entity)
    const encoded = encodeServerMessage({ t: 'spawn', entities: [wire] })
    const radiusSq = this.config.interestRadius ** 2
    for (const session of this.sessions.values()) {
      const d2 =
        (entity.transform.pos.x - session.move.pos.x) ** 2 +
        (entity.transform.pos.y - session.move.pos.y) ** 2 +
        (entity.transform.pos.z - session.move.pos.z) ** 2
      if (d2 <= radiusSq) {
        session.known.add(entity.id)
        this.sendRaw(session, encoded)
      }
    }
  }

  private broadcastDespawn(id: string): void {
    for (const session of this.sessions.values()) {
      if (session.known.delete(id as EntityId)) {
        this.send(session, { t: 'despawn', ids: [id] })
      }
    }
  }

  private broadcastToKnowing(id: EntityId, msg: ServerMessage): void {
    const encoded = encodeServerMessage(msg)
    for (const session of this.sessions.values()) {
      if (session.known.has(id)) this.sendRaw(session, encoded)
    }
  }

  /** Exposes crafting context for the client-facing recipe availability (welcome-time). */
  workstationsNear(session: PlayerSession): ReadonlySet<string> {
    return nearbyWorkstationKinds(session, this.world)
  }
}

const _eyeScratch = vec3()
