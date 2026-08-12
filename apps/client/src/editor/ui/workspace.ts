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

const KEY = 'hobo.editor.workspace'

export const DEFAULT_LAYOUT: WorkspaceLayout = {
  outliner: 260,
  inspector: 300,
  dock: 200,
  collapsed: { outliner: false, inspector: false, dock: false },
  dockTab: 'assets',
}

/** Below this a panel is unusable; drag past it and it collapses instead. */
const MIN_SIZE = 140
const MAX_SIDE = 560

export function loadLayout(raw: string | null): WorkspaceLayout {
  if (!raw) return structuredClone(DEFAULT_LAYOUT)
  try {
    const value: unknown = JSON.parse(raw)
    if (value === null || typeof value !== 'object') return structuredClone(DEFAULT_LAYOUT)
    const v = value as Partial<WorkspaceLayout>
    const size = (n: unknown, fallback: number, max: number): number =>
      typeof n === 'number' && Number.isFinite(n) ? Math.max(MIN_SIZE, Math.min(max, n)) : fallback
    const c = (v.collapsed ?? {}) as Record<string, unknown>
    return {
      outliner: size(v.outliner, DEFAULT_LAYOUT.outliner, MAX_SIDE),
      inspector: size(v.inspector, DEFAULT_LAYOUT.inspector, MAX_SIDE),
      dock: size(v.dock, DEFAULT_LAYOUT.dock, 600),
      collapsed: {
        outliner: c['outliner'] === true,
        inspector: c['inspector'] === true,
        dock: c['dock'] === true,
      },
      dockTab: typeof v.dockTab === 'string' ? v.dockTab : DEFAULT_LAYOUT.dockTab,
    }
  } catch {
    return structuredClone(DEFAULT_LAYOUT)
  }
}

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
export class Workspace {
  private layout: WorkspaceLayout
  private readonly listeners = new Set<(l: WorkspaceLayout) => void>()

  constructor(
    private readonly els: WorkspaceElements,
    private readonly storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage,
  ) {
    this.layout = loadLayout(safeGet(storage, KEY))
    this.apply()
  }

  get current(): WorkspaceLayout {
    return structuredClone(this.layout)
  }

  isCollapsed(panel: PanelId): boolean {
    return this.layout.collapsed[panel]
  }

  setSize(panel: PanelId, px: number): void {
    const max = panel === 'dock' ? 600 : MAX_SIDE
    // Dragging a panel below the usable minimum collapses it rather than
    // leaving a sliver you cannot read or grab.
    if (px < MIN_SIZE * 0.6) {
      this.setCollapsed(panel, true)
      return
    }
    this.layout[panel] = Math.max(MIN_SIZE, Math.min(max, px))
    this.layout.collapsed[panel] = false
    this.commit()
  }

  setCollapsed(panel: PanelId, on: boolean): void {
    this.layout.collapsed[panel] = on
    this.commit()
  }

  toggle(panel: PanelId): void {
    this.setCollapsed(panel, !this.layout.collapsed[panel])
  }

  setDockTab(tab: string): void {
    this.layout.dockTab = tab
    // Choosing a tab in a collapsed dock is a request to see it.
    this.layout.collapsed.dock = false
    this.commit()
  }

  get dockTab(): string {
    return this.layout.dockTab
  }

  subscribe(fn: (l: WorkspaceLayout) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private commit(): void {
    this.apply()
    try {
      this.storage.setItem(KEY, JSON.stringify(this.layout))
    } catch {
      // Storage being unavailable must not break the layout.
    }
    for (const l of [...this.listeners]) l(this.current)
  }

  private apply(): void {
    const l = this.layout
    const w = (panel: PanelId, px: number): string => (l.collapsed[panel] ? '0px' : `${px}px`)
    const style = this.els.root.style
    // A grid, so a collapsed column is genuinely zero-width: no negative
    // margins, no overflow, no scrollbar on the body.
    style.setProperty('--outliner-w', w('outliner', l.outliner))
    style.setProperty('--inspector-w', w('inspector', l.inspector))
    style.setProperty('--dock-h', w('dock', l.dock))
    for (const [panel, el] of [
      ['outliner', this.els.outliner],
      ['inspector', this.els.inspector],
      ['dock', this.els.dock],
    ] as const) {
      el.classList.toggle('collapsed', l.collapsed[panel])
      // Hidden panels leave the tab order too, so Tab does not wander into
      // controls nobody can see.
      el.setAttribute('aria-hidden', String(l.collapsed[panel]))
    }
  }

  /**
   * Make an element drag a panel's size. `axis` is which way the panel
   * grows; `invert` is for the inspector, whose left edge grows leftward.
   */
  attachResizer(handle: HTMLElement, panel: PanelId, axis: 'x' | 'y', invert = false): () => void {
    let start = 0
    let startSize = 0
    const move = (e: PointerEvent): void => {
      const delta = (axis === 'x' ? e.clientX - start : e.clientY - start) * (invert ? -1 : 1)
      this.setSize(panel, startSize + delta)
    }
    const up = (e: PointerEvent): void => {
      handle.releasePointerCapture(e.pointerId)
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', up)
    }
    const down = (e: PointerEvent): void => {
      if (e.button !== 0) return
      e.preventDefault()
      start = axis === 'x' ? e.clientX : e.clientY
      startSize = this.layout[panel]
      handle.setPointerCapture(e.pointerId)
      handle.addEventListener('pointermove', move)
      handle.addEventListener('pointerup', up)
    }
    handle.addEventListener('pointerdown', down)
    // Keyboard resize, because a drag handle is not reachable without a mouse.
    const keys = (e: KeyboardEvent): void => {
      const step = e.shiftKey ? 40 : 10
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp')
        this.setSize(panel, this.layout[panel] - step)
      else if (e.key === 'ArrowRight' || e.key === 'ArrowDown')
        this.setSize(panel, this.layout[panel] + step)
      else return
      e.preventDefault()
    }
    handle.addEventListener('keydown', keys)
    return () => {
      handle.removeEventListener('pointerdown', down)
      handle.removeEventListener('keydown', keys)
    }
  }
}

function safeGet(storage: Pick<Storage, 'getItem'>, key: string): string | null {
  try {
    return storage.getItem(key)
  } catch {
    return null
  }
}
