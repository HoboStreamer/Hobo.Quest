import {
  BLEED_SECONDS,
  Buttons,
  DEFAULT_MOVEMENT,
  Inventory,
  SkillSet,
  activeStatuses,
  ambientTemperature,
  applyDamage,
  applyStatus,
  canFire,
  causesBleeding,
  clearStatus,
  completeJob,
  containerAdd,
  containerSort,
  createEnvironment,
  eat,
  hullHeightFor,
  mitigate,
  plantProgress,
  plantStage,
  precipitation,
  recordShot,
  REP_DELTAS,
  RegionTracker,
  addReputation,
  stanceToward,
  startReload,
  stepEnvironment,
  stepMovement,
  tickSurvival,
  tryStartJob,
  updatePlant,
  waterPlant,
  weaponStateFromMeta,
  weaponStateToMeta,
  type CollisionQueries,
  type DamageEvent,
  type DamageType,
  type EnvironmentState,
  type GameEntity,
  type WeatherKind,
} from '@hobo/gameplay'
import { STARTER_ITEMS, WATER_LEVEL, recipeSkill, recipeXp, terrainHeight } from '@hobo/content'
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
  v3dist,
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
  handleConstraint,
  handleCraft,
  handleDrop,
  handleInvMove,
  handlePlace,
  handleUse,
  nearbyWorkstationKinds,
} from './interactions.js'
import type { ConstraintRecord } from './gameWorld.js'
import { adjustDistance, driveHeld, freezeHeld, release, rotateHeld, tryGrab } from './physgun.js'
import {
  createSession,
  eyePosition,
  HOTBAR_SIZE,
  INVENTORY_SIZE,
  viewDirection,
  type PlayerSession,
} from './playerSession.js'
import { buildSnapshot, updateInterest, wireEntityFor } from './replication.js'
import { NpcManager } from './npcManager.js'
import { EventManager } from './eventManager.js'

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
  /** Authoritative world environment: clock, weather, temperature. */
  private readonly env: EnvironmentState
  /** Coarse activation regions (NPC LOD and event relevance hang off this). */
  readonly regions = new RegionTracker(32)
  /** Server-authoritative NPC simulation (LOD-aware). */
  readonly npcs: NpcManager
  /** Generic world events (supply drops, extraction). */
  readonly events: EventManager
  /** Players who recently attacked someone (defensive NPCs respond). */
  private readonly aggro = new Map<string, number>()
  /** Sound events (gunshots, fights) accumulated for NPC hearing. */
  private sounds: { x: number; z: number }[] = []

  constructor(
    private readonly config: ServerConfig,
    private readonly world: GameWorld,
    private readonly store: PersistenceStore,
    private readonly metrics: ServerMetrics,
    private readonly log: Logger,
  ) {
    // The world clock and weather survive restarts (a rainy dusk stays a
    // rainy dusk).
    const savedTime = Number(store.meta.get('env_time') ?? Number.NaN)
    this.env = createEnvironment(Number.isFinite(savedTime) ? savedTime : 0.34)
    const savedWeather = store.meta.get('env_weather')
    if (
      savedWeather === 'clear' ||
      savedWeather === 'cloudy' ||
      savedWeather === 'rain' ||
      savedWeather === 'storm' ||
      savedWeather === 'fog'
    ) {
      this.env.weather = savedWeather as WeatherKind
    }
    this.npcs = new NpcManager(
      world,
      this.regions,
      {
        onAttackPlayer: (npcId, playerEntityId, damage) => {
          const victim = this.sessionsByEntity.get(playerEntityId as EntityId)
          const npcEntity = this.world.entities.get(npcId)
          if (!victim || !npcEntity) return
          // NPC melee has reach limits too (no cross-map slaps).
          const d = v3dist(npcEntity.transform.pos, victim.move.pos)
          if (d > 3) return
          this.damagePlayer(null, victim, { type: 'blunt', amount: damage, sourceId: npcId })
        },
        soundsThisTick: () => this.sounds,
        hostilesNear: (x, z, radius, faction) => {
          const stance = this.world.content.faction(faction)?.playerStance ?? 'neutral'
          const nowMs = Date.now()
          const out: { id: string; x: number; z: number; hostile: boolean }[] = []
          for (const other of this.sessions.values()) {
            const dx = other.move.pos.x - x
            const dz = other.move.pos.z - z
            if (dx * dx + dz * dz > radius * radius) continue
            const aggro = (this.aggro.get(other.entityId as string) ?? 0) > nowMs
            const hostile = stance === 'hostile' || aggro
            out.push({
              id: other.entityId as string,
              x: other.move.pos.x,
              z: other.move.pos.z,
              hostile,
            })
          }
          return out
        },
      },
      log.child({ system: 'npc' }),
    )
    this.npcs.seedOrRestore(store)

    this.events = new EventManager(
      world,
      {
        announce: (text) => this.broadcastAll({ t: 'announce', text }),
        announceTo: (entityId, text) => {
          const target = this.sessionsByEntity.get(entityId as EntityId)
          if (target) this.send(target, { t: 'announce', text })
        },
        playersIn: (x, z, radius) => {
          const out: { entityId: string; alive: boolean }[] = []
          for (const s of this.sessions.values()) {
            if (Math.hypot(s.move.pos.x - x, s.move.pos.z - z) <= radius) {
              out.push({ entityId: s.entityId as string, alive: s.stats.health > 0 })
            }
          }
          return out
        },
        extractPlayer: (entityId) => this.extractPlayer(entityId),
        broadcastSpawn: (entity) => this.broadcastSpawn(entity),
        broadcastDespawn: (id) => this.broadcastDespawn(id),
      },
      config.eventIntervalScale,
      log.child({ system: 'events' }),
    )

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
      case 'attack': {
        // Swing cooldown: silently drop spam faster than ~5 swings/sec.
        if (this.tick - session.lastUseTick < 6) break
        const victimSession = this.sessionsByEntity.get(msg.target as EntityId)
        if (victimSession) {
          this.handleMelee(session, victimSession)
          break
        }
        const propTarget = this.world.entities.get(msg.target as EntityId)
        if (propTarget?.prop) {
          this.handlePropAttack(session, propTarget)
          break
        }
        if (propTarget?.kind === 'npc') {
          this.handleNpcAttack(session, propTarget)
          break
        }
        this.send(session, { t: 'result', action: 'attack', ok: false, error: 'no_target' })
        break
      }
      case 'fire': {
        this.handleFire(session)
        break
      }
      case 'reload': {
        const held = session.holstered ? null : session.inventory.get(session.activeHotbar)
        const spec = held ? this.world.content.item(held.defId)?.rangedWeapon : undefined
        if (!held || !spec) {
          this.send(session, { t: 'result', action: 'attack', ok: false, error: 'not_a_weapon' })
          break
        }
        const state = weaponStateFromMeta(held.meta)
        const available = session.inventory.countOf(spec.ammoItem)
        const took = startReload(state, spec, available, Date.now())
        if (took <= 0) {
          this.send(session, { t: 'result', action: 'attack', ok: false, error: 'no_ammo' })
          break
        }
        session.inventory.consume([{ item: spec.ammoItem, count: took }])
        held.meta = weaponStateToMeta(state, held.meta)
        session.dirty = true
        this.send(session, { t: 'result', action: 'attack', ok: true })
        this.sendInventory(session)
        break
      }
      case 'equip_armor': {
        if (msg.slot === undefined) {
          // Unequip into the first free inventory slot.
          if (!session.armor) {
            this.send(session, { t: 'result', action: 'inv_move', ok: false, error: 'no_armor' })
            break
          }
          if (!session.inventory.addStack(session.armor)) {
            this.send(session, {
              t: 'result',
              action: 'inv_move',
              ok: false,
              error: 'inventory_full',
            })
            break
          }
          session.armor = null
          session.dirty = true
          this.send(session, { t: 'result', action: 'inv_move', ok: true })
          this.sendInventory(session)
          break
        }
        const stack = session.inventory.get(msg.slot)
        const armorDef = stack ? this.world.content.item(stack.defId)?.armor : undefined
        if (!stack || !armorDef) {
          this.send(session, { t: 'result', action: 'inv_move', ok: false, error: 'not_armor' })
          break
        }
        const removed = session.inventory.removeFromSlot(msg.slot, 1)
        if (!removed) break
        // Fresh pieces get their full durability stamped into the stack.
        if (removed.meta?.dur === undefined) {
          removed.meta = { ...removed.meta, dur: armorDef.durability }
        }
        const previous = session.armor
        session.armor = removed
        if (previous) session.inventory.addStack(previous)
        session.dirty = true
        this.send(session, { t: 'result', action: 'inv_move', ok: true })
        this.sendInventory(session)
        break
      }
      case 'use': {
        // Swing cooldown: silently drop spam faster than ~5 swings/sec.
        if (this.tick - session.lastUseTick < 6) break
        const targetSession = this.sessionsByEntity.get(msg.target as EntityId)
        if (targetSession) {
          // Legacy path: melee also arrives as 'use' from older flows.
          this.handleMelee(session, targetSession)
          break
        }
        const gather = handleUse(
          session,
          this.world,
          msg,
          Date.now(),
          (e) => this.canManipulate(session, e),
          {
            nowMs: Date.now(),
            raining: precipitation(this.env) > 0,
            ambientC: ambientTemperature(this.env),
          },
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
          // Door swing / plant change / repair: pin authoritative state.
          const e = gather.changed
          const plant = e.prop?.plant
          const max = this.world.content.item(e.prop!.defId)?.health?.max
          this.broadcastToKnowing(e.id, {
            t: 'entity',
            id: e.id,
            pos: [e.transform.pos.x, e.transform.pos.y, e.transform.pos.z],
            rot: [e.transform.rot.x, e.transform.rot.y, e.transform.rot.z, e.transform.rot.w],
            plant: (() => {
              const crop = plant ? this.world.content.crop(plant.crop) : undefined
              return plant && crop
                ? { crop: plant.crop, t: plantProgress(plant, crop), water: plant.water }
                : null
            })(),
            ...(max !== undefined ? { health: Math.round(e.prop!.health ?? max) } : {}),
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
      case 'constraint': {
        const { outcome, created } = handleConstraint(session, this.world, msg, (e) =>
          this.canManipulate(session, e),
        )
        this.send(session, outcome)
        if (created) {
          this.broadcastConstraintState(created, true)
          this.sendSkills(session)
          // Rope/spring/motor constraints consume materials.
          this.sendInventory(session)
        }
        break
      }
      case 'constraint_remove': {
        const tool = equippedTool(session)
        if (tool?.kind !== 'rigging') {
          this.send(session, {
            t: 'result',
            action: 'constraint',
            ok: false,
            error: 'requires_rigging_tool',
          })
          break
        }
        const target = this.world.entities.get(msg.target as EntityId)
        if (!target?.prop) {
          this.send(session, { t: 'result', action: 'constraint', ok: false, error: 'no_target' })
          break
        }
        if (!this.canManipulate(session, target)) {
          this.send(session, { t: 'result', action: 'constraint', ok: false, error: 'not_owner' })
          break
        }
        eyePosition(session, _eyeScratch)
        if (v3dist(_eyeScratch, target.transform.pos) > (tool.range ?? 6) + 1.5) {
          this.send(session, {
            t: 'result',
            action: 'constraint',
            ok: false,
            error: 'out_of_range',
          })
          break
        }
        const removed = this.world.removeConstraintsFor(target.id)
        this.send(session, {
          t: 'result',
          action: 'constraint',
          ok: removed.length > 0,
          ...(removed.length === 0 ? { error: 'no_constraints' } : {}),
        })
        for (const rec of removed) this.broadcastConstraintState(rec, false)
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
        // A held watering can fills instead of drinking.
        const held = session.holstered ? null : session.inventory.get(session.activeHotbar)
        const fluidCap = held ? this.world.content.item(held.defId)?.fluidContainer : undefined
        if (held && fluidCap) {
          held.meta = { ...held.meta, fluid: fluidCap.capacity }
          session.dirty = true
          this.send(session, { t: 'result', action: 'consume', ok: true })
          this.sendInventory(session)
          break
        }
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
        const def = stack ? this.world.content.item(stack.defId) : undefined
        // Blueprints: using one permanently unlocks its recipe.
        if (stack && def?.blueprint) {
          if (session.unlocks.has(def.blueprint.recipe)) {
            this.send(session, {
              t: 'result',
              action: 'consume',
              ok: false,
              error: 'already_known',
            })
            break
          }
          session.inventory.removeFromSlot(msg.slot, 1)
          session.unlocks.add(def.blueprint.recipe)
          session.dirty = true
          const recipeName = this.world.content.recipe(def.blueprint.recipe)?.name ?? 'recipe'
          this.send(session, { t: 'result', action: 'consume', ok: true })
          this.send(session, { t: 'announce', text: `📜 Blueprint learned: ${recipeName}!` })
          this.sendInventory(session)
          this.sendSkills(session)
          break
        }
        if (!stack || (!def?.food && !def?.medical)) {
          this.send(session, { t: 'result', action: 'consume', ok: false, error: 'not_food' })
          break
        }
        session.inventory.removeFromSlot(msg.slot, 1)
        if (def.food) eat(session.stats, def.food, Date.now())
        if (def.medical) {
          session.stats.health = Math.min(100, session.stats.health + def.medical.heal)
          if (def.medical.curesBleeding) clearStatus(session.stats, 'bleeding')
        }
        session.statsDirty = true
        session.dirty = true
        this.send(session, { t: 'result', action: 'consume', ok: true })
        this.send(session, { t: 'stats', ...this.statsWire(session) })
        session.statsDirty = false
        this.sendInventory(session)
        break
      }
      case 'market_open':
      case 'market_buy':
      case 'market_sell': {
        this.handleMarket(session, msg)
        break
      }
      case 'job_accept':
      case 'job_turnin': {
        this.handleJob(session, msg)
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
        const maxStackOf = (defId: string) => this.world.content.item(defId)?.maxStack ?? 1
        let ok = false
        if (msg.dir === 'in') {
          const stack = session.inventory.get(msg.slot)
          if (stack) {
            const want = msg.count !== undefined ? Math.min(msg.count, stack.count) : stack.count
            const moved = containerAdd(box, stack.defId, want, maxStackOf)
            if (moved > 0) {
              session.inventory.removeFromSlot(msg.slot, moved)
              ok = true
            }
          }
        } else {
          const slot = box[msg.slot]
          if (slot) {
            const want = msg.count !== undefined ? Math.min(msg.count, slot.count) : slot.count
            const leftover = session.inventory.add(slot.defId, want)
            const moved = want - leftover
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
      case 'container_sort': {
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
        containerSort(box, (defId) => this.world.content.item(defId)?.maxStack ?? 1)
        entity.dirty = true
        this.send(session, { t: 'result', action: 'container', ok: true })
        for (const other of this.sessions.values()) {
          if (other.openContainer === entity.id) this.sendContainer(other, entity)
        }
        break
      }
    }
  }

  // ── Markets ────────────────────────────────────────────────────────

  /** Live sell-stock per market: item -> remaining + next restock time. */
  private readonly marketStock = new Map<string, Map<string, { stock: number; at: number }>>()

  /** Lazily restocked stock entry for one market sell line. */
  private stockOf(
    marketId: string,
    entry: { item: string; stock: number; restockSeconds: number },
    nowMs: number,
  ): { stock: number; at: number } {
    let market = this.marketStock.get(marketId)
    if (!market) {
      // Restore from the persisted blob once per market.
      market = new Map()
      const raw = this.store.meta.get(`market_${marketId}`)
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as Record<string, { stock: number; at: number }>
          for (const [item, s] of Object.entries(parsed)) market.set(item, s)
        } catch {
          /* corrupted blob: fall through to fresh stock */
        }
      }
      this.marketStock.set(marketId, market)
    }
    let state = market.get(entry.item)
    if (!state) {
      state = { stock: entry.stock, at: nowMs + entry.restockSeconds * 1000 }
      market.set(entry.item, state)
    }
    if (nowMs >= state.at) {
      state.stock = entry.stock
      state.at = nowMs + entry.restockSeconds * 1000
    }
    return state
  }

  private persistMarkets(): void {
    for (const [id, market] of this.marketStock) {
      this.store.meta.set(`market_${id}`, JSON.stringify(Object.fromEntries(market)))
    }
  }

  /**
   * Market interactions: open/buy/sell against the market a shop prop
   * references. Everything server-atomic: proximity, faction stance,
   * live stock, coins and space all validated here.
   */
  private handleMarket(
    session: PlayerSession,
    msg: { t: string; target: string; item?: string },
  ): void {
    const deny = (error: string) =>
      this.send(session, { t: 'result', action: 'trade', ok: false, error })
    const entity = this.world.entities.get(msg.target as EntityId)
    const marketId = entity?.prop
      ? this.world.content.item(entity.prop.defId)?.shop?.market
      : undefined
    const market = marketId ? this.world.content.market(marketId) : undefined
    if (!entity || !market) return deny('no_merchant')
    const d = Math.hypot(
      entity.transform.pos.x - session.move.pos.x,
      entity.transform.pos.z - session.move.pos.z,
    )
    if (d > 5) return deny('out_of_range')
    const faction = this.world.content.faction(market.faction)
    const stance = faction ? stanceToward(faction, session.reputation) : 'neutral'
    if (stance === 'hostile') return deny('they_hate_you')
    const nowMs = Date.now()

    if (msg.t === 'market_buy' && msg.item) {
      const entry = market.sells.find((s) => s.item === msg.item)
      if (!entry) return deny('no_such_trade')
      const state = this.stockOf(market.id, entry, nowMs)
      if (state.stock <= 0) return deny('out_of_stock')
      if (session.inventory.countOf('coin') < entry.price) return deny('missing_coins')
      if (!session.inventory.canFit(entry.item, entry.count)) return deny('inventory_full')
      const paid = session.inventory.consume([{ item: 'coin', count: entry.price }])
      if (!paid.ok) return deny('missing_coins')
      session.inventory.add(entry.item, entry.count)
      state.stock -= 1
      addReputation(session.reputation, market.faction, REP_DELTAS.trade)
      session.dirty = true
      this.send(session, { t: 'result', action: 'trade', ok: true })
      this.sendInventory(session)
      this.sendReputation(session)
    } else if (msg.t === 'market_sell' && msg.item) {
      const entry = market.buys.find((b) => b.item === msg.item)
      if (!entry) return deny('no_such_trade')
      if (session.inventory.countOf(entry.item) < entry.count) return deny('missing_items')
      if (!session.inventory.canFit('coin', entry.price)) return deny('inventory_full')
      const taken = session.inventory.consume([{ item: entry.item, count: entry.count }])
      if (!taken.ok) return deny('missing_items')
      session.inventory.add('coin', entry.price)
      addReputation(session.reputation, market.faction, REP_DELTAS.trade)
      session.dirty = true
      this.send(session, { t: 'result', action: 'trade', ok: true })
      this.sendInventory(session)
      this.sendReputation(session)
    }
    // Every path (including plain open) refreshes the market + contracts.
    this.sendJobs(session, market.id)
    this.send(session, {
      t: 'market',
      id: market.id,
      name: market.name,
      stance,
      sells: market.sells.map((s) => ({
        item: s.item,
        count: s.count,
        price: s.price,
        stock: this.stockOf(market.id, s, nowMs).stock,
      })),
      buys: market.buys.map((b) => ({ item: b.item, count: b.count, price: b.price })),
    })
  }

  /** Contract accept/turn-in at a trading post. */
  private handleJob(
    session: PlayerSession,
    msg: { t: string; target: string; job?: string },
  ): void {
    const deny = (error: string) =>
      this.send(session, { t: 'result', action: 'trade', ok: false, error })
    const entity = this.world.entities.get(msg.target as EntityId)
    const marketId = entity?.prop
      ? this.world.content.item(entity.prop.defId)?.shop?.market
      : undefined
    if (!entity || !marketId) return deny('no_merchant')
    const d = Math.hypot(
      entity.transform.pos.x - session.move.pos.x,
      entity.transform.pos.z - session.move.pos.z,
    )
    if (d > 5) return deny('out_of_range')

    if (msg.t === 'job_accept' && msg.job) {
      const job = this.world.content.job(msg.job)
      if (!job || job.market !== marketId) return deny('no_such_job')
      if (session.activeJob) return deny('job_in_progress')
      session.activeJob = { job: job.id, progress: 0 }
      session.dirty = true
      this.send(session, { t: 'result', action: 'trade', ok: true })
      this.send(session, { t: 'announce', text: `📋 Contract accepted: ${job.name}` })
    } else if (msg.t === 'job_turnin') {
      const job = session.activeJob ? this.world.content.job(session.activeJob.job) : undefined
      if (!session.activeJob || !job) return deny('no_active_job')
      if (job.market !== marketId) return deny('wrong_merchant')
      if (job.objective.kind === 'deliver') {
        const need = { item: job.objective.item, count: job.objective.count }
        if (session.inventory.countOf(need.item) < need.count) return deny('missing_items')
        const taken = session.inventory.consume([need])
        if (!taken.ok) return deny('missing_items')
      } else if (session.activeJob.progress < job.objective.count) {
        return deny('not_finished')
      }
      // Rewards: coins, reputation, items, XP — all atomic-enough (coins
      // and items overflow to the floor is prevented by canFit pre-check).
      if (job.reward.coins > 0 && !session.inventory.canFit('coin', job.reward.coins)) {
        return deny('inventory_full')
      }
      if (job.reward.coins > 0) session.inventory.add('coin', job.reward.coins)
      for (const it of job.reward.items) session.inventory.add(it.item, it.count)
      const market = this.world.content.market(marketId)
      if (job.reward.reputation !== 0 && market) {
        addReputation(session.reputation, market.faction, job.reward.reputation)
        this.sendReputation(session)
      }
      if (job.reward.xp) {
        const ups = session.skills.addXp(job.reward.xp.skill, job.reward.xp.amount)
        for (const up of ups) this.send(session, { t: 'levelup', skill: up.skill, level: up.level })
        this.sendSkills(session)
      }
      session.activeJob = null
      session.dirty = true
      this.send(session, { t: 'result', action: 'trade', ok: true })
      this.send(session, { t: 'announce', text: `✅ Contract complete: ${job.name}` })
      this.sendInventory(session)
    }
    this.sendJobs(session, marketId)
  }

  private sendJobs(session: PlayerSession, marketId: string): void {
    const active = session.activeJob
      ? (() => {
          const job = this.world.content.job(session.activeJob!.job)
          if (!job) return null
          const goal = job.objective.count
          const progress =
            job.objective.kind === 'deliver'
              ? Math.min(goal, session.inventory.countOf(job.objective.item))
              : session.activeJob!.progress
          return {
            job: job.id,
            name: job.name,
            progress,
            goal,
            ready: progress >= goal,
          }
        })()
      : null
    this.send(session, {
      t: 'jobs',
      market: marketId,
      available: this.world.content.jobsForMarket(marketId).map((j) => ({
        id: j.id,
        name: j.name,
        description: j.description,
        done: false,
      })),
      active,
    })
  }

  private sendReputation(session: PlayerSession): void {
    this.send(session, {
      t: 'reputation',
      factions: this.world.content.allFactions().map((f) => ({
        id: f.id,
        name: f.name,
        value: Math.round(session.reputation[f.id] ?? 0),
        stance: stanceToward(f, session.reputation),
      })),
    })
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

  private sendContainer(session: PlayerSession, entity: GameEntity): void {
    const box = entity.prop?.container ?? []
    this.send(session, {
      t: 'container',
      id: entity.id,
      size: box.length,
      slots: box.flatMap((slot, i) => (slot ? [{ i, def: slot.defId, count: slot.count }] : [])),
    })
  }

  private timeWire(): ServerMessage {
    return { t: 'time', frac: this.env.timeOfDay, weather: this.env.weather }
  }

  /**
   * Utility + production sweep, once a second over prop entities. Plants
   * stay timestamp-lazy (a slower cadence touches them); machines and
   * generators are few, and their jobs are timestamp-based too — this
   * sweep only notices completions/starts, it never simulates.
   */
  private tickProduction(nowMs: number, raining: boolean, ambientC: number): void {
    const content = this.world.content
    const maxStackOf = (defId: string) => content.item(defId)?.maxStack ?? 1
    // Pass 1: generators burn fuel; remember active ones for power checks.
    const activePower: { x: number; z: number; radius: number }[] = []
    for (const entity of this.world.entities.ofKind('prop')) {
      if (!entity.prop) continue
      const def = content.item(entity.prop.defId)
      if (!def?.powerProducer) continue
      if ((entity.prop.burnUntil ?? 0) <= nowMs && entity.prop.container) {
        // Reload: burn the first fuel item in the hopper.
        for (let i = 0; i < entity.prop.container.length; i++) {
          const slot = entity.prop.container[i]
          const fuel = slot ? content.item(slot.defId)?.fuel : undefined
          if (!slot || !fuel) continue
          slot.count -= 1
          if (slot.count <= 0) entity.prop.container[i] = null
          entity.prop.burnUntil =
            Math.max(nowMs, entity.prop.burnUntil ?? 0) + fuel.burnSeconds * 1000
          entity.dirty = true
          for (const other of this.sessions.values()) {
            if (other.openContainer === entity.id) this.sendContainer(other, entity)
          }
          break
        }
      }
      if ((entity.prop.burnUntil ?? 0) > nowMs) {
        activePower.push({
          x: entity.transform.pos.x,
          z: entity.transform.pos.z,
          radius: def.powerProducer.radius,
        })
      }
    }
    const powered = (x: number, z: number): boolean =>
      activePower.some((p) => Math.hypot(p.x - x, p.z - z) <= p.radius)

    // Pass 2: machines complete/start jobs (timestamp-based).
    for (const entity of this.world.entities.ofKind('prop')) {
      if (!entity.prop?.container) continue
      const def = content.item(entity.prop.defId)
      const machine = def?.machine
      if (!machine) continue
      entity.prop.machine ??= {}
      const shape = { inputSlots: machine.inputSlots, outputSlots: machine.outputSlots }
      let changed = false
      if (
        completeJob(
          entity.prop.machine,
          entity.prop.container,
          shape,
          (id) => content.recipe(id),
          maxStackOf,
          nowMs,
        )
      ) {
        changed = true
      }
      const hasPower =
        !machine.needsPower || powered(entity.transform.pos.x, entity.transform.pos.z)
      if (
        hasPower &&
        tryStartJob(
          entity.prop.machine,
          entity.prop.container,
          shape,
          content.machineRecipes(machine.kind),
          nowMs,
        )
      ) {
        changed = true
      }
      if (changed) {
        entity.dirty = true
        for (const other of this.sessions.values()) {
          if (other.openContainer === entity.id) this.sendContainer(other, entity)
        }
      }
    }

    // Pass 3 (every 5s): tanks catch rain; sprinklers water nearby planters.
    if (this.tick % (this.config.tickRate * 5) === 0) {
      const tanks: { entity: GameEntity; capacity: number }[] = []
      for (const entity of this.world.entities.ofKind('prop')) {
        const cap = entity.prop ? content.item(entity.prop.defId)?.waterTank : undefined
        if (!entity.prop || !cap) continue
        if (raining && (entity.prop.waterAmount ?? 0) < cap.capacity) {
          entity.prop.waterAmount = Math.min(cap.capacity, (entity.prop.waterAmount ?? 0) + 2.5)
          entity.dirty = true
        }
        tanks.push({ entity, capacity: cap.capacity })
      }
      for (const entity of this.world.entities.ofKind('prop')) {
        const spr = entity.prop ? content.item(entity.prop.defId)?.sprinkler : undefined
        if (!entity.prop || !spr) continue
        const tank = tanks.find(
          (t) =>
            (t.entity.prop!.waterAmount ?? 0) >= 0.5 &&
            Math.hypot(
              t.entity.transform.pos.x - entity.transform.pos.x,
              t.entity.transform.pos.z - entity.transform.pos.z,
            ) <= spr.tankRange,
        )
        if (!tank) continue
        // Planters via the spatial hash (no all-props walk per sprinkler).
        this.world.spatial.forEachInRadius(
          entity.transform.pos.x,
          entity.transform.pos.z,
          spr.radius,
          (id) => {
            const planter = this.world.entities.get(id)
            const plant = planter?.prop?.plant
            if (!planter || !plant) return
            if (
              Math.hypot(
                planter.transform.pos.x - entity.transform.pos.x,
                planter.transform.pos.z - entity.transform.pos.z,
              ) > spr.radius
            ) {
              return
            }
            const crop = content.crop(plant.crop)
            if (!crop) return
            updatePlant(plant, crop, { nowMs, raining, ambientC })
            if ((tank.entity.prop!.waterAmount ?? 0) >= 0.5 && waterPlant(plant)) {
              tank.entity.prop!.waterAmount = (tank.entity.prop!.waterAmount ?? 0) - 0.5
              tank.entity.dirty = true
              planter.dirty = true
            }
          },
        )
      }
    }

    // Pass 4 (every 15s): lazy plant advance + growth-stage broadcasts.
    if (this.tick % (this.config.tickRate * 15) !== 0) return
    for (const entity of this.world.entities.ofKind('prop')) {
      const plant = entity.prop?.plant
      if (!plant) continue
      const crop = content.crop(plant.crop)
      if (!crop) continue
      const beforeStage = plantStage(plant, crop)
      const beforeWater = plant.water
      updatePlant(plant, crop, { nowMs, raining, ambientC })
      entity.dirty = true
      const stageChanged = plantStage(plant, crop) !== beforeStage
      const driedOut = beforeWater > 0 && plant.water <= 0
      if (stageChanged || driedOut) {
        this.broadcastToKnowing(entity.id, {
          t: 'entity',
          id: entity.id,
          plant: { crop: plant.crop, t: plantProgress(plant, crop), water: plant.water },
        })
      }
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
    this.world.spatial.remove(session.entityId)
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
      armor: existing?.armor ?? null,
      reputation: existing?.reputation ?? {},
      unlocks: existing?.unlocks ?? [],
      activeJob: existing?.activeJob ?? null,
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
    this.world.spatial.insert(entity.id, session.move.pos.x, session.move.pos.z)

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
    this.send(session, this.timeWire())
    this.sendReputation(session)
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
    // Edged tools cut (can open wounds); everything else is blunt.
    const type: DamageType =
      weapon || tool?.kind === 'axe' || tool?.kind === 'pickaxe' ? 'cutting' : 'blunt'
    // Knockback: shove the victim away (replicates through prediction).
    const kx = victim.move.pos.x - attacker.move.pos.x
    const kz = victim.move.pos.z - attacker.move.pos.z
    const kl = Math.hypot(kx, kz) || 1
    victim.move.vel.x += (kx / kl) * 4.5
    victim.move.vel.z += (kz / kl) * 4.5
    victim.move.vel.y += 2.2
    this.send(attacker, { t: 'result', action: 'use', ok: true })
    this.damagePlayer(attacker, victim, { type, amount: base * (exhausted ? 0.5 : 1) })
  }

  /**
   * Ranged fire: the client sent pure intent — the shot leaves the
   * player's AUTHORITATIVE eye along their AUTHORITATIVE view (from
   * movement inputs) plus server-rolled spread. Magazine, cadence and
   * reload state live in the weapon stack's meta and are validated here.
   */
  private handleFire(session: PlayerSession): void {
    const held = session.holstered ? null : session.inventory.get(session.activeHotbar)
    const spec = held ? this.world.content.item(held.defId)?.rangedWeapon : undefined
    if (!held || !spec) {
      this.send(session, { t: 'result', action: 'attack', ok: false, error: 'not_a_weapon' })
      return
    }
    if (!this.world.zones.rulesAt(session.move.pos).pvp) {
      this.send(session, { t: 'result', action: 'attack', ok: false, error: 'safe_zone' })
      return
    }
    const nowMs = Date.now()
    const state = weaponStateFromMeta(held.meta)
    const verdict = canFire(state, spec, nowMs)
    if (verdict !== 'ok') {
      this.send(session, { t: 'result', action: 'attack', ok: false, error: verdict })
      return
    }
    recordShot(state, nowMs)
    held.meta = weaponStateToMeta(state, held.meta)
    session.dirty = true

    eyePosition(session, _eyeScratch)
    viewDirection(session, _fireDir)
    // Server-rolled spread: deflect the view ray inside the cone.
    const spread = (spec.spreadDeg * Math.PI) / 180
    const dyaw = (Math.random() * 2 - 1) * spread
    const dpitch = (Math.random() * 2 - 1) * spread
    const cosP = Math.cos(dpitch)
    const yaw = Math.atan2(_fireDir.x, _fireDir.z) + dyaw
    const pitch = Math.asin(Math.max(-1, Math.min(1, _fireDir.y))) + dpitch
    _fireDir.x = Math.sin(yaw) * Math.cos(pitch)
    _fireDir.y = Math.sin(pitch)
    _fireDir.z = Math.cos(yaw) * Math.cos(pitch)
    void cosP
    // Start past the shooter's own capsule (raycast cannot exclude bodies).
    _fireFrom.x = _eyeScratch.x + _fireDir.x * 0.6
    _fireFrom.y = _eyeScratch.y + _fireDir.y * 0.6
    _fireFrom.z = _eyeScratch.z + _fireDir.z * 0.6
    _fireTo.x = _fireFrom.x + _fireDir.x * spec.range
    _fireTo.y = _fireFrom.y + _fireDir.y * spec.range
    _fireTo.z = _fireFrom.z + _fireDir.z * spec.range
    const hit = this.world.physics.raycast(
      _fireFrom,
      _fireTo,
      CollisionLayer.Static | CollisionLayer.Prop | CollisionLayer.Player,
    )
    let end = _fireTo
    let landed = false
    if (hit) {
      end = hit.point
      // Player hit?
      let victim: PlayerSession | null = null
      for (const other of this.sessions.values()) {
        if (this.playerBodies.get(other.playerId) === hit.bodyId) {
          victim = other
          break
        }
      }
      if (victim && victim !== session) {
        if (this.world.zones.rulesAt(victim.move.pos).pvp) {
          landed = true
          this.damagePlayer(session, victim, {
            type: 'projectile',
            amount: spec.damage,
            sourceId: session.entityId as string,
          })
        }
      } else if (!victim) {
        const entity = this.world.entityOfBody(hit.bodyId)
        if (entity?.kind === 'npc') {
          landed = this.applyNpcDamage(session, entity, spec.damage)
        } else if (entity?.prop && this.world.content.item(entity.prop.defId)?.health) {
          landed = this.applyPropDamage(entity, spec.damage, 'projectile')
        }
      }
    }
    this.sounds.push({ x: session.move.pos.x, z: session.move.pos.z })
    this.send(session, { t: 'result', action: 'attack', ok: true })
    const tracer: ServerMessage = {
      t: 'tracer',
      shooter: session.entityId as string,
      from: [_fireFrom.x, _fireFrom.y, _fireFrom.z],
      to: [end.x, end.y, end.z],
      hit: landed,
    }
    const encoded = encodeServerMessage(tracer)
    for (const other of this.sessions.values()) {
      if (other === session || other.known.has(session.entityId)) this.sendRaw(other, encoded)
    }
    this.sendInventory(session)
  }

  /**
   * The one place player damage lands: armor mitigation (with durability
   * wear), wound statuses, death handling, and hit feedback. Melee, bullets
   * and future explosions all converge here.
   */
  private damagePlayer(
    attacker: PlayerSession | null,
    victim: PlayerSession,
    event: DamageEvent,
  ): void {
    const armorDef = victim.armor ? this.world.content.item(victim.armor.defId)?.armor : undefined
    const damage = mitigate(event, armorDef ? { reduction: armorDef.reduction } : null)
    // Armor wears: every mitigated hit costs a point of durability.
    if (victim.armor && armorDef && damage < event.amount) {
      const dur = Number(victim.armor.meta?.dur ?? armorDef.durability) - 1
      if (dur <= 0) {
        victim.armor = null
        this.send(victim, { t: 'announce', text: '🧥 Your armor fell apart!' })
      } else {
        victim.armor.meta = { ...victim.armor.meta, dur }
      }
      this.sendInventory(victim)
    }
    if (causesBleeding(event.type, damage)) {
      applyStatus(victim.stats, 'bleeding', BLEED_SECONDS, Date.now())
    }
    const died = applyDamage(victim.stats, damage)
    victim.statsDirty = true
    victim.dirty = true
    this.send(victim, { t: 'stats', ...this.statsWire(victim), ...(died ? { died: true } : {}) })
    victim.statsDirty = false
    this.broadcastToKnowing(victim.entityId, {
      t: 'fx',
      kind: died ? 'death' : 'hurt',
      id: victim.entityId as string,
    })
    if (died) {
      this.log.info('player killed', {
        victim: victim.playerId,
        attacker: attacker?.playerId ?? 'world',
        type: event.type,
      })
      this.respawn(victim, true)
    }
  }

  /**
   * Melee swing on a damageable prop: range + zone build rules + the same
   * stamina/cooldown economics as PvP. Structures are only destructible
   * where building is legal (safe city props are untouchable).
   */
  private handlePropAttack(attacker: PlayerSession, entity: GameEntity): void {
    const def = entity.prop ? this.world.content.item(entity.prop.defId) : undefined
    const cap = def?.health
    if (!entity.prop || !cap) {
      this.send(attacker, { t: 'result', action: 'attack', ok: false, error: 'not_damageable' })
      return
    }
    const tool = equippedTool(attacker)
    if (tool?.kind === 'physgun') {
      this.send(attacker, { t: 'result', action: 'attack', ok: false, error: 'not_a_weapon' })
      return
    }
    const heldDef = attacker.holstered
      ? undefined
      : this.world.content.item(attacker.inventory.get(attacker.activeHotbar)?.defId ?? '')
    const weapon = heldDef?.weapon
    const range = weapon?.range ?? (tool ? Math.min(tool.range, 3.5) : 2.4)
    eyePosition(attacker, _eyeScratch)
    if (v3dist(_eyeScratch, entity.transform.pos) > range + 1) {
      this.send(attacker, { t: 'result', action: 'attack', ok: false, error: 'out_of_range' })
      return
    }
    if (!this.world.zones.rulesAt(entity.transform.pos).build) {
      this.send(attacker, { t: 'result', action: 'attack', ok: false, error: 'safe_zone' })
      return
    }
    attacker.lastUseTick = this.tick
    const exhausted = attacker.stats.stamina < 10
    attacker.stats.stamina = Math.max(0, attacker.stats.stamina - 12)
    attacker.statsDirty = true
    const base = weapon?.damage ?? (tool ? 6 + tool.power * 4 : heldDef ? 5 : 6)
    this.send(attacker, { t: 'result', action: 'attack', ok: true })
    this.applyPropDamage(entity, base * (exhausted ? 0.5 : 1), 'blunt')
  }

  /** Melee swing on an NPC: reach + the shared stamina economics. */
  private handleNpcAttack(attacker: PlayerSession, entity: GameEntity): void {
    const tool = equippedTool(attacker)
    if (tool?.kind === 'physgun') {
      this.send(attacker, { t: 'result', action: 'attack', ok: false, error: 'not_a_weapon' })
      return
    }
    const heldDef = attacker.holstered
      ? undefined
      : this.world.content.item(attacker.inventory.get(attacker.activeHotbar)?.defId ?? '')
    const weapon = heldDef?.weapon
    const range = weapon?.range ?? (tool ? Math.min(tool.range, 3.5) : 2.4)
    eyePosition(attacker, _eyeScratch)
    if (v3dist(_eyeScratch, entity.transform.pos) > range + 1) {
      this.send(attacker, { t: 'result', action: 'attack', ok: false, error: 'out_of_range' })
      return
    }
    attacker.lastUseTick = this.tick
    const exhausted = attacker.stats.stamina < 10
    attacker.stats.stamina = Math.max(0, attacker.stats.stamina - 12)
    attacker.statsDirty = true
    const base = weapon?.damage ?? (tool ? 6 + tool.power * 4 : heldDef ? 5 : 6)
    this.send(attacker, { t: 'result', action: 'attack', ok: true })
    this.applyNpcDamage(attacker, entity, base * (exhausted ? 0.5 : 1))
  }

  /** NPC damage sink: aggro marking, death, loot scatter, feedback. */
  private applyNpcDamage(
    attacker: PlayerSession | null,
    entity: GameEntity,
    amount: number,
  ): boolean {
    const nowMs = Date.now()
    const result = this.npcs.damage(entity.id, amount, nowMs)
    if (result === null) return false
    // Defensive NPCs (wardens) now treat this player as hostile for a while.
    if (attacker) this.aggro.set(attacker.entityId as string, nowMs + 45_000)
    if (result === 'hurt') {
      this.broadcastToKnowing(entity.id, { t: 'fx', kind: 'hurt', id: entity.id as string })
      return true
    }
    // Death: scatter loot rolls as physical props. The entity was already
    // dematerialized; interest diffs despawn it on the next snapshot.
    const arch = this.npcs.npcStateOf(entity.id)
      ? this.world.content.npc(this.npcs.npcStateOf(entity.id)!.archetype)
      : undefined
    const around = entity.transform.pos
    this.broadcastToKnowing(entity.id, { t: 'fx', kind: 'death', id: entity.id as string })
    let slot = 0
    for (const loot of arch?.loot ?? []) {
      if (Math.random() > loot.chance) continue
      const angle = slot * 1.6
      slot++
      const spawned = this.world.spawnProp({
        defId: loot.item,
        pos: vec3(
          around.x + Math.cos(angle) * 0.4,
          around.y + 0.3,
          around.z + Math.sin(angle) * 0.4,
        ),
        rot: qfromYaw(quat(), angle),
        motion: 'dynamic',
        lootCount: loot.count,
        velocity: vec3(Math.cos(angle) * 1.2, 1.5, Math.sin(angle) * 1.2),
      })
      this.broadcastSpawn(spawned)
    }
    if (attacker && arch) {
      addReputation(attacker.reputation, arch.faction, REP_DELTAS.killMember)
      // Kill contracts count matching archetypes.
      const job = attacker.activeJob ? this.world.content.job(attacker.activeJob.job) : undefined
      if (
        attacker.activeJob &&
        job?.objective.kind === 'kill' &&
        job.objective.archetype === arch.id &&
        attacker.activeJob.progress < job.objective.count
      ) {
        attacker.activeJob.progress++
        this.send(attacker, {
          t: 'announce',
          text: `📋 ${job.name}: ${attacker.activeJob.progress}/${job.objective.count}`,
        })
        this.sendJobs(attacker, job.market)
      }
      attacker.dirty = true
      this.sendReputation(attacker)
    }
    this.log.info('npc killed', {
      archetype: arch?.id ?? 'unknown',
      by: attacker?.playerId ?? 'world',
    })
    return true
  }

  /** Damage application for props: resistance, destruction, feedback.
   * Returns false when the prop has no health capability. */
  private applyPropDamage(entity: GameEntity, rawAmount: number, _type: DamageType): boolean {
    const cap = entity.prop ? this.world.content.item(entity.prop.defId)?.health : undefined
    if (!entity.prop || !cap) return false
    if (!this.world.zones.rulesAt(entity.transform.pos).build) return false
    entity.prop.health = (entity.prop.health ?? cap.max) - rawAmount * cap.resistance
    entity.dirty = true
    if (entity.prop.health <= 0) {
      this.destroyProp(entity)
      return true
    }
    this.broadcastToKnowing(entity.id, {
      t: 'entity',
      id: entity.id,
      health: Math.round(entity.prop.health),
    })
    this.broadcastToKnowing(entity.id, { t: 'fx', kind: 'hurt', id: entity.id as string })
    return true
  }

  /** Destruction: scatter salvage + stored contents as physical props. */
  private destroyProp(entity: GameEntity): void {
    const def = entity.prop ? this.world.content.item(entity.prop.defId) : undefined
    const drops: { defId: string; count: number }[] = []
    for (const loot of def?.health?.destroyLoot ?? []) {
      drops.push({ defId: loot.item, count: loot.count })
    }
    // A destroyed container spills everything it held.
    for (const slot of entity.prop?.container ?? []) {
      if (slot) drops.push({ defId: slot.defId, count: slot.count })
    }
    const around = entity.transform.pos
    this.world.despawn(entity.id)
    this.broadcastDespawn(entity.id)
    for (const [i, drop] of drops.entries()) {
      if (!this.world.content.item(drop.defId)) continue
      const angle = (i / Math.max(drops.length, 1)) * Math.PI * 2
      const spawned = this.world.spawnProp({
        defId: drop.defId,
        pos: vec3(
          around.x + Math.cos(angle) * 0.4,
          around.y + 0.4,
          around.z + Math.sin(angle) * 0.4,
        ),
        rot: qfromYaw(quat(), angle),
        motion: 'dynamic',
        lootCount: drop.count,
        velocity: vec3(Math.cos(angle) * 1.5, 2, Math.sin(angle) * 1.5),
      })
      this.broadcastSpawn(spawned)
    }
    this.log.info('prop destroyed', { def: def?.id ?? 'unknown', drops: drops.length })
  }

  /**
   * Extraction success: carried valuables become SECURED (they no longer
   * drop on death) and the player is recalled to the safe city.
   */
  private extractPlayer(entityId: string): void {
    const session = this.sessionsByEntity.get(entityId as EntityId)
    if (!session) return
    const secured = session.inventory.secureValuables(
      (defId) => this.world.content.item(defId)?.valuable !== undefined,
    )
    const spawn = worldSpawn(this.world.content.world).pos
    session.move.pos.x = spawn[0]
    session.move.pos.y = spawn[1]
    session.move.pos.z = spawn[2]
    session.move.vel.x = 0
    session.move.vel.y = 0
    session.move.vel.z = 0
    session.dirty = true
    this.send(session, {
      t: 'announce',
      text:
        secured > 0
          ? `🚁 Extracted! ${secured} stack${secured === 1 ? '' : 's'} of loot secured.`
          : '🚁 Extracted safely back to Hoboville.',
    })
    this.sendInventory(session)
    this.log.info('player extracted', { playerId: session.playerId, secured })
  }

  /** Death/rescue respawn: back to the city with restored vitals. */
  private respawn(session: PlayerSession, died: boolean): void {
    const spawn = worldSpawn(this.world.content.world).pos
    // Risk made real: UNSECURED valuables drop where you fell, in a bag
    // anyone can loot. Secured loot and ordinary gear stay with you.
    if (died) {
      const dropped = session.inventory.takeUnsecuredValuables(
        (defId) => this.world.content.item(defId)?.valuable !== undefined,
      )
      if (dropped.length > 0) {
        const bag = this.world.spawnProp({
          defId: 'loot_bag',
          pos: vec3(session.move.pos.x, session.move.pos.y + 0.4, session.move.pos.z),
          rot: qfromYaw(quat(), session.yaw),
          motion: 'dynamic',
        })
        if (bag.prop?.container) {
          for (let i = 0; i < dropped.length && i < bag.prop.container.length; i++) {
            bag.prop.container[i] = { defId: dropped[i]!.defId, count: dropped[i]!.count }
          }
        }
        this.broadcastSpawn(bag)
        this.send(session, { t: 'announce', text: '💀 Your unsecured loot hit the dirt.' })
      }
    }
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
      temp: Math.round(session.stats.bodyTemp * 10) / 10,
      statuses: activeStatuses(session.stats, Date.now()) as string[],
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

    // 4b. NPC simulation (LOD-aware; abstract NPCs cost nothing here).
    this.npcs.step(Date.now(), this.tick, this.config.tickRate)
    if (this.tick % this.config.tickRate === 0) this.sounds = []

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

    // 6. Once a second: environment, survival vitals, void rescue, clock.
    if (this.tick % this.config.tickRate === 0) {
      const weatherBefore = this.env.weather
      stepEnvironment(this.env, 1, Math.random)
      if (this.env.weather !== weatherBefore) {
        this.broadcastAll(this.timeWire())
        this.log.info('weather changed', { from: weatherBefore, to: this.env.weather })
      }
      const ambientC = ambientTemperature(this.env)
      const raining = precipitation(this.env) > 0
      const nowMs = Date.now()
      // Region activation follows players (coarse, 1 Hz).
      this.regions.update(
        [...this.sessions.values()].map((s) => ({ x: s.move.pos.x, z: s.move.pos.z })),
      )
      for (const session of this.sessions.values()) {
        const sprinting =
          (session.buttons & Buttons.Sprint) !== 0 &&
          Math.hypot(session.move.vel.x, session.move.vel.z) > 1
        // Wet: wading/swimming, or out in the rain (no roof detection yet —
        // "indoors" arrives with the shelter model).
        const inWater =
          terrainHeight(this.world.content.world, session.move.pos.x, session.move.pos.z) <
          WATER_LEVEL - 0.03
        // Warmth: standing near a lit campfire (workstation scan; the
        // spatial index will replace this walk).
        const nearHeat = nearbyWorkstationKinds(session, this.world).has('campfire')
        const before = { ...session.stats }
        const statusesBefore = activeStatuses(session.stats, nowMs).join(',')
        const died = tickSurvival(session.stats, 1, {
          sprinting,
          ambientC,
          wet: inWater || raining,
          nearHeat,
          nowMs,
        })
        if (
          Math.round(before.health) !== Math.round(session.stats.health) ||
          Math.round(before.hunger) !== Math.round(session.stats.hunger) ||
          Math.round(before.thirst) !== Math.round(session.stats.thirst) ||
          Math.round(before.stamina) !== Math.round(session.stats.stamina) ||
          Math.round(before.bodyTemp * 2) !== Math.round(session.stats.bodyTemp * 2) ||
          activeStatuses(session.stats, nowMs).join(',') !== statusesBefore
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
        this.broadcastAll(this.timeWire())
      }
      this.events.tick(nowMs, this.sessions.size)
      this.tickProduction(nowMs, raining, ambientC)
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
    this.metrics.constraints = this.world.constraintCount
    this.metrics.constraintIslands = this.world.islands.islandCount()
    this.metrics.activeRegions = this.regions.activeRegionCount
    this.metrics.occupiedRegions = this.regions.occupiedRegionCount
    const [npcFull, npcAbstract] = this.npcs.counts()
    this.metrics.npcsFull = npcFull
    this.metrics.npcsAbstract = npcAbstract
    this.metrics.mapStatics = this.world.mapStaticCount()
    this.metrics.mapTerrains = this.world.mapTerrainCount()
    this.metrics.mapZones = this.world.mapZoneCount()
    this.metrics.mapRebuilds = this.world.mapRebuildCount()
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
    this.world.spatial.move(session.entityId, session.move.pos.x, session.move.pos.z)
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
      // Constraints touching newly-known props (visuals need endpoints).
      if (diff.entered.length > 0) {
        const sent = new Set<string>()
        for (const entity of diff.entered) {
          for (const rec of this.world.constraintsFor(entity.id)) {
            if (sent.has(rec.id)) continue
            sent.add(rec.id)
            this.send(session, constraintStateWire(rec, true))
          }
        }
      }
      const snapshot = buildSnapshot(session, this.world, this.sessions.values(), this.tick)
      const encoded = encodeServerMessage(snapshot)
      this.metrics.snapshotBytes = encoded.length
      this.sendRaw(session, encoded)
    }
  }

  // ── Persistence ────────────────────────────────────────────────────

  flush(): void {
    // World clock + weather ride along with every flush (tiny meta writes).
    this.store.meta.set('env_time', String(this.env.timeOfDay))
    this.store.meta.set('env_weather', this.env.weather)
    this.persistMarkets()
    this.npcs.flush(this.store, Date.now())
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
      armor: session.armor,
      reputation: session.reputation,
      unlocks: [...session.unlocks],
      activeJob: session.activeJob,
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
      armor: session.armor
        ? {
            def: session.armor.defId,
            count: session.armor.count,
            ...(session.armor.meta !== undefined ? { meta: session.armor.meta } : {}),
          }
        : null,
    })
  }

  private sendSkills(session: PlayerSession): void {
    this.send(session, {
      t: 'skills',
      skills: session.skills.all(),
      unlocks: [...session.unlocks],
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

  /** Constraint create/remove: tell every client that knows either prop. */
  private broadcastConstraintState(rec: ConstraintRecord, active: boolean): void {
    const msg = constraintStateWire(rec, active)
    const encoded = encodeServerMessage(msg)
    for (const session of this.sessions.values()) {
      if (session.known.has(rec.a) || session.known.has(rec.b)) {
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
const _fireDir = vec3()
const _fireFrom = vec3()
const _fireTo = vec3()

function constraintStateWire(rec: ConstraintRecord, active: boolean): ServerMessage {
  return {
    t: 'constraint_state',
    id: rec.id,
    kind: rec.type,
    a: rec.a as string,
    b: rec.b as string,
    anchorA: rec.params.anchorA ?? [0, 0, 0],
    anchorB: rec.params.anchorB ?? [0, 0, 0],
    ...(rec.params.length !== undefined ? { length: rec.params.length } : {}),
    active,
  }
}
