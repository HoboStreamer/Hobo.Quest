/**
 * Counters and timers for the editor's hot paths.
 *
 * The point is that performance claims can be checked instead of asserted.
 * Every optimisation in the editor is justified by a number this produces on
 * a large map, and the same numbers are asserted in the E2E profile check so
 * a regression fails a gate rather than being noticed a year later.
 *
 * Counting must be cheaper than what it measures: a `Map` lookup and an add.
 * `time()` uses `performance.now()`, so it is only used around work that is
 * already at least microseconds (a serialize, a full rebuild) — never per
 * mesh.
 */
export interface PerfSample {
  count: number
  /** Total milliseconds, for timed sections only. */
  ms: number
}
export declare class EditorProfiler {
  private readonly samples
  /** Off by default: an unobserved counter should cost nothing. */
  private on
  enabled(): boolean
  setEnabled(on: boolean): void
  count(name: string, n?: number): void
  /** Time a section AND count it. Returns whatever the body returns. */
  time<T>(name: string, body: () => T): T
  snapshot(): Record<string, PerfSample>
  reset(): void
  private entry
}
/**
 * One profiler per page. A module-level singleton because the things worth
 * measuring (view churn, document lookups, picking) are spread across layers
 * that must not grow a constructor argument each to carry it.
 */
export declare const editorPerf: EditorProfiler
//# sourceMappingURL=editorProfiler.d.ts.map
