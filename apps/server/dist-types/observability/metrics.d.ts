import type { Logger } from '@hobo/shared'
/**
 * Development observability: cheap counters sampled by the tick loop,
 * exposed as JSON on /metrics and summarized to the structured log
 * periodically. A real metrics backend can consume the same object later.
 */
export declare class ServerMetrics {
  tick: number
  tickDurationMs: number
  physicsMs: number
  sessions: number
  entities: number
  awakeBodies: number
  settledBodies: number
  bytesOut: number
  messagesOut: number
  snapshotBytes: number
  dbDirtyQueue: number
  /**
   * Live map layers, by stable id. These make "Save is live" checkable from
   * outside the process: a static added in the editor must show up here on
   * the next tick, and an identical repeated save must not change the count.
   */
  mapStatics: number
  mapTerrains: number
  mapZones: number
  /** Cumulative map-layer body rebuilds; identical saves must not move it. */
  mapRebuilds: number
  private emaAlpha
  recordTick(totalMs: number, physicsMs: number): void
  snapshot(): Record<string, number>
  logSummary(log: Logger): void
}
//# sourceMappingURL=metrics.d.ts.map
