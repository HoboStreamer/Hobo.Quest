import {
  DEFAULT_MOVEMENT,
  Inventory,
  SkillSet,
  hullHeightFor,
  stepMovement,
  type CollisionQueries,
  type GameEntity,
} from '@hobo/gameplay'
import { STARTER_ITEMS, recipeSkill, recipeXp } from '@hobo/content'
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
  equippedTool,
  handleCraft,
  handleDrop,
  handleInvMove,
  handleUse,
  handleWeld,
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
  private readonly sessionsByEntity = new Map<EntityId, PlayerSession>()
  private readonly playerBodies = new Map<PlayerId, BodyId>()
  private readonly heldEntityIds = new Set<string>()
  /** Short-lived cache of OFFLINE owners' friend lists (prop protection). */
  private readonly offlineFriendsCache = new Map<string, { friends: Set<string>; at: number }>()
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

  /**
   * Prop protection: world props (no owner) are free; otherwise the owner
   * or anyone the OWNER trusts may manipulate. Works for offline owners via
   * a TTL-cached repository lookup.
   */
  private canManipulate(session: PlayerSession, entity: GameEntity): boolean {
    if (entity.owner === undefined) return true
    if (entity.owner === session.playerId) return true
    const ownerSession = this.sessions.get(entity.owner)
    if (ownerSession) return ownerSession.friends.has(session.playerId)
    const cached = this.offlineFriendsCache.get(entity.owner)
    if (cached && Date.now() - cached.at < 30_000) {
      return cached.friends.has(session.playerId)
    }
    const owner = this.store.players.findById(entity.owner)
    const friends = new Set(owner?.friends ?? [])
    this.offlineFriendsCache.set(entity.owner, { friends, at: Date.now() })
    return friends.has(session.playerId)
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
        // Swing cooldown: silently drop spam faster than ~5 swings/sec.
        if (this.tick - session.lastUseTick < 6) break
        const gather = handleUse(session, this.world, msg, Date.now(), (e) =>
          this.canManipulate(session, e),
        )
        this.send(session, gather.outcome)
        if (!gather.outcome.ok) break
        session.lastUseTick = this.tick
        this.sendInventory(session)
        if (gather.xpChanged) this.sendSkills(session)
        for (const up of gather.levelUps) {
          this.send(session, { t: 'levelup', skill: up.skill, level: up.level })
        }
        if (gather.pickedUp) {
          if (session.held?.entityId === gather.pickedUp.id) this.releaseHeld(session)
          this.broadcastDespawn(gather.pickedUp.id)
        }
        if (gather.changed?.resource) {
          this.broadcastToKnowing(gather.changed.id, {
            t: 'entity',
            id: gather.changed.id,
            remaining: gather.changed.resource.remaining,
          })
        }
        break
      }
      case 'trust': {
        this.handleTrust(session, msg.player, msg.trusted)
        break
      }
      case 'weld': {
        const { outcome, welded } = handleWeld(session, this.world, msg, (e) =>
          this.canManipulate(session, e),
        )
        this.send(session, outcome)
        if (welded) {
          this.broadcastAll({ t: 'weld_state', a: welded.a.id, b: welded.b.id, active: true })
          this.sendSkills(session)
        }
        break
      }
      case 'unweld': {
        const tool = equippedTool(session)
        if (tool?.kind !== 'hammer') {
          this.send(session, { t: 'result', action: 'unweld', ok: false, error: 'requires_hammer' })
          break
        }
        const target = this.world.entities.get(msg.target as EntityId)
        if (!target?.prop) {
          this.send(session, { t: 'result', action: 'unweld', ok: false, error: 'no_target' })
          break
        }
        const removed = this.world.removeWeldsFor(target.id)
        this.send(session, {
          t: 'result',
          action: 'unweld',
          ok: removed.length > 0,
          ...(removed.length === 0 ? { error: 'no_welds' } : {}),
        })
        for (const weld of removed) {
          this.broadcastAll({ t: 'weld_state', a: weld.a, b: weld.b, active: false })
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
      case 'drop': {
        const { outcome, droppedId } = handleDrop(session, this.world, msg)
        this.send(session, outcome)
        if (outcome.ok) {
          this.sendInventory(session)
          if (droppedId) {
            const entity = this.world.entities.get(droppedId as EntityId)
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
        if (msg.slot < HOTBAR_SIZE) {
          // Re-pressing the active slot holsters/unholsters (empty hands).
          if (msg.slot === session.activeHotbar) {
            session.holstered = !session.holstered
          } else {
            session.activeHotbar = msg.slot
            session.holstered = false
          }
          // Switching away from the physgun drops anything it was holding.
          if (session.held && equippedTool(session)?.kind !== 'physgun') {
            this.releaseHeld(session)
          }
        }
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
    this.sessionsByEntity.delete(session.entityId)
    // Keep protection checks fresh once the owner goes offline.
    this.offlineFriendsCache.set(session.playerId as string, {
      friends: new Set(session.friends),
      at: Date.now(),
    })
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
    const skills = existing
      ? SkillSet.fromDto(existing.skills, this.world.content)
      : new SkillSet(this.world.content)
    const friends = new Set(existing?.friends ?? [])
    // The client's customization is authoritative for looks (validated by
    // the protocol schema) — EXCEPT body size: everyone shares one hull and
    // silhouette so combat stays fair.
    const appearance = { ...msg.appearance, height: 1, build: 1 }

    // Starter kit: every drifter carries a physgun. Also grants it to
    // players from before the tool system existed.
    for (const grant of STARTER_ITEMS) {
      if (inventory.countOf(grant.item) === 0) {
        const leftover = inventory.add(grant.item, grant.count)
        if (leftover > 0) {
          this.log.warn('starter item did not fit', { item: grant.item, playerId })
        }
      }
    }

    const session = createSession({
      playerId,
      entityId: newEntityId(),
      token: msg.token,
      name: msg.name,
      spawn,
      yaw: existing?.yaw ?? world.spawnYaw,
      inventory,
      skills,
      friends,
      appearance,
      content: this.world.content,
      send: (text) => conn.send(text),
      closeConnection: (code, reason) => conn.close(code, reason),
    })
    this.sessions.set(playerId, session)
    this.sessionsByConn.set(conn, session)
    this.sessionsByEntity.set(session.entityId, session)
    this.offlineFriendsCache.delete(playerId as string)

    // Player entity (transient — players persist via the player repository).
    const entity: GameEntity = {
      id: session.entityId,
      kind: 'player',
      transform: { pos: session.move.pos, rot: qfromYaw(quat(), session.yaw) },
      persistent: false,
      dirty: false,
    }
    this.world.entities.add(entity)

    // Kinematic capsule so props collide with players. Shorter than the
    // movement hull and lifted off the feet: standing ON a prop must not
    // press it down (that caused sink/jitter loops when prop-surfing).
    const bodyId = this.world.physics.addBody({
      shape: { type: 'capsule', radius: MOVE.capsuleRadius, height: MOVE.capsuleHeight - 0.3 },
      motion: 'kinematic',
      pos: vec3(session.move.pos.x, session.move.pos.y + 0.15, session.move.pos.z),
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
    this.sendSkills(session)
    this.sendFriends(session)
    this.metrics.sessions = this.sessions.size
    this.log.info('player connected', {
      playerId: playerId as string,
      name: msg.name,
      restored: existing !== null,
    })
  }

  private handlePhysgun(session: PlayerSession, msg: ClientPhysgun): void {
    // Physgun actions require the physgun in the active hotbar slot.
    if ((msg.a === 'grab' || msg.a === 'unfreeze') && equippedTool(session)?.kind !== 'physgun') {
      this.send(session, {
        t: 'result',
        action: 'physgun',
        ok: false,
        error: 'no_physgun_equipped',
      })
      return
    }
    if (msg.a === 'grab') {
      if (session.held) return
      const grabbed = tryGrab(session, this.world, this.heldEntityIds, (e) =>
        this.canManipulate(session, e),
      )
      if (typeof grabbed === 'string') {
        this.send(session, { t: 'result', action: 'physgun', ok: false, error: grabbed })
        return
      }
      this.heldEntityIds.add(grabbed.id)
      // Grabbing a frozen prop unfreezes it — tell clients about the motion
      // change (physics resumes; frozen visuals must clear).
      this.broadcastToKnowing(grabbed.id, { t: 'entity', id: grabbed.id, motion: 'dynamic' })
      this.broadcastAll({ t: 'physgun_state', player: session.entityId, target: grabbed.id })
    } else if (msg.a === 'release') {
      this.releaseHeld(session)
    } else if (msg.a === 'adjust') {
      adjustDistance(session, msg.dist)
    } else if (msg.a === 'rotate') {
      rotateHeld(session, msg.dyaw, msg.dpitch, msg.snap ?? false, msg.snapStep)
    } else if (msg.a === 'grid') {
      if (session.held) {
        session.held.grid = msg.on
        if (msg.size !== undefined) session.held.gridSize = msg.size
      }
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
      if (!entity?.prop || entity.prop.motion !== 'frozen') {
        this.send(session, { t: 'result', action: 'physgun', ok: false, error: 'no_target' })
        return
      }
      if (!this.world.zones.rulesAt(entity.transform.pos).physgun) {
        this.send(session, { t: 'result', action: 'physgun', ok: false, error: 'zone' })
        return
      }
      if (!this.canManipulate(session, entity)) {
        this.send(session, { t: 'result', action: 'physgun', ok: false, error: 'not_owner' })
        return
      }
      eyePosition(session, _eyeScratch)
      if (
        Math.hypot(
          entity.transform.pos.x - _eyeScratch.x,
          entity.transform.pos.y - _eyeScratch.y,
          entity.transform.pos.z - _eyeScratch.z,
        ) > 10
      ) {
        this.send(session, { t: 'result', action: 'physgun', ok: false, error: 'out_of_range' })
        return
      }
      this.world.setPropMotion(entity, 'dynamic')
      this.broadcastToKnowing(entity.id, { t: 'entity', id: entity.id, motion: 'dynamic' })
    }
  }

  private handleTrust(session: PlayerSession, targetId: string, trusted: boolean): void {
    if (targetId === (session.playerId as string)) {
      this.send(session, { t: 'result', action: 'trust', ok: false, error: 'self' })
      return
    }
    // Target must be a real player (online or persisted).
    const online = this.sessions.get(targetId as PlayerId)
    const known = online ?? this.store.players.findById(targetId)
    if (!known) {
      this.send(session, { t: 'result', action: 'trust', ok: false, error: 'unknown_player' })
      return
    }
    if (trusted) session.friends.add(targetId)
    else session.friends.delete(targetId)
    session.dirty = true
    this.send(session, { t: 'result', action: 'trust', ok: true })
    this.sendFriends(session)
  }

  private sendFriends(session: PlayerSession): void {
    const friends: { id: string; name: string }[] = []
    for (const id of session.friends) {
      const online = this.sessions.get(id as PlayerId)
      const name = online?.name ?? this.store.players.findById(id)?.name ?? 'unknown'
      friends.push({ id, name })
    }
    this.send(session, { t: 'friends', friends })
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
      if (session.held) driveHeld(session, this.world)
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

    // 5. Crafting queues (completions grant crafting/construction XP).
    for (const session of this.sessions.values()) {
      const completed = session.craftQueue.update(this.tick, this.world.content, session.inventory)
      if (completed.length > 0) {
        session.dirty = true
        this.sendInventory(session)
        this.sendCraftState(session)
        for (const recipe of completed) {
          const ups = session.skills.addXp(recipeSkill(recipe.category), recipeXp(recipe))
          for (const up of ups) {
            this.send(session, { t: 'levelup', skill: up.skill, level: up.level })
          }
        }
        this.sendSkills(session)
      }
    }

    // 6. Resource respawn sweep (once a second).
    if (this.tick % this.config.tickRate === 0) {
      for (const entity of this.world.respawnDueResources(Date.now())) {
        if (entity.resource) {
          this.broadcastToKnowing(entity.id, {
            t: 'entity',
            id: entity.id,
            remaining: entity.resource.remaining,
          })
        }
      }
    }

    // 7. Replication.
    if (this.tick % this.config.snapshotEvery === 0) {
      this.replicate()
    }

    // 8. Periodic persistence flush.
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
    let bodyId = this.playerBodies.get(session.playerId)
    if (bodyId !== undefined && session.bodyStance !== session.move.stance) {
      // Stance changed: swap the kinematic hull to match the new posture.
      this.world.physics.removeBody(bodyId)
      const hull = hullHeightFor(session.move.stance)
      bodyId = this.world.physics.addBody({
        shape: {
          type: 'capsule',
          radius: MOVE.capsuleRadius,
          height: Math.max(hull - 0.3, 0.4),
        },
        motion: 'kinematic',
        pos: vec3(session.move.pos.x, session.move.pos.y + 0.15, session.move.pos.z),
        layer: CollisionLayer.Player,
        collidesWith: CollisionLayer.Static | CollisionLayer.Prop,
      })
      this.playerBodies.set(session.playerId, bodyId)
      session.bodyStance = session.move.stance
    }
    if (bodyId !== undefined) {
      _bodyPosScratch.x = session.move.pos.x
      _bodyPosScratch.y = session.move.pos.y + 0.15
      _bodyPosScratch.z = session.move.pos.z
      this.world.physics.setTransform(bodyId, _bodyPosScratch)
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
          entities: diff.entered.map((e) => {
            const wire = wireEntityFor(this.world, e)
            const owner = this.sessionsByEntity.get(e.id)
            if (owner) {
              wire.name = owner.name
              wire.player = owner.playerId as string
              wire.appearance = owner.appearance
            }
            return wire
          }),
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
      skills: session.skills.toDto(),
      friends: [...session.friends],
      appearance: session.appearance,
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

  private sendSkills(session: PlayerSession): void {
    this.send(session, { t: 'skills', skills: session.skills.all() })
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
const _bodyPosScratch = vec3()
