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
  private emaAlpha
  recordTick(totalMs: number, physicsMs: number): void
  snapshot(): Record<string, number>
  logSummary(log: Logger): void
}
//# sourceMappingURL=metrics.d.ts.map
