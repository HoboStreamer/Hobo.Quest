import type { Logger } from '@hobo/shared'

/**
 * Development observability: cheap counters sampled by the tick loop,
 * exposed as JSON on /metrics and summarized to the structured log
 * periodically. A real metrics backend can consume the same object later.
 */
export class ServerMetrics {
  tick = 0
  tickDurationMs = 0
  physicsMs = 0
  sessions = 0
  entities = 0
  awakeBodies = 0
  settledBodies = 0
  bytesOut = 0
  messagesOut = 0
  snapshotBytes = 0
  dbDirtyQueue = 0
  /**
   * Live map layers, by stable id. These make "Save is live" checkable from
   * outside the process: a static added in the editor must show up here on
   * the next tick, and an identical repeated save must not change the count.
   */
  mapStatics = 0
  mapTerrains = 0
  mapZones = 0
  /** Cumulative map-layer body rebuilds; identical saves must not move it. */
  mapRebuilds = 0

  private emaAlpha = 0.05

  recordTick(totalMs: number, physicsMs: number): void {
    this.tickDurationMs += (totalMs - this.tickDurationMs) * this.emaAlpha
    this.physicsMs += (physicsMs - this.physicsMs) * this.emaAlpha
  }

  snapshot(): Record<string, number> {
    return {
      tick: this.tick,
      tickDurationMs: round2(this.tickDurationMs),
      physicsMs: round2(this.physicsMs),
      sessions: this.sessions,
      entities: this.entities,
      awakeBodies: this.awakeBodies,
      settledBodies: this.settledBodies,
      bytesOut: this.bytesOut,
      messagesOut: this.messagesOut,
      dbDirtyQueue: this.dbDirtyQueue,
      mapStatics: this.mapStatics,
      mapTerrains: this.mapTerrains,
      mapZones: this.mapZones,
      mapRebuilds: this.mapRebuilds,
      memRssMb: round2(process.memoryUsage.rss() / 1024 / 1024),
    }
  }

  logSummary(log: Logger): void {
    log.info('metrics', this.snapshot())
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
