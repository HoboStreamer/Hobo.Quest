import type { ServerMessage, WireEntity, WireInventory } from '@hobo/protocol'
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
  disconnected: undefined
  [key: string]: unknown
}

export class ClientState {
  readonly events = new TypedEmitter<ClientStateEvents>()
  readonly entities = new Map<string, WireEntity>()
  myEntityId = ''
  tickRate = 30
  snapshotRate = 15
  serverTick = 0
  ack = 0
  inventory: WireInventory | null = null
  activeHotbar = 0
  craftJobs: { recipe: string; readyTick: number }[] = []
  /** entityId -> holder player entityId, for beam/highlight rendering. */
  readonly heldBy = new Map<string, string>()

  apply(msg: ServerMessage): void {
    switch (msg.t) {
      case 'welcome':
        this.myEntityId = msg.entityId
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
      case 'physgun_state': {
        // Clear any previous target held by this player, then set the new one.
        for (const [target, holder] of this.heldBy) {
          if (holder === msg.player) this.heldBy.delete(target)
        }
        if (msg.target) this.heldBy.set(msg.target, msg.player)
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
}
