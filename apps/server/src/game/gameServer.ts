import {
  Buttons,
  DEFAULT_MOVEMENT,
  Inventory,
  SkillSet,
  applyDamage,
  eat,
  hullHeightFor,
  stepMovement,
  tickSurvival,
  type CollisionQueries,
  type GameEntity,
} from '@hobo/gameplay'
import {
  DROP_LOOT,
  DROP_SITES,
  STARTER_ITEMS,
  TRADES,
  WATER_LEVEL,
  recipeSkill,
  recipeXp,
  terrainHeight,
} from '@hobo/content'
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
import { resolveHoboToolsUser } from '../net/hoboToolsAuth.js'
import { worldSpawn } from '@hobo/content'
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
  /** Real client IP (Cloudflare-aware) — guest identity hangs off this. */
  ip: string
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
  /** Body excluded from the current movement sweep (the moving player's own). */
  private sweepSelf: BodyId | undefined
  private lastFlushTick = 0

  constructor(
    private readonly config: ServerConfig,
    private readonly world: GameWorld,
    private readonly store: PersistenceStore,
    private readonly metrics: ServerMetrics,
    private readonly log: Logger,
  ) {
    // Players block players: sweeps include the Player layer, minus the
    // mover's own kinematic body.
    this.moveQueries = {
      sweepCapsule: (from, to, radius, height) =>
        world.physics.sweepCapsule(
          from,
          to,
          radius,
          height,
          CollisionLayer.Static | CollisionLayer.Prop | CollisionLayer.Player,
          this.sweepSelf,
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
      if (msg.t === 'hello') void this.handleHello(conn, msg)
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
        const targetSession = this.sessionsByEntity.get(msg.target as EntityId)
        if (targetSession) {
          this.handleMelee(session, targetSession)
          break
        }
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
        if (gather.spawned) this.broadcastSpawn(gather.spawned)
        if (gather.changed?.prop) {
          // Door swing / plant change: pin authoritative state everywhere.
          const e = gather.changed
          const plant = e.prop?.plant
          this.broadcastToKnowing(e.id, {
            t: 'entity',
            id: e.id,
            pos: [e.transform.pos.x, e.transform.pos.y, e.transform.pos.z],
            rot: [e.transform.rot.x, e.transform.rot.y, e.transform.rot.z, e.transform.rot.w],
            plant: plant
              ? {
                  seed: plant.seedId,
                  plantedAt: plant.plantedAt,
                  growSeconds: this.world.content.item(plant.seedId)?.seed?.growSeconds ?? 240,
                }
              : null,
          })
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
          // Switching away from the physgun drops beam and anything held.
          if (equippedTool(session)?.kind !== 'physgun') {
            session.grabbing = false
            if (session.held) this.releaseHeld(session)
          }
        }
        break
      case 'editmode': {
        // Rank-gated noclip build mode. The flag lives in the move state so
        // server sim and client prediction stay in lockstep via the normal
        // self-state replication path.
        if (session.rank === 'owner' || session.rank === 'admin') {
          session.move.noclip = msg.on
          session.move.vel.x = 0
          session.move.vel.y = 0
          session.move.vel.z = 0
          this.send(session, {
            t: 'announce',
            text: msg.on ? '🛠 Edit mode ON — noclip flight' : '🛠 Edit mode OFF',
          })
        }
        break
      }
      case 'physgun':
        this.handlePhysgun(session, msg)
        break
      case 'drink': {
        if (this.tick - session.lastUseTick < 15) break
        const ground = terrainHeight(
          this.world.content.world,
          session.move.pos.x,
          session.move.pos.z,
        )
        if (ground > WATER_LEVEL - 0.03) {
          this.send(session, { t: 'result', action: 'consume', ok: false, error: 'no_water' })
          break
        }
        session.lastUseTick = this.tick
        session.stats.thirst = Math.min(100, session.stats.thirst + 30)
        session.statsDirty = true
        session.dirty = true
        this.send(session, { t: 'result', action: 'consume', ok: true })
        this.send(session, { t: 'stats', ...this.statsWire(session) })
        session.statsDirty = false
        break
      }
      case 'consume': {
        const stack = session.inventory.get(msg.slot)
        const food = stack ? this.world.content.item(stack.defId)?.food : undefined
        if (!stack || !food) {
          this.send(session, { t: 'result', action: 'consume', ok: false, error: 'not_food' })
          break
        }
        session.inventory.removeFromSlot(msg.slot, 1)
        eat(session.stats, food)
        session.statsDirty = true
        session.dirty = true
        this.send(session, { t: 'result', action: 'consume', ok: true })
        this.sendInventory(session)
        break
      }
      case 'trade': {
        const trade = TRADES.find((t) => t.id === msg.trade)
        if (!trade) {
          this.send(session, { t: 'result', action: 'trade', ok: false, error: 'no_such_trade' })
          break
        }
        // Must be standing at a trading post.
        let nearShop = false
        for (const e of this.world.entities.ofKind('prop')) {
          if (!e.prop || !this.world.content.item(e.prop.defId)?.shop) continue
          const d = Math.hypot(
            e.transform.pos.x - session.move.pos.x,
            e.transform.pos.z - session.move.pos.z,
          )
          if (d < 5) {
            nearShop = true
            break
          }
        }
        if (!nearShop) {
          this.send(session, { t: 'result', action: 'trade', ok: false, error: 'no_merchant' })
          break
        }
        if (session.inventory.countOf(trade.give.item) < trade.give.count) {
          this.send(session, { t: 'result', action: 'trade', ok: false, error: 'missing_items' })
          break
        }
        if (!session.inventory.canFit(trade.get.item, trade.get.count)) {
          this.send(session, { t: 'result', action: 'trade', ok: false, error: 'inventory_full' })
          break
        }
        const consumed = session.inventory.consume([
          { item: trade.give.item, count: trade.give.count },
        ])
        if (!consumed.ok) {
          this.send(session, { t: 'result', action: 'trade', ok: false, error: 'missing_items' })
          break
        }
        session.inventory.add(trade.get.item, trade.get.count)
        session.dirty = true
        this.send(session, { t: 'result', action: 'trade', ok: true })
        this.sendInventory(session)
        break
      }
      case 'container_open': {
        const entity = this.world.entities.get(msg.target as EntityId)
        const denied = this.containerAccessDenied(session, entity)
        if (denied || !entity?.prop?.container) {
          this.send(session, {
            t: 'result',
            action: 'container',
            ok: false,
            error: denied ?? 'no_container',
          })
          break
        }
        session.openContainer = entity.id
        this.sendContainer(session, entity)
        break
      }
      case 'container_move': {
        const entity = this.world.entities.get(msg.target as EntityId)
        const denied = this.containerAccessDenied(session, entity)
        const box = entity?.prop?.container
        if (denied || !entity || !box) {
          this.send(session, {
            t: 'result',
            action: 'container',
            ok: false,
            error: denied ?? 'no_container',
          })
          break
        }
        let ok = false
        if (msg.dir === 'in') {
          const stack = session.inventory.get(msg.slot)
          if (stack) {
            const moved = this.containerAdd(box, stack.defId, stack.count)
            if (moved > 0) {
              session.inventory.removeFromSlot(msg.slot, moved)
              ok = true
            }
          }
        } else {
          const slot = box[msg.slot]
          if (slot) {
            const leftover = session.inventory.add(slot.defId, slot.count)
            const moved = slot.count - leftover
            if (moved > 0) {
              slot.count -= moved
              if (slot.count <= 0) box[msg.slot] = null
              ok = true
            }
          }
        }
        if (ok) {
          entity.dirty = true
          session.dirty = true
          this.sendInventory(session)
          // Push fresh contents to EVERYONE with this container open.
          for (const other of this.sessions.values()) {
            if (other.openContainer === entity.id) this.sendContainer(other, entity)
          }
        } else {
          this.send(session, { t: 'result', action: 'container', ok: false, error: 'no_space' })
        }
        break
      }
    }
  }

  /** Range + prop-protection gate shared by all container operations. */
  private containerAccessDenied(
    session: PlayerSession,
    entity: GameEntity | undefined,
  ): string | null {
    if (!entity?.prop) return 'no_target'
    const d = Math.hypot(
      entity.transform.pos.x - session.move.pos.x,
      entity.transform.pos.y - session.move.pos.y,
      entity.transform.pos.z - session.move.pos.z,
    )
    if (d > 4.5) return 'out_of_range'
    if (!this.canManipulate(session, entity)) return 'not_owner'
    return null
  }

  /** Adds to a container with stacking; returns how many items fit. */
  private containerAdd(
    box: ({ defId: string; count: number } | null)[],
    defId: string,
    count: number,
  ): number {
    const maxStack = this.world.content.item(defId)?.maxStack ?? 1
    let left = count
    for (const slot of box) {
      if (left <= 0) break
      if (slot && slot.defId === defId && slot.count < maxStack) {
        const take = Math.min(maxStack - slot.count, left)
        slot.count += take
        left -= take
      }
    }
    for (let i = 0; i < box.length && left > 0; i++) {
      if (!box[i]) {
        const take = Math.min(maxStack, left)
        box[i] = { defId, count: take }
        left -= take
      }
    }
    return count - left
  }

  private sendContainer(session: PlayerSession, entity: GameEntity): void {
    const box = entity.prop?.container ?? []
    this.send(session, {
      t: 'container',
      id: entity.id,
      size: box.length,
      slots: box.flatMap((slot, i) => (slot ? [{ i, def: slot.defId, count: slot.count }] : [])),
    })
  }

  /** Live supply crate (one at a time), plus its expiry tick. */
  private supplyCrateId: EntityId | null = null
  private supplyExpiresTick = 0
  private nextDropTick = 0

  /**
   * Extraction events v1: every few minutes a supply crate lands at a random
   * wilderness site, announced to everyone. First to loot it wins; the
   * crate despawns once emptied (or after 6 minutes).
   */
  private tickSupplyDrops(): void {
    const rate = this.config.tickRate
    if (this.nextDropTick === 0) this.nextDropTick = this.tick + 150 * rate
    // Expire or clean up the live crate.
    if (this.supplyCrateId) {
      const crate = this.world.entities.get(this.supplyCrateId)
      const emptied = !crate?.prop?.container?.some((s) => s !== null)
      if (!crate || emptied || this.tick >= this.supplyExpiresTick) {
        if (crate) {
          this.world.despawn(crate.id)
          this.broadcastDespawn(crate.id)
        }
        this.supplyCrateId = null
      }
      return
    }
    if (this.tick < this.nextDropTick || this.sessions.size === 0) return
    this.nextDropTick = this.tick + 360 * rate
    const site = DROP_SITES[Math.floor(Math.random() * DROP_SITES.length)]!
    const world = this.world.content.world
    const crate = this.world.spawnProp({
      defId: 'supply_crate',
      pos: vec3(site[0], terrainHeight(world, site[0], site[2]) + 0.6, site[2]),
      rot: qfromYaw(quat(), Math.random() * 6.28),
      motion: 'static',
    })
    crate.persistent = false
    if (crate.prop?.container) {
      let slot = 0
      for (const [item, min, max] of DROP_LOOT) {
        const count = min + Math.floor(Math.random() * (max - min + 1))
        if (count > 0 && slot < crate.prop.container.length) {
          crate.prop.container[slot++] = { defId: item, count }
        }
      }
    }
    this.supplyCrateId = crate.id
    this.supplyExpiresTick = this.tick + 360 * rate
    this.broadcastSpawn(crate)
    this.broadcastAll({
      t: 'announce',
      text: '📦 Supply drop spotted in the wilds — first come, first served!',
    })
    this.log.info('supply drop spawned', { site: site.join(',') })
  }

  private dayFraction(): number {
    // 20-minute shared day/night cycle anchored to server uptime.
    return (this.tick / this.config.tickRate / 1200 + 0.34) % 1
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

  private async handleHello(conn: GameConnection, msg: ClientHello): Promise<void> {
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

    const slot = msg.slot ?? 0
    // Account resolution. hobo.tools sign-in keys the account on the SSO
    // identity (3 slots, follows you across devices). Guests get ONE
    // character bound to their connection: browser token first, IP as the
    // recovery path when the token is gone.
    let token = msg.token
    let rank: 'owner' | 'admin' | 'moderator' | null = null
    if (msg.auth) {
      const user = await resolveHoboToolsUser(this.config.hoboToolsAuthUrl, msg.auth)
      if (!user) {
        conn.send(encodeServerMessage({ t: 'reject', reason: 'auth_failed' }))
        conn.close(4009, 'auth_failed')
        return
      }
      token = `hobotools:${user.id}`.slice(0, 64)
      rank = user.rank
    } else {
      if (slot > 0) {
        conn.send(encodeServerMessage({ t: 'reject', reason: 'guest_one_character' }))
        conn.close(4010, 'guest_one_character')
        return
      }
      if (this.config.guestIpBinding && conn.ip !== 'unknown') {
        token = this.store.guests.resolve(conn.ip, msg.token)
      }
    }
    const existing = this.store.players.findByTokenSlot(token, slot)
    // One live session per CHARACTER; other characters of the same account
    // may stay online (an account still only plays one at a time in
    // practice — same token kicks apply per slot).
    for (const s of this.sessions.values()) {
      if (s.token === token && s.charSlot === slot) {
        s.closeConnection(4004, 'session_superseded')
      }
    }

    const world = this.world.content.world
    const playerId = existing ? asPlayerId(existing.id) : newPlayerId()
    const mapSpawn = worldSpawn(world)
    const spawn = existing
      ? vec3(existing.pos[0], existing.pos[1], existing.pos[2])
      : vec3(mapSpawn.pos[0], mapSpawn.pos[1], mapSpawn.pos[2])
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
      charSlot: slot,
      entityId: newEntityId(),
      token,
      rank,
      name: msg.name,
      spawn,
      yaw: existing?.yaw ?? mapSpawn.yaw,
      inventory,
      skills,
      friends,
      appearance,
      stats: existing?.stats ?? undefined,
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
      collidesWith: CollisionLayer.Static | CollisionLayer.Prop | CollisionLayer.Player,
    })
    this.playerBodies.set(playerId, bodyId)

    this.send(session, {
      t: 'welcome',
      v: PROTOCOL_VERSION,
      rank,
      playerId: playerId as string,
      entityId: session.entityId as string,
      tick: this.tick,
      tickRate: this.config.tickRate,
      snapshotRate: this.config.tickRate / this.config.snapshotEvery,
    })
    this.sendInventory(session)
    this.sendSkills(session)
    this.sendFriends(session)
    this.send(session, { t: 'time', frac: this.dayFraction() })
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
      // Beam on: even with nothing under the crosshair, keep trying each
      // tick — sweeping the beam onto a prop picks it up (GMod behavior).
      session.grabbing = true
      const denied = this.attemptGrab(session)
      // Only meaningful denials are surfaced; an empty beam is not an error.
      if (denied && denied !== 'no_target') {
        this.send(session, { t: 'result', action: 'physgun', ok: false, error: denied })
      }
    } else if (msg.a === 'release') {
      session.grabbing = false
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
      // Freezing ends the beam — otherwise the sweep-to-grab retry would
      // immediately unfreeze what was just frozen.
      session.grabbing = false
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

  /** One grab attempt down the view ray; latches + broadcasts on success. */
  private attemptGrab(session: PlayerSession): string | null {
    const grabbed = tryGrab(session, this.world, this.heldEntityIds, (e) =>
      this.canManipulate(session, e),
    )
    if (typeof grabbed === 'string') return grabbed
    this.heldEntityIds.add(grabbed.id)
    // Grabbing a frozen prop unfreezes it — tell clients about the motion
    // change (physics resumes; frozen visuals must clear).
    this.broadcastToKnowing(grabbed.id, { t: 'entity', id: grabbed.id, motion: 'dynamic' })
    const grab = session.held?.localOffset
    this.broadcastAll({
      t: 'physgun_state',
      player: session.entityId,
      target: grabbed.id,
      ...(grab ? { grab: [grab.x, grab.y, grab.z] as [number, number, number] } : {}),
    })
    return null
  }

  private releaseHeld(session: PlayerSession): void {
    if (!session.held) return
    // Wake the released body: if it was driven into a sleeping neighbor,
    // the depenetration solver needs it active to push them apart.
    const bodyId = this.world.bodyOf(session.held.entityId)
    if (bodyId !== undefined) {
      this.world.physics.wake(bodyId)
      // Source-feel throw cap: the drive can move props at 45 m/s, but a
      // LET-GO should toss, not rocket-launch. Clamp exit velocity.
      this.world.physics.getLinearVelocity(bodyId, _relVel)
      const speed = Math.hypot(_relVel.x, _relVel.y, _relVel.z)
      const cap = 9
      if (speed > cap) {
        const k = cap / speed
        _relVel.x *= k
        _relVel.y *= k
        _relVel.z *= k
        this.world.physics.setLinearVelocity(bodyId, _relVel)
      }
    }
    this.heldEntityIds.delete(session.held.entityId)
    release(session)
    this.broadcastAll({ t: 'physgun_state', player: session.entityId, target: null })
  }

  /** Melee swing on another player: range + zone PvP rules + tool damage. */
  private handleMelee(attacker: PlayerSession, victim: PlayerSession): void {
    const d = Math.hypot(
      victim.move.pos.x - attacker.move.pos.x,
      victim.move.pos.y - attacker.move.pos.y,
      victim.move.pos.z - attacker.move.pos.z,
    )
    const tool = equippedTool(attacker)
    if (tool?.kind === 'physgun') {
      this.send(attacker, { t: 'result', action: 'use', ok: false, error: 'not_a_weapon' })
      return
    }
    // ANY held item swings; weapon capability > tool power > improvised.
    const heldDef = attacker.holstered
      ? undefined
      : this.world.content.item(attacker.inventory.get(attacker.activeHotbar)?.defId ?? '')
    const weapon = heldDef?.weapon
    const range = weapon?.range ?? (tool ? Math.min(tool.range, 3.5) : 2.4)
    if (d > range) {
      this.send(attacker, { t: 'result', action: 'use', ok: false, error: 'out_of_range' })
      return
    }
    // PvP must be legal where BOTH players stand (no shooting into the city).
    if (
      !this.world.zones.rulesAt(attacker.move.pos).pvp ||
      !this.world.zones.rulesAt(victim.move.pos).pvp
    ) {
      this.send(attacker, { t: 'result', action: 'use', ok: false, error: 'safe_zone' })
      return
    }
    attacker.lastUseTick = this.tick
    // Swinging costs stamina; an exhausted swing lands soft.
    const exhausted = attacker.stats.stamina < 10
    attacker.stats.stamina = Math.max(0, attacker.stats.stamina - 12)
    attacker.statsDirty = true
    const base = weapon?.damage ?? (tool ? 6 + tool.power * 4 : heldDef ? 5 : 6)
    const damage = base * (exhausted ? 0.5 : 1)
    // Knockback: shove the victim away (replicates through prediction).
    const kx = victim.move.pos.x - attacker.move.pos.x
    const kz = victim.move.pos.z - attacker.move.pos.z
    const kl = Math.hypot(kx, kz) || 1
    victim.move.vel.x += (kx / kl) * 4.5
    victim.move.vel.z += (kz / kl) * 4.5
    victim.move.vel.y += 2.2
    const died = applyDamage(victim.stats, damage)
    victim.statsDirty = true
    victim.dirty = true
    this.send(attacker, { t: 'result', action: 'use', ok: true })
    // Everyone nearby sees the flinch (or the drop).
    this.broadcastToKnowing(victim.entityId, {
      t: 'fx',
      kind: died ? 'death' : 'hurt',
      id: victim.entityId as string,
    })
    if (died) {
      this.log.info('player killed', {
        victim: victim.playerId,
        attacker: attacker.playerId,
      })
      this.respawn(victim, true)
    }
  }

  /** Death/rescue respawn: back to the city with restored vitals. */
  private respawn(session: PlayerSession, died: boolean): void {
    const spawn = worldSpawn(this.world.content.world).pos
    session.move.pos.x = spawn[0]
    session.move.pos.y = spawn[1]
    session.move.pos.z = spawn[2]
    session.move.vel.x = 0
    session.move.vel.y = 0
    session.move.vel.z = 0
    if (died) {
      session.stats.health = 60
      session.stats.hunger = Math.max(session.stats.hunger, 40)
      session.stats.thirst = Math.max(session.stats.thirst, 40)
      session.statsDirty = true
      this.send(session, { t: 'stats', ...this.statsWire(session), died: true })
      session.statsDirty = false
    }
    session.dirty = true
  }

  private statsWire(session: PlayerSession) {
    return {
      hp: Math.round(session.stats.health),
      hunger: Math.round(session.stats.hunger),
      thirst: Math.round(session.stats.thirst),
      stamina: Math.round(session.stats.stamina),
    }
  }

  // ── Simulation tick ────────────────────────────────────────────────

  step(): void {
    const tickStart = performance.now()
    this.tick++

    // 1. Movement from queued inputs (server-simulated, never client positions).
    for (const session of this.sessions.values()) {
      this.stepSessionMovement(session)
    }

    // 2. Physgun: retry unlatched beams (sweep-to-grab), drive held bodies.
    for (const session of this.sessions.values()) {
      if (session.grabbing && !session.held && equippedTool(session)?.kind === 'physgun') {
        this.attemptGrab(session)
      }
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

    // 6. Once a second: survival vitals, void rescue, world clock sync.
    if (this.tick % this.config.tickRate === 0) {
      for (const session of this.sessions.values()) {
        const sprinting =
          (session.buttons & Buttons.Sprint) !== 0 &&
          Math.hypot(session.move.vel.x, session.move.vel.z) > 1
        const before = { ...session.stats }
        const died = tickSurvival(session.stats, 1, sprinting)
        if (
          Math.round(before.health) !== Math.round(session.stats.health) ||
          Math.round(before.hunger) !== Math.round(session.stats.hunger) ||
          Math.round(before.thirst) !== Math.round(session.stats.thirst) ||
          Math.round(before.stamina) !== Math.round(session.stats.stamina)
        ) {
          session.statsDirty = true
        }
        if (died) {
          this.log.info('player died of exposure', { playerId: session.playerId })
          this.respawn(session, true)
        } else if (session.statsDirty) {
          this.send(session, { t: 'stats', ...this.statsWire(session) })
          session.statsDirty = false
          session.dirty = true
        }
        if (session.move.pos.y < -25) {
          this.respawn(session, false)
          this.log.info('void rescue', { playerId: session.playerId })
        }
      }
      if (this.tick % (this.config.tickRate * 10) === 0) {
        this.broadcastAll({ t: 'time', frac: this.dayFraction() })
      }
      this.tickSupplyDrops()
    }

    // 7. Resource respawn sweep (once a second).
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
    this.sweepSelf = this.playerBodies.get(session.playerId)
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
      // Zero MOVEMENT only — buttons stay held. Zeroing buttons fabricates
      // release edges for toggle keys (prone/crouch), so any client hitch
      // longer than 3 ticks made the server flap stances endlessly.
      const input =
        session.starvedTicks <= 3 ? session.lastInput : { ...session.lastInput, moveX: 0, moveZ: 0 }
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
        collidesWith: CollisionLayer.Static | CollisionLayer.Prop | CollisionLayer.Player,
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
    // Fall damage: track the hardest downward velocity while airborne and
    // cash it in on landing. ~13 m/s (≈2.5 story drop) is the free threshold.
    if (!session.move.grounded) {
      session.fallVy = Math.min(session.fallVy, session.move.vel.y)
    } else if (session.fallVy < -13) {
      const dmg = Math.round((-session.fallVy - 13) * 3.5)
      session.fallVy = 0
      if (applyDamage(session.stats, dmg)) {
        this.log.info('fall death', { playerId: session.playerId })
        this.respawn(session, true)
      } else {
        session.statsDirty = true
      }
    } else {
      session.fallVy = 0
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
      charSlot: session.charSlot,
      name: session.name,
      pos: [pos.x, pos.y, pos.z],
      yaw: session.yaw,
      inventory: session.inventory.toDto(),
      skills: session.skills.toDto(),
      friends: [...session.friends],
      appearance: session.appearance,
      stats: session.stats,
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

  /** Live map edit: every client refetches and rebuilds its terrain. */
  broadcastMapReload(): void {
    this.broadcastAll({ t: 'map_reload' })
    this.broadcastAll({ t: 'announce', text: '🗺 The world was reshaped by the map editors…' })
  }

  /** Exposes crafting context for the client-facing recipe availability (welcome-time). */
  workstationsNear(session: PlayerSession): ReadonlySet<string> {
    return nearbyWorkstationKinds(session, this.world)
  }
}

const _eyeScratch = vec3()
const _relVel = vec3()
const _bodyPosScratch = vec3()
