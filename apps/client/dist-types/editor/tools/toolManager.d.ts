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
export declare class ToolManager {
  private readonly opts
  private current
  private readonly listeners
  constructor(opts?: ToolManagerOptions)
  get active(): Tool | null
  is(tool: Tool): boolean
  /** Explicitly set (or clear) the tool. */
  set(next: Tool | null): void
  /**
   * What a toolbar button or a tool hotkey does: activate it, or — if it is
   * already active — turn it off. One control, both directions.
   */
  toggle(tool: Tool): void
  /** Escape: leave whatever mode we are in. */
  clear(): void
  subscribe(listener: ToolChangeListener): () => void
}
//# sourceMappingURL=toolManager.d.ts.map
