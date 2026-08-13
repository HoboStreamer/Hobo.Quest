import type {
  ServerConstraintState,
  ServerMessage,
  WireEntity,
  WireInventory,
  WireSkill,
} from '@hobo/protocol'
import { TypedEmitter } from '@hobo/shared'

/**
 * Replicated game state as this client knows it, decoupled from both the
 * network layer (which writes it) and rendering/UI (which read it via
 * events or polling). No Babylon types in here.
 */

export interface ClientStateEvents {
  welcome: { entityId: string; tickRate: number }
  entityAdded: WireEntity
  entityRemoved: string
  entityUpdated: WireEntity
  inventory: { inv: WireInventory; activeHotbar: number }
  craftJobs: { recipe: string; readyTick: number }[]
  actionResult: { action: string; ok: boolean; error?: string }
  physgunBeam: { player: string; target: string | null }
  skills: WireSkill[]
  levelUp: { skill: string; level: number }
  constraintState: ServerConstraintState
  tracer: {
    shooter: string
    from: [number, number, number]
    to: [number, number, number]
    hit: boolean
  }
  armorChanged: undefined
  friendsChanged: { id: string; name: string }[]
  stats: {
    hp: number
    hunger: number
    thirst: number
    stamina: number
    temp: number
    statuses: string[]
    died?: boolean
  }
  timeSync: number
  weather: string
  container: { id: string; size: number; slots: { i: number; def: string; count: number }[] }
  announce: string
  market: unknown
  jobs: unknown
  reputation: { id: string; name: string; value: number; stance: string }[]
  fx: { kind: 'hurt' | 'death'; id: string }
  disconnected: undefined
  [key: string]: unknown
}

export class ClientState {
  readonly events = new TypedEmitter<ClientStateEvents>()
  readonly entities = new Map<string, WireEntity>()
  myEntityId = ''
  /** hobo.tools rank from welcome (owner/admin/moderator, null = player). */
  myRank: 'owner' | 'admin' | 'moderator' | null = null
  myPlayerId = ''
  /** Player ids I trust with my props. */
  friends: { id: string; name: string }[] = []
  tickRate = 30
  snapshotRate = 15
  serverTick = 0
  ack = 0
  inventory: WireInventory | null = null
  /** Worn armor stack (def/count/meta with dur), or null. */
  armor: { def: string; count: number; meta?: Record<string, number | string> } | null = null
  activeHotbar = 0
  /** Mirrors the server's holster toggle (same deterministic rules). */
  holstered = false
  craftJobs: { recipe: string; readyTick: number }[] = []
  skills: WireSkill[] = []
  /** Unlocked blueprint recipe ids. */
  unlocks = new Set<string>()
  /** entityId -> holder player entityId, for beam/highlight rendering. */
  readonly heldBy = new Map<string, string>()
  /** Live constraints touching entities this client knows (for visuals). */
  readonly constraints = new Map<string, ServerConstraintState>()
  /** Holder entity id -> grab point in the held body's local space. */
  readonly heldGrab = new Map<string, [number, number, number]>()
  stats = {
    hp: 100,
    hunger: 100,
    thirst: 100,
    stamina: 100,
    temp: 37,
    statuses: [] as string[],
  }
  /** Shared world clock (fraction of the day cycle). */
  dayFraction = 0.34
  /** Authoritative weather (rendering + prompts). */
  weather: 'clear' | 'cloudy' | 'rain' | 'storm' | 'fog' = 'clear'
  /** Faction standings (welcome + on change). */
  reputation: { id: string; name: string; value: number; stance: string }[] = []

  apply(msg: ServerMessage): void {
    switch (msg.t) {
      case 'welcome':
        this.myEntityId = msg.entityId
        this.myPlayerId = msg.playerId
        this.myRank = msg.rank
        this.tickRate = msg.tickRate
        this.snapshotRate = msg.snapshotRate
        this.serverTick = msg.tick
        this.events.emit('welcome', { entityId: msg.entityId, tickRate: msg.tickRate })
        break
      case 'reject':
        break
      case 'spawn':
        for (const e of msg.entities) {
          this.entities.set(e.id, e)
          this.events.emit('entityAdded', e)
        }
        break
      case 'despawn':
        for (const id of msg.ids) {
          if (this.entities.delete(id)) this.events.emit('entityRemoved', id)
          // Constraint visuals die with the props they touch; the server
          // re-sends states if the prop comes back into interest.
          for (const [cid, c] of this.constraints) {
            if (c.a === id || c.b === id) this.constraints.delete(cid)
          }
        }
        break
      case 'snap':
        this.serverTick = msg.tick
        this.ack = msg.ack
        break
      case 'entity': {
        const e = this.entities.get(msg.id)
        if (!e) break
        if (msg.motion !== undefined) e.motion = msg.motion
        if (msg.pos) e.pos = msg.pos
        if (msg.rot) e.rot = msg.rot
        if (msg.remaining !== undefined) e.remaining = msg.remaining
        if (msg.health !== undefined) e.health = msg.health
        if (msg.plant !== undefined) {
          if (msg.plant === null) delete e.plant
          else e.plant = msg.plant
        }
        this.events.emit('entityUpdated', e)
        break
      }
      case 'inventory':
        this.inventory = msg.inv
        this.activeHotbar = msg.activeHotbar
        if (msg.armor !== undefined) {
          this.armor = msg.armor
          this.events.emit('armorChanged', undefined)
        }
        this.events.emit('inventory', { inv: msg.inv, activeHotbar: msg.activeHotbar })
        break
      case 'craft_state':
        this.craftJobs = msg.jobs
        this.events.emit('craftJobs', msg.jobs)
        break
      case 'result':
        this.events.emit('actionResult', {
          action: msg.action,
          ok: msg.ok,
          ...(msg.error !== undefined ? { error: msg.error } : {}),
        })
        break
      case 'skills':
        this.skills = msg.skills
        if (msg.unlocks) this.unlocks = new Set(msg.unlocks)
        this.events.emit('skills', msg.skills)
        break
      case 'levelup':
        this.events.emit('levelUp', { skill: msg.skill, level: msg.level })
        break
      case 'constraint_state':
        if (msg.active) this.constraints.set(msg.id, msg)
        else this.constraints.delete(msg.id)
        this.events.emit('constraintState', msg)
        break
      case 'friends':
        this.friends = msg.friends
        this.events.emit('friendsChanged', msg.friends)
        break
      case 'stats':
        this.stats = {
          hp: msg.hp,
          hunger: msg.hunger,
          thirst: msg.thirst,
          stamina: msg.stamina,
          temp: msg.temp,
          statuses: msg.statuses,
        }
        this.events.emit('stats', { ...this.stats, ...(msg.died ? { died: true } : {}) })
        break
      case 'time':
        this.dayFraction = msg.frac
        if (this.weather !== msg.weather) {
          this.weather = msg.weather
          this.events.emit('weather', msg.weather)
        }
        this.events.emit('timeSync', msg.frac)
        break
      case 'tracer':
        this.events.emit('tracer', {
          shooter: msg.shooter,
          from: msg.from,
          to: msg.to,
          hit: msg.hit,
        })
        break
      case 'announce':
        this.events.emit('announce', msg.text)
        break
      case 'market':
        this.events.emit('market', msg)
        break
      case 'jobs':
        this.events.emit('jobs', msg)
        break
      case 'reputation':
        this.reputation = msg.factions
        this.events.emit('reputation', msg.factions)
        break
      case 'fx':
        this.events.emit('fx', { kind: msg.kind, id: msg.id })
        break
      case 'container':
        this.events.emit('container', { id: msg.id, size: msg.size, slots: msg.slots })
        break
      case 'physgun_state': {
        // Clear any previous target held by this player, then set the new one.
        for (const [target, holder] of this.heldBy) {
          if (holder === msg.player) this.heldBy.delete(target)
        }
        this.heldGrab.delete(msg.player)
        if (msg.target) {
          this.heldBy.set(msg.target, msg.player)
          if (msg.grab) this.heldGrab.set(msg.player, msg.grab)
        }
        this.events.emit('physgunBeam', { player: msg.player, target: msg.target })
        break
      }
    }
  }

  countOf(defId: string): number {
    if (!this.inventory) return 0
    let total = 0
    for (const s of this.inventory.slots) {
      if (s.stack.def === defId) total += s.stack.count
    }
    return total
  }

  /** Item def id in the active hotbar slot (null when holstered). */
  activeItemDef(): string | null {
    if (this.holstered) return null
    const slot = this.inventory?.slots.find((s) => s.i === this.activeHotbar)
    return slot?.stack.def ?? null
  }

  skillLevel(id: string): number {
    return this.skills.find((s) => s.id === id)?.level ?? 1
  }

  isFriend(playerId: string): boolean {
    return this.friends.some((f) => f.id === playerId)
  }

  /** Online players (from replicated player entities with identity meta). */
  onlinePlayers(): { playerId: string; name: string; entityId: string }[] {
    const players: { playerId: string; name: string; entityId: string }[] = []
    for (const e of this.entities.values()) {
      if (e.kind === 'player' && e.player) {
        players.push({ playerId: e.player, name: e.name ?? 'drifter', entityId: e.id })
      }
    }
    return players
  }
}
