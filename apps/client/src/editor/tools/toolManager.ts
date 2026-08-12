/**
 * Which tool is active — including none.
 *
 * "No tool" used to be inexpressible: `tool` was always one of the seven, so
 * the editor was always in some mode that reacted to clicks. Pressing the
 * active tool's hotkey again did nothing, and there was no way to get back to
 * "just look at the map" short of picking a tool that happened to be
 * harmless. `Tool | null` is the fix, and it is the ONLY place tool state
 * lives: the toolbar's active class and every hotkey read from here.
 *
 * With no tool active: selection still works, navigation still works, and
 * nothing places, sculpts, paints or edits.
 */
import type { Tool } from '../catalog.js'

export type ToolChangeListener = (tool: Tool | null, previous: Tool | null) => void

export interface ToolManagerOptions {
  /**
   * Called before leaving a tool, so it can drop transient state (a
   * placement ghost, a half-finished face selection). Returning false vetoes
   * the change — used only when a gesture is genuinely mid-flight.
   */
  onLeave?: (tool: Tool) => boolean | void
  onEnter?: (tool: Tool) => void
}

export class ToolManager {
  private current: Tool | null = null
  private readonly listeners = new Set<ToolChangeListener>()

  constructor(private readonly opts: ToolManagerOptions = {}) {}

  get active(): Tool | null {
    return this.current
  }

  is(tool: Tool): boolean {
    return this.current === tool
  }

  /** Explicitly set (or clear) the tool. */
  set(next: Tool | null): void {
    if (next === this.current) return
    const previous = this.current
    if (previous !== null && this.opts.onLeave?.(previous) === false) return
    this.current = next
    if (next !== null) this.opts.onEnter?.(next)
    for (const l of [...this.listeners]) l(next, previous)
  }

  /**
   * What a toolbar button or a tool hotkey does: activate it, or — if it is
   * already active — turn it off. One control, both directions.
   */
  toggle(tool: Tool): void {
    this.set(this.current === tool ? null : tool)
  }

  /** Escape: leave whatever mode we are in. */
  clear(): void {
    this.set(null)
  }

  subscribe(listener: ToolChangeListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}
