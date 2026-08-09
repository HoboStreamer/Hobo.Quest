/**
 * Minimal typed event emitter for domain events.
 *
 * Systems communicate through typed events where decoupling is valuable
 * (e.g. gameplay -> persistence dirty marking) and direct calls where
 * ownership is obvious. Event maps are declared per domain, e.g.:
 *
 *   interface WorldEvents { entitySpawned: { id: EntityId }, ... }
 *   const events = new TypedEmitter<WorldEvents>()
 */
export type EventMap = Record<string, unknown>

export type Listener<T> = (payload: T) => void

export class TypedEmitter<E extends EventMap> {
  private listeners = new Map<keyof E, Set<Listener<never>>>()

  on<K extends keyof E>(event: K, fn: Listener<E[K]>): () => void {
    let set = this.listeners.get(event)
    if (!set) {
      set = new Set()
      this.listeners.set(event, set)
    }
    set.add(fn as Listener<never>)
    return () => this.off(event, fn)
  }

  off<K extends keyof E>(event: K, fn: Listener<E[K]>): void {
    this.listeners.get(event)?.delete(fn as Listener<never>)
  }

  emit<K extends keyof E>(event: K, payload: E[K]): void {
    const set = this.listeners.get(event)
    if (!set) return
    for (const fn of set) {
      ;(fn as Listener<E[K]>)(payload)
    }
  }

  clear(): void {
    this.listeners.clear()
  }
}
