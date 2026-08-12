/**
 * The dock's smaller panels: Assets, History, Scene and the status bar.
 *
 * They share a shape — render from state, no internal truth — so they live
 * together rather than in four files that each hold one class and an import
 * list. (Issues has its own file already; it predates the workspace and has
 * its own validation model.)
 */
import type { MapModelV2, MapTextureEntry } from '@hobo/content'
import type { HistoryState } from '../history/commandHistory.js'
import type { EditorPreferences } from '../viewport/editorPreferences.js'

// ── Assets ────────────────────────────────────────────────────────────

export interface AssetUsage {
  /** How many document objects reference this asset. */
  count: number
  ids: string[]
}

export interface AssetBrowserCallbacks {
  onUseTexture: (name: string) => void
  onPlaceModel: (id: string) => void
  onFindUsages: (ids: string[]) => void
  onDeleteTexture: (name: string) => void
  onDeleteModel: (id: string) => void
  onRenameTexture: (name: string, next: string) => void
}

export interface AssetBrowserState {
  textures: readonly MapTextureEntry[]
  models: readonly MapModelV2[]
  textureUsage: ReadonlyMap<string, AssetUsage>
  modelUsage: ReadonlyMap<string, AssetUsage>
  filter: string
  tab: 'textures' | 'models'
}

/**
 * Deleting a referenced asset is refused rather than done-and-repaired: the
 * repair would be silently retexturing objects the user did not select.
 * There is no automatic garbage collection for the same reason.
 */
export function canDeleteAsset(usage: AssetUsage | undefined): { ok: boolean; reason?: string } {
  if (!usage || usage.count === 0) return { ok: true }
  return {
    ok: false,
    reason: `used by ${usage.count} object${usage.count === 1 ? '' : 's'} — replace them first`,
  }
}

export class AssetBrowser {
  private state: AssetBrowserState = {
    textures: [],
    models: [],
    textureUsage: new Map(),
    modelUsage: new Map(),
    filter: '',
    tab: 'textures',
  }

  constructor(
    private readonly root: HTMLElement,
    private readonly callbacks: AssetBrowserCallbacks,
  ) {}

  setState(next: Partial<AssetBrowserState>): void {
    this.state = { ...this.state, ...next }
    this.render()
  }

  private render(): void {
    const { tab, filter } = this.state
    this.root.textContent = ''

    const tabs = document.createElement('div')
    tabs.className = 'asset-tabs'
    for (const name of ['textures', 'models'] as const) {
      const b = document.createElement('button')
      b.type = 'button'
      b.textContent = name
      b.className = tab === name ? 'active' : ''
      b.addEventListener('click', () => this.setState({ tab: name }))
      tabs.append(b)
    }
    this.root.append(tabs)

    const needle = filter.trim().toLowerCase()
    const list = document.createElement('div')
    list.className = 'asset-list'
    if (tab === 'textures') {
      for (const t of this.state.textures) {
        if (needle && !t.name.toLowerCase().includes(needle)) continue
        list.append(this.textureItem(t))
      }
    } else {
      for (const m of this.state.models) {
        if (needle && !m.name.toLowerCase().includes(needle)) continue
        list.append(this.modelItem(m))
      }
    }
    if (list.childElementCount === 0) {
      const empty = document.createElement('div')
      empty.className = 'asset-empty'
      empty.textContent = needle ? 'Nothing matches' : `No custom ${tab} imported yet`
      list.append(empty)
    }
    this.root.append(list)
  }

  private textureItem(t: MapTextureEntry): HTMLElement {
    const usage = this.state.textureUsage.get(`custom:${t.name}`)
    const el = document.createElement('div')
    el.className = 'asset-item'
    el.dataset['asset'] = t.name

    const thumb = document.createElement('img')
    thumb.className = 'asset-thumb'
    thumb.src = t.url ?? t.dataUrl ?? ''
    thumb.alt = ''
    const name = document.createElement('span')
    name.className = 'asset-name'
    name.textContent = t.name
    const meta = document.createElement('span')
    meta.className = 'asset-meta'
    // Content-addressed assets can be shown as shared; a legacy embedded one
    // cannot, because its bytes were never hashed.
    meta.textContent = [
      t.url ? 'hosted' : 'embedded',
      t.scale ? `${t.scale} m/tile` : null,
      `${usage?.count ?? 0} uses`,
    ]
      .filter(Boolean)
      .join(' · ')

    el.append(thumb, name, meta, this.actions('texture', t.name, usage))
    el.addEventListener('click', () => this.callbacks.onUseTexture(`custom:${t.name}`))
    return el
  }

  private modelItem(m: MapModelV2): HTMLElement {
    const usage = this.state.modelUsage.get(m.id)
    const el = document.createElement('div')
    el.className = 'asset-item'
    el.dataset['asset'] = m.id
    const name = document.createElement('span')
    name.className = 'asset-name'
    name.textContent = m.name
    const meta = document.createElement('span')
    meta.className = 'asset-meta'
    meta.textContent = [
      `${m.bounds.map((b) => b.toFixed(1)).join('×')} m`,
      m.glb.startsWith('data:') ? 'embedded' : 'hosted',
      `${usage?.count ?? 0} uses`,
    ].join(' · ')
    el.append(name, meta, this.actions('model', m.id, usage))
    el.addEventListener('click', () => this.callbacks.onPlaceModel(m.id))
    return el
  }

  private actions(
    kind: 'texture' | 'model',
    id: string,
    usage: AssetUsage | undefined,
  ): HTMLElement {
    const wrap = document.createElement('span')
    wrap.className = 'asset-actions'

    const find = document.createElement('button')
    find.type = 'button'
    find.textContent = 'Find'
    find.disabled = (usage?.count ?? 0) === 0
    find.addEventListener('click', (e) => {
      e.stopPropagation()
      this.callbacks.onFindUsages(usage?.ids ?? [])
    })

    const del = document.createElement('button')
    del.type = 'button'
    del.textContent = 'Delete'
    const verdict = canDeleteAsset(usage)
    del.disabled = !verdict.ok
    del.title = verdict.reason ?? 'Delete this asset'
    del.addEventListener('click', (e) => {
      e.stopPropagation()
      if (!verdict.ok) return
      if (kind === 'texture') this.callbacks.onDeleteTexture(id)
      else this.callbacks.onDeleteModel(id)
    })

    wrap.append(find, del)
    return wrap
  }
}

// ── History panel ─────────────────────────────────────────────────────

export interface HistoryEntryView {
  label: string
  undone: boolean
}

/**
 * A view of the ONE CommandHistory. It has no stack of its own — a second
 * undo system is exactly the bug this whole program is about.
 */
export class HistoryPanel {
  constructor(
    private readonly root: HTMLElement,
    private readonly onJump: (steps: number) => void,
  ) {}

  render(entries: readonly HistoryEntryView[], state: HistoryState): void {
    this.root.textContent = ''
    const header = document.createElement('div')
    header.className = 'history-header'
    header.textContent = `${state.depth} steps · ${state.dirty ? 'unsaved' : 'saved'}`
    this.root.append(header)

    if (entries.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'history-empty'
      empty.textContent = 'Nothing to undo yet'
      this.root.append(empty)
      return
    }

    entries.forEach((entry, i) => {
      const el = document.createElement('div')
      el.className = `history-row${entry.undone ? ' undone' : ''}`
      el.textContent = entry.label
      // Row 0 is the newest done command; clicking row N undoes N+1 steps.
      if (!entry.undone) el.addEventListener('click', () => this.onJump(-(i + 1)))
      this.root.append(el)
    })
    // The saved checkpoint, so "how far back is safe" is visible.
    const marker = this.root.children[state.depth - (state.dirty ? 0 : 0)]
    marker?.classList.add('saved-point')
  }
}

// ── Status bar ────────────────────────────────────────────────────────

export interface StatusState {
  tool: string | null
  selectionCount: number
  primary: string | null
  transformMode: string
  space: string
  snap: string
  dirty: boolean
  revision: string
  peers: number
  lock: string | null
  message: string
}

export function statusText(s: StatusState): string {
  return [
    s.tool ? `🛠 ${s.tool}` : '— no tool',
    s.selectionCount === 0
      ? 'nothing selected'
      : `${s.selectionCount} selected${s.primary ? ` · ${s.primary}` : ''}`,
    `${s.transformMode} · ${s.space}`,
    `snap ${s.snap}`,
    s.dirty ? '● unsaved' : 'saved',
    s.revision ? `rev ${s.revision.slice(0, 8)}` : 'no revision',
    s.peers > 0 ? `${s.peers} co-editor${s.peers === 1 ? '' : 's'}` : 'alone',
    s.lock ? `🔒 ${s.lock}` : null,
  ]
    .filter(Boolean)
    .join('  ·  ')
}

export class StatusBar {
  constructor(
    private readonly root: HTMLElement,
    private readonly messageEl: HTMLElement,
  ) {}

  render(state: StatusState): void {
    this.root.textContent = statusText(state)
    if (state.message) this.messageEl.textContent = state.message
  }
}

// ── Scene / environment preview ───────────────────────────────────────

export interface ScenePanelCallbacks {
  onTimeOfDay: (t: number) => void
  onPreset: (name: 'morning' | 'noon' | 'sunset' | 'night') => void
  onTogglePlay: (on: boolean) => void
  onPreferences: (next: EditorPreferences) => void
}

/**
 * Editor-only preview controls over the SHARED Environment. Deliberately not
 * a second sky system: what the editor shows must be what players see, so
 * this drives the same object the game does and stores nothing in the map.
 */
export class ScenePanel {
  constructor(
    private readonly root: HTMLElement,
    private readonly callbacks: ScenePanelCallbacks,
  ) {}

  render(prefs: EditorPreferences, timeOfDay: number, playing: boolean): void {
    this.root.textContent = ''

    this.root.append(
      row(
        'Time of day',
        slider(0, 24, 0.1, timeOfDay, (v) => this.callbacks.onTimeOfDay(v)),
      ),
      row(
        'Presets',
        buttons(['morning', 'noon', 'sunset', 'night'] as const, (name) =>
          this.callbacks.onPreset(name),
        ),
      ),
      row(
        'Day cycle',
        toggle(playing, (on) => this.callbacks.onTogglePlay(on)),
      ),
    )

    const snapRow = (
      label: string,
      key: 'translate' | 'rotate' | 'scale',
      step: number,
    ): HTMLElement =>
      row(
        label,
        span(
          toggle(prefs.snap[key].on, (on) =>
            this.callbacks.onPreferences({
              ...prefs,
              snap: { ...prefs.snap, [key]: { ...prefs.snap[key], on } },
            }),
          ),
          number(prefs.snap[key].step, step, (v) =>
            this.callbacks.onPreferences({
              ...prefs,
              snap: { ...prefs.snap, [key]: { ...prefs.snap[key], step: v } },
            }),
          ),
        ),
      )

    this.root.append(
      row(
        'Transform space',
        buttons(['world', 'local'] as const, (space) =>
          this.callbacks.onPreferences({ ...prefs, space }),
        ),
      ),
      snapRow('Move snap', 'translate', 0.25),
      snapRow('Rotate snap (°)', 'rotate', 5),
      snapRow('Scale snap', 'scale', 0.05),
      row(
        'Grid',
        span(
          toggle(prefs.grid.on, (on) =>
            this.callbacks.onPreferences({ ...prefs, grid: { ...prefs.grid, on } }),
          ),
          number(prefs.grid.size, 0.5, (size) =>
            this.callbacks.onPreferences({ ...prefs, grid: { ...prefs.grid, size } }),
          ),
        ),
      ),
    )
  }
}

// ── Small DOM helpers, shared by the panels above ─────────────────────

function row(label: string, control: HTMLElement): HTMLElement {
  const el = document.createElement('label')
  el.className = 'panel-row'
  const l = document.createElement('span')
  l.className = 'panel-label'
  l.textContent = label
  el.append(l, control)
  return el
}

function span(...children: HTMLElement[]): HTMLElement {
  const el = document.createElement('span')
  el.className = 'panel-controls'
  el.append(...children)
  return el
}

function slider(
  min: number,
  max: number,
  step: number,
  value: number,
  onInput: (v: number) => void,
): HTMLElement {
  const el = document.createElement('input')
  el.type = 'range'
  el.min = String(min)
  el.max = String(max)
  el.step = String(step)
  el.value = String(value)
  el.addEventListener('input', () => onInput(Number(el.value)))
  return el
}

function number(value: number, step: number, onChange: (v: number) => void): HTMLElement {
  const el = document.createElement('input')
  el.type = 'number'
  el.step = String(step)
  el.value = String(value)
  el.className = 'panel-number'
  el.addEventListener('change', () => {
    const v = Number(el.value)
    if (Number.isFinite(v) && v > 0) onChange(v)
    else el.value = String(value)
  })
  return el
}

function toggle(on: boolean, onChange: (on: boolean) => void): HTMLElement {
  const el = document.createElement('input')
  el.type = 'checkbox'
  el.checked = on
  el.addEventListener('change', () => onChange(el.checked))
  return el
}

function buttons<T extends string>(names: readonly T[], onPick: (name: T) => void): HTMLElement {
  const wrap = document.createElement('span')
  wrap.className = 'panel-buttons'
  for (const name of names) {
    const b = document.createElement('button')
    b.type = 'button'
    b.textContent = name
    b.addEventListener('click', () => onPick(name))
    wrap.append(b)
  }
  return wrap
}
