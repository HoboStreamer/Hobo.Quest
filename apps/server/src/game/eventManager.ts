import {
  DROP_LOOT,
  DROP_SITES,
  EXTRACTION_HOLD_SECONDS,
  EXTRACTION_SITES,
  terrainHeight,
} from '@hobo/content'
import { newUid, qfromYaw, quat, vec3, type EntityId, type Logger } from '@hobo/shared'
import type { GameEntity } from '@hobo/gameplay'
import type { GameWorld } from './gameWorld.js'

/**
 * Generic world events: one server-owned lifecycle —
 * scheduled → announced → active → completed/failed → cleanup —
 * with type handlers plugged in as data + callbacks. Supply drops moved
 * here from hardcoded server logic; extraction is the second citizen.
 * Event state is deliberately ephemeral: a restart cancels the party.
 */

export type EventPhase = 'scheduled' | 'announced' | 'active' | 'done'

export interface WorldEvent {
  id: string
  type: string
  x: number
  z: number
  phase: EventPhase
  /** Phase transition times (epoch ms). */
  announceAt: number
  activeAt: number
  endsAt: number
  /** Type-specific runtime state. */
  data: Record<string, unknown>
}

export interface EventHooks {
  announce(text: string): void
  announceTo(playerEntityId: string, text: string): void
  /** Players currently inside a circle: [entityId, distance][] */
  playersIn(x: number, z: number, radius: number): { entityId: string; alive: boolean }[]
  /** Secure a player's carried valuables + recall them to the city. */
  extractPlayer(entityId: string): void
  broadcastSpawn(entity: GameEntity): void
  broadcastDespawn(id: string): void
}

interface EventHandler {
  type: string
  /** Seconds between spawns of this event type. */
  intervalSeconds: number
  /** Build a new event instance (position + phase timings). */
  create(nowMs: number): Omit<WorldEvent, 'id' | 'type' | 'phase'>
  onAnnounce?(ev: WorldEvent): void
  onActivate?(ev: WorldEvent): void
  /** Called at 1 Hz while active; return true to finish early. */
  onTick?(ev: WorldEvent, nowMs: number): boolean
  onCleanup?(ev: WorldEvent): void
}

export class EventManager {
  private readonly events = new Map<string, WorldEvent>()
  private readonly handlers = new Map<string, EventHandler>()
  private readonly nextSpawnAt = new Map<string, number>()

  constructor(
    private readonly world: GameWorld,
    private readonly hooks: EventHooks,
    private readonly intervalScale: number,
    private readonly log: Logger,
  ) {
    this.register(this.supplyDropHandler())
    this.register(this.extractionHandler())
  }

  private register(handler: EventHandler): void {
    this.handlers.set(handler.type, handler)
  }

  get activeCount(): number {
    return this.events.size
  }

  /** 1 Hz driver. */
  tick(nowMs: number, playersOnline: number): void {
    // Spawn new events on their cadence (only while somebody plays).
    for (const handler of this.handlers.values()) {
      const next = this.nextSpawnAt.get(handler.type) ?? 0
      if (next === 0) {
        this.nextSpawnAt.set(
          handler.type,
          nowMs + handler.intervalSeconds * this.intervalScale * 500,
        )
        continue
      }
      if (nowMs < next || playersOnline === 0) continue
      this.nextSpawnAt.set(
        handler.type,
        nowMs + handler.intervalSeconds * this.intervalScale * 1000,
      )
      // One live event per type keeps the world legible.
      const alreadyLive = [...this.events.values()].some((e) => e.type === handler.type)
      if (alreadyLive) continue
      const base = handler.create(nowMs)
      const ev: WorldEvent = { id: newUid(), type: handler.type, phase: 'scheduled', ...base }
      this.events.set(ev.id, ev)
      this.log.info('event scheduled', { type: ev.type, x: ev.x, z: ev.z })
    }

    // Advance lifecycles.
    for (const ev of [...this.events.values()]) {
      const handler = this.handlers.get(ev.type)
      if (!handler) {
        this.events.delete(ev.id)
        continue
      }
      if (ev.phase === 'scheduled' && nowMs >= ev.announceAt) {
        ev.phase = 'announced'
        handler.onAnnounce?.(ev)
      }
      if (ev.phase === 'announced' && nowMs >= ev.activeAt) {
        ev.phase = 'active'
        handler.onActivate?.(ev)
      }
      if (ev.phase === 'active') {
        const finished = handler.onTick?.(ev, nowMs) ?? false
        if (finished || nowMs >= ev.endsAt) {
          ev.phase = 'done'
          handler.onCleanup?.(ev)
          this.events.delete(ev.id)
          this.log.info('event finished', { type: ev.type })
        }
      }
    }
  }

  // ── Supply drops (migrated from hardcoded server logic) ─────────────

  private supplyDropHandler(): EventHandler {
    return {
      type: 'supply_drop',
      intervalSeconds: 360,
      create: (nowMs) => {
        const site = DROP_SITES[Math.floor(Math.random() * DROP_SITES.length)]!
        return {
          x: site[0],
          z: site[2],
          announceAt: nowMs,
          activeAt: nowMs + 1000,
          endsAt: nowMs + 360_000,
          data: {},
        }
      },
      onAnnounce: () => {
        this.hooks.announce('📦 Supply drop spotted in the wilds — first come, first served!')
      },
      onActivate: (ev) => {
        const world = this.world.content.world
        const crate = this.world.spawnProp({
          defId: 'supply_crate',
          pos: vec3(ev.x, terrainHeight(world, ev.x, ev.z) + 0.6, ev.z),
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
        ev.data.crateId = crate.id
        this.hooks.broadcastSpawn(crate)
      },
      onTick: (ev) => {
        const crate = this.world.entities.get(ev.data.crateId as EntityId)
        // Finished once looted dry (or gone).
        return !crate || !crate.prop?.container?.some((s) => s !== null)
      },
      onCleanup: (ev) => {
        const crateId = ev.data.crateId as EntityId | undefined
        if (crateId && this.world.entities.get(crateId)) {
          this.world.despawn(crateId)
          this.hooks.broadcastDespawn(crateId)
        }
      },
    }
  }

  // ── Extraction ──────────────────────────────────────────────────────

  private extractionHandler(): EventHandler {
    return {
      type: 'extraction',
      intervalSeconds: 300,
      create: (nowMs) => {
        const site = EXTRACTION_SITES[Math.floor(Math.random() * EXTRACTION_SITES.length)]!
        return {
          x: site.pos[0],
          z: site.pos[1],
          announceAt: nowMs,
          activeAt: nowMs + 15_000,
          endsAt: nowMs + 120_000,
          data: { radius: site.radius, holders: {} },
        }
      },
      onAnnounce: (ev) => {
        this.hooks.announce(
          `🚁 Recovery bird inbound near (${Math.round(ev.x)}, ${Math.round(ev.z)}) — hold the circle to secure your haul!`,
        )
      },
      onActivate: () => {
        this.hooks.announce('🚁 The recovery bird is circling. Get inside and HOLD.')
      },
      onTick: (ev, nowMs) => {
        const radius = ev.data.radius as number
        const holders = ev.data.holders as Record<string, number>
        const inside = new Set(
          this.hooks
            .playersIn(ev.x, ev.z, radius)
            .filter((p) => p.alive)
            .map((p) => p.entityId),
        )
        // Leaving the circle (or dying) resets the countdown — no
        // dip-in-dip-out extractions, no dead extractions.
        for (const id of Object.keys(holders)) {
          if (!inside.has(id)) delete holders[id]
        }
        for (const id of inside) {
          if (holders[id] === undefined) {
            holders[id] = nowMs + EXTRACTION_HOLD_SECONDS * 1000
            this.hooks.announceTo(id, `⏱ Hold ${EXTRACTION_HOLD_SECONDS}s to extract…`)
          } else if (nowMs >= holders[id]) {
            delete holders[id]
            this.hooks.extractPlayer(id)
          }
        }
        return false // runs until endsAt
      },
      onCleanup: () => {
        this.hooks.announce('🚁 The recovery bird moves on.')
      },
    }
  }
}
