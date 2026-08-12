/**
 * The workspace shell: a toolbar, three columns and a dock, all resizable,
 * collapsible and remembered.
 *
 * What it replaces: one fixed 270px sidebar overlaying the canvas, with a
 * collapse button that hid itself along with the panel. Collapsing produced
 * horizontal overflow, and the control that would have expanded it again was
 * inside the thing that had just gone. That class of bug is structural, so
 * the fix is structural: the collapse control lives in a RAIL that is always
 * present, and the layout is a grid whose columns can go to zero without the
 * body ever gaining a scrollbar.
 *
 *   +---------------------------------------------------+
 *   | Toolbar                                           |
 *   +----------+---------------------------+------------+
 *   | Outliner |          Viewport         | Inspector  |
 *   +----------+---------------------------+------------+
 *   | Assets | Issues | History | Scene    | Status     |
 *   +---------------------------------------------------+
 */
export type PanelId = 'outliner' | 'inspector' | 'dock'
export interface WorkspaceLayout {
  outliner: number
  inspector: number
  dock: number
  collapsed: Record<PanelId, boolean>
  /** Which dock tab is showing. */
  dockTab: string
}
export declare const DEFAULT_LAYOUT: WorkspaceLayout
export declare function loadLayout(raw: string | null): WorkspaceLayout
export interface WorkspaceElements {
  root: HTMLElement
  outliner: HTMLElement
  inspector: HTMLElement
  dock: HTMLElement
  viewport: HTMLElement
}
/**
 * Drives the CSS grid from the layout. The stylesheet owns appearance;
 * this owns sizes, collapse state and persistence.
 */
export declare class Workspace {
  private readonly els
  private readonly storage
  private layout
  private readonly listeners
  constructor(els: WorkspaceElements, storage?: Pick<Storage, 'getItem' | 'setItem'>)
  get current(): WorkspaceLayout
  isCollapsed(panel: PanelId): boolean
  setSize(panel: PanelId, px: number): void
  setCollapsed(panel: PanelId, on: boolean): void
  toggle(panel: PanelId): void
  setDockTab(tab: string): void
  get dockTab(): string
  subscribe(fn: (l: WorkspaceLayout) => void): () => void
  private commit
  private apply
  /**
   * Make an element drag a panel's size. `axis` is which way the panel
   * grows; `invert` is for the inspector, whose left edge grows leftward.
   */
  attachResizer(handle: HTMLElement, panel: PanelId, axis: 'x' | 'y', invert?: boolean): () => void
}
//# sourceMappingURL=workspace.d.ts.map
