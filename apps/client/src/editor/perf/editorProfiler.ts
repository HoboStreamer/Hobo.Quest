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

export class EditorProfiler {
  private readonly samples = new Map<string, PerfSample>()
  /** Off by default: an unobserved counter should cost nothing. */
  private on = false

  enabled(): boolean {
    return this.on
  }

  setEnabled(on: boolean): void {
    this.on = on
  }

  count(name: string, n = 1): void {
    if (!this.on) return
    this.entry(name).count += n
  }

  /** Time a section AND count it. Returns whatever the body returns. */
  time<T>(name: string, body: () => T): T {
    if (!this.on) return body()
    const started = performance.now()
    try {
      return body()
    } finally {
      const s = this.entry(name)
      s.count++
      s.ms += performance.now() - started
    }
  }

  snapshot(): Record<string, PerfSample> {
    const out: Record<string, PerfSample> = {}
    for (const [k, v] of this.samples) out[k] = { count: v.count, ms: Math.round(v.ms * 100) / 100 }
    return out
  }

  reset(): void {
    this.samples.clear()
  }

  private entry(name: string): PerfSample {
    let s = this.samples.get(name)
    if (!s) {
      s = { count: 0, ms: 0 }
      this.samples.set(name, s)
    }
    return s
  }
}

/**
 * One profiler per page. A module-level singleton because the things worth
 * measuring (view churn, document lookups, picking) are spread across layers
 * that must not grow a constructor argument each to carry it.
 */
export const editorPerf = new EditorProfiler()
