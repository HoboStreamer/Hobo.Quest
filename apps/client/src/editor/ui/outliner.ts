/**
 * The scene graph, built from the DOCUMENT.
 *
 * Deliberately not from `scene.getNodes()`: Babylon's tree contains
 * wireframe overlays, light widgets, gizmo utility meshes, imported-model
 * hierarchies and the brush cursor, none of which are objects a user has any
 * business seeing, and it does not contain the one thing that matters — the
 * stable id. Reading the document gives exactly the authored objects, in a
 * stable order, with their identity.
 */
import type { EditorDocument, EditorObjectKind } from '../document/editorDocument.js'
import { KIND_INFO, displayName } from '../document/editorObject.js'

export interface OutlinerRow {
  id: string
  kind: EditorObjectKind
  label: string
  icon: string
  group: string
}

export interface OutlinerState {
  selected: ReadonlySet<string>
  primary: string | null
  /** object id → collaborator colour, for remote selection. */
  remote: ReadonlyMap<string, string>
  /** object id → lock owner name. */
  locks: ReadonlyMap<string, string>
  /** Editor-only visibility (the eye toggle). */
  hidden: ReadonlySet<string>
  filter: string
}

export interface OutlinerCallbacks {
  onSelect: (id: string, mode: 'replace' | 'add' | 'subtract') => void
  onFocus: (id: string) => void
  onToggleVisible: (id: string) => void
  onDelete: (id: string) => void
  onDuplicate: (id: string) => void
}

/** Group order matches the viewport's mental model, not the wire's. */
const GROUP_ORDER = ['Terrain', 'Geometry', 'Imported models', 'Gameplay', 'Lights', 'Zones']

export function buildRows(doc: EditorDocument, filter: string): OutlinerRow[] {
  const needle = filter.trim().toLowerCase()
  const rows: OutlinerRow[] = []
  for (const object of doc.list()) {
    const kind = doc.typeOf(object.id)
    if (kind === null) continue
    const info = KIND_INFO[kind]
    const label = displayName(kind, object)
    // Imported model instances read as their own category even though they
    // are statics: "Geometry" full of `Model s-3` helps nobody.
    const group =
      kind === 'static' && (object as { model?: string }).model ? 'Imported models' : info.group
    if (
      needle &&
      !label.toLowerCase().includes(needle) &&
      !object.id.toLowerCase().includes(needle)
    )
      continue
    rows.push({ id: object.id, kind, label, icon: info.icon, group })
  }
  return rows
}

export function groupRows(rows: readonly OutlinerRow[]): { group: string; rows: OutlinerRow[] }[] {
  const byGroup = new Map<string, OutlinerRow[]>()
  for (const row of rows) {
    const list = byGroup.get(row.group)
    if (list) list.push(row)
    else byGroup.set(row.group, [row])
  }
  return [...byGroup.entries()]
    .sort(([a], [b]) => {
      const ia = GROUP_ORDER.indexOf(a)
      const ib = GROUP_ORDER.indexOf(b)
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b)
    })
    .map(([group, groupRowsList]) => ({ group, rows: groupRowsList }))
}

/** Ctrl adds, Alt subtracts, a plain click replaces — same as the viewport. */
export function selectModeFor(e: {
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
}): 'replace' | 'add' | 'subtract' {
  if (e.altKey) return 'subtract'
  if (e.ctrlKey || e.metaKey) return 'add'
  return 'replace'
}

export class Outliner {
  private state: OutlinerState = {
    selected: new Set(),
    primary: null,
    remote: new Map(),
    locks: new Map(),
    hidden: new Set(),
    filter: '',
  }
  /** The rows currently in the DOM, so a refresh can patch rather than rebuild. */
  private rendered = new Map<string, HTMLElement>()

  constructor(
    private readonly root: HTMLElement,
    private readonly doc: EditorDocument,
    private readonly callbacks: OutlinerCallbacks,
  ) {}

  setFilter(filter: string): void {
    this.state = { ...this.state, filter }
    this.render()
  }

  setState(next: Partial<OutlinerState>): void {
    this.state = { ...this.state, ...next }
    // Selection/lock changes only restyle rows; no DOM rebuild.
    this.restyle()
  }

  /** Full rebuild — objects added or removed. */
  render(): void {
    const rows = buildRows(this.doc, this.state.filter)
    const groups = groupRows(rows)
    this.root.textContent = ''
    this.rendered = new Map()

    if (rows.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'outliner-empty'
      empty.textContent = this.state.filter ? 'Nothing matches that filter' : 'The map is empty'
      this.root.append(empty)
      return
    }

    for (const { group, rows: groupRowsList } of groups) {
      const header = document.createElement('div')
      header.className = 'outliner-group'
      header.textContent = `${group} (${groupRowsList.length})`
      this.root.append(header)
      for (const row of groupRowsList) this.root.append(this.renderRow(row))
    }
    this.restyle()
  }

  private renderRow(row: OutlinerRow): HTMLElement {
    const el = document.createElement('div')
    el.className = 'outliner-row'
    el.dataset['id'] = row.id
    el.tabIndex = 0

    const icon = document.createElement('span')
    icon.className = 'outliner-icon'
    icon.textContent = row.icon
    const label = document.createElement('span')
    label.className = 'outliner-label'
    label.textContent = row.label
    label.title = `${row.label} · ${row.id}`
    const badges = document.createElement('span')
    badges.className = 'outliner-badges'

    const eye = document.createElement('button')
    eye.className = 'outliner-eye'
    eye.type = 'button'
    eye.title = 'Editor-only visibility'
    eye.addEventListener('click', (e) => {
      e.stopPropagation()
      this.callbacks.onToggleVisible(row.id)
    })

    el.append(icon, label, badges, eye)
    el.addEventListener('click', (e) => this.callbacks.onSelect(row.id, selectModeFor(e)))
    el.addEventListener('dblclick', () => this.callbacks.onFocus(row.id))
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.callbacks.onFocus(row.id)
      else if (e.key === 'Delete') this.callbacks.onDelete(row.id)
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
        e.preventDefault()
        this.callbacks.onDuplicate(row.id)
      } else return
      e.preventDefault()
    })
    this.rendered.set(row.id, el)
    return el
  }

  /** Selection, remote colours and lock badges, without rebuilding rows. */
  private restyle(): void {
    for (const [id, el] of this.rendered) {
      const selected = this.state.selected.has(id)
      el.classList.toggle('selected', selected)
      el.classList.toggle('primary', this.state.primary === id)
      el.classList.toggle('hidden-object', this.state.hidden.has(id))

      const remote = this.state.remote.get(id)
      el.style.setProperty('--remote', remote ?? 'transparent')
      el.classList.toggle('remote', remote !== undefined)

      const badges = el.querySelector('.outliner-badges')
      if (!(badges instanceof HTMLElement)) continue
      const owner = this.state.locks.get(id)
      badges.textContent = owner ? '🔒' : ''
      badges.title = owner ? `Editing by ${owner}` : ''
    }
  }
}
