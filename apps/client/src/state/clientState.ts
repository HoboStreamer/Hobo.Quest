import type { ServerMessage, WireEntity, WireInventory, WireSkill } from '@hobo/protocol'
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
  weldState: { a: string; b: string; active: boolean }
  friendsChanged: { id: string; name: string }[]
  disconnected: undefined
  [key: string]: unknown
}

export class ClientState {
  readonly events = new TypedEmitter<ClientStateEvents>()
  readonly entities = new Map<string, WireEntity>()
  myEntityId = ''
  myPlayerId = ''
  /** Player ids I trust with my props. */
  friends: { id: string; name: string }[] = []
  tickRate = 30
  snapshotRate = 15
  serverTick = 0
  ack = 0
  inventory: WireInventory | null = null
  activeHotbar = 0
  /** Mirrors the server's holster toggle (same deterministic rules). */
  holstered = false
  craftJobs: { recipe: string; readyTick: number }[] = []
  skills: WireSkill[] = []
  /** entityId -> holder player entityId, for beam/highlight rendering. */
  readonly heldBy = new Map<string, string>()
  /** Holder entity id -> grab point in the held body's local space. */
  readonly heldGrab = new Map<string, [number, number, number]>()

  apply(msg: ServerMessage): void {
    switch (msg.t) {
      case 'welcome':
        this.myEntityId = msg.entityId
        this.myPlayerId = msg.playerId
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
        this.events.emit('entityUpdated', e)
        break
      }
      case 'inventory':
        this.inventory = msg.inv
        this.activeHotbar = msg.activeHotbar
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
        this.events.emit('skills', msg.skills)
        break
      case 'levelup':
        this.events.emit('levelUp', { skill: msg.skill, level: msg.level })
        break
      case 'weld_state':
        this.events.emit('weldState', { a: msg.a, b: msg.b, active: msg.active })
        break
      case 'friends':
        this.friends = msg.friends
        this.events.emit('friendsChanged', msg.friends)
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
