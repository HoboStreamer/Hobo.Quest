/**
 * The panels, wired to the editor's state.
 *
 * Each panel is a dumb renderer (see `outliner.ts`, `inspector.ts`,
 * `panels.ts`); this is where they learn what to show and where their
 * callbacks go. Splitting it this way is what lets the panels be tested
 * without an engine, a document or a server.
 */
import type { Environment } from '../../render/environment.js'
import { validateMapFile } from '@hobo/content'
import type { EditorDocument } from '../document/editorDocument.js'
import type { CommandHistory } from '../history/commandHistory.js'
import type { SelectionManager } from '../selection/selectionManager.js'
import type { ToolManager } from '../tools/toolManager.js'
import type { EditorViewRegistry } from '../viewport/editorViewRegistry.js'
import type { GizmoController } from '../viewport/gizmoController.js'
import type { EditorPreferences } from '../viewport/editorPreferences.js'
import type { Binding } from '../bindings.js'
import type { AssetController } from '../assets/assetController.js'
import { createSettingsPanel } from './settingsPanel.js'
import { createIssuesPanel, type EditorIssue } from './issuesPanel.js'
import { Outliner } from './outliner.js'
import { Inspector } from './inspector.js'
import { AssetBrowser, HistoryPanel, ScenePanel, StatusBar } from './panels.js'
import { Workspace } from './workspace.js'
import { TOOLS, type ShellElements } from './editorShell.js'
import type { SaveController } from '../net/saveController.js'

export interface EditorConnectionView {
  peerCount: () => number
  remoteSelectionColors: () => ReadonlyMap<string, string>
  lockOwners: () => ReadonlyMap<string, string>
  lockOwner: (id: string) => string | null
  owns: (id: string) => boolean
  connected: () => boolean
}

export interface EditorUiOptions {
  shell: ShellElements
  doc: EditorDocument
  views: EditorViewRegistry
  selection: SelectionManager
  history: CommandHistory<EditorDocument>
  tools: ToolManager
  prefs: { current: EditorPreferences }
  gizmo: GizmoController
  env: Environment
  connection: EditorConnectionView
  saveController: SaveController
  bindings: Record<string, Binding>
  bindingOf: (action: string) => Binding
  assets: AssetController
  /** Arm the placement tool with an imported model. */
  placeModel: (id: string) => void
  onPreferences: () => void
  focusObject: (id: string) => void
  deleteSelection: () => void
  duplicateSelection: () => void
  setProperty: (ids: readonly string[], key: string, value: unknown) => void
}

export interface EditorUi {
  refreshAll: () => void
  refreshSelection: () => void
  refreshInspectorValues: () => void
  refreshStatus: () => void
  refreshTools: () => void
  setMessage: (m: string) => void
  togglePanel: (panel: 'outliner' | 'inspector') => void
  showDockTab: (tab: string) => void
  openSettings: () => void
  duplicate: () => void
  remove: () => void
  setProperty: (ids: readonly string[], key: string, value: unknown) => void
}

export function createEditorUi(opts: EditorUiOptions): EditorUi {
  const { shell, doc, selection, history, tools, saveController } = opts
  let message = ''

  const workspace = new Workspace({
    root: shell.root,
    outliner: shell.outliner,
    inspector: shell.inspector,
    dock: shell.dock,
    viewport: shell.viewport,
  })

  const setMessage = (m: string): void => {
    message = m
    shell.message.textContent = m
  }

  // ── Outliner ────────────────────────────────────────────────────────
  const outlinerBody = document.getElementById('outliner-body') as HTMLElement
  const hidden = new Set<string>()
  const outliner = new Outliner(outlinerBody, doc, {
    onSelect: (id, mode) => {
      if (mode === 'add') selection.add(id)
      else if (mode === 'subtract') selection.remove(id)
      else selection.replace(id)
    },
    onFocus: (id) => opts.focusObject(id),
    onToggleVisible: (id) => {
      if (hidden.has(id)) hidden.delete(id)
      else hidden.add(id)
      opts.views.viewOf(id)?.setVisible(!hidden.has(id))
      refreshSelection()
    },
    onDelete: () => opts.deleteSelection(),
    onDuplicate: () => opts.duplicateSelection(),
  })
  shell.outlinerFilter.addEventListener('input', () =>
    outliner.setFilter(shell.outlinerFilter.value),
  )

  // ── Inspector ───────────────────────────────────────────────────────
  const inspector = new Inspector(
    shell.inspector,
    doc,
    { setProperty: (ids, key, value) => opts.setProperty(ids, key, value) },
    () => [
      { value: '', label: '— none —' },
      ...doc.textures().map((t) => ({ value: `custom:${t.name}`, label: t.name })),
    ],
  )

  // ── Dock ────────────────────────────────────────────────────────────
  const assets = new AssetBrowser(shell.dockPanels['assets']!, {
    onUseTexture: (name) => {
      const ids = selection.ids()
      if (ids.length > 0) opts.setProperty(ids, 'tex', name)
      else (document.getElementById('paint-tex') as HTMLSelectElement).value = name
    },
    // Genuinely arms the placement tool rather than telling the user to go
    // and find it themselves.
    onPlaceModel: (id) => opts.placeModel(id),
    onFindUsages: (ids) => selection.replaceMany(ids),
    onDeleteTexture: (name) => void opts.assets.deleteTexture(name),
    onDeleteModel: (id) => void opts.assets.deleteModel(id),
    onRenameTexture: (name, next) => void opts.assets.renameTexture(name, next),
    onImportTexture: (file) => void opts.assets.importTexture(file),
    onImportModel: (file) => void opts.assets.importModel(file),
  })

  const historyPanel = new HistoryPanel(shell.dockPanels['history']!, (steps) => {
    for (let i = 0; i < Math.abs(steps); i++) history.undo()
    refreshAll()
  })

  const scenePanel = new ScenePanel(shell.dockPanels['scene']!, {
    // The editor drives the SHARED Environment, so what is previewed here
    // is what players see; there is no second sky.
    onTimeOfDay: (t) => opts.env.setDayFraction(t / 24),
    onPreset: (name) =>
      opts.env.setDayFraction({ morning: 0.3, noon: 0.5, sunset: 0.78, night: 0.02 }[name]),
    onTogglePlay: (on) => {
      dayCycle = on
    },
    onPreferences: (next) => {
      opts.prefs.current = next
      opts.onPreferences()
      renderScene()
    },
  })
  let dayCycle = false
  const renderScene = (): void => scenePanel.render(opts.prefs.current, 12, dayCycle)

  // The Issues panel predates the workspace and looks its containers up by
  // id, so the dock provides them.
  const issuesRoot = shell.dockPanels['issues']!
  issuesRoot.id = 'issues'
  const issuesBadge = document.createElement('span')
  issuesBadge.id = 'issues-badge'
  const issuesList = document.createElement('div')
  issuesList.id = 'issues-list'
  issuesRoot.append(issuesBadge, issuesList)

  const issues = createIssuesPanel({
    collect: () => collectIssues(doc),
    focus: (id) => opts.focusObject(id),
  })
  const settings = createSettingsPanel({
    bindings: opts.bindings,
    bindingOf: opts.bindingOf,
    onChanged: () => refreshStatus(),
  })

  const statusBar = new StatusBar(shell.status, shell.message)

  // ── Toolbar wiring ──────────────────────────────────────────────────
  for (const [id] of TOOLS) {
    document.getElementById(`tool-${id}`)?.addEventListener('click', () => tools.toggle(id))
  }
  for (const mode of ['move', 'rotate', 'scale'] as const) {
    document.getElementById(`gm-${mode}`)?.addEventListener('click', () => {
      opts.gizmo.setMode(mode)
      refreshStatus()
    })
  }
  document.getElementById('xf-space')?.addEventListener('click', () => {
    opts.prefs.current.space = opts.prefs.current.space === 'world' ? 'local' : 'world'
    opts.onPreferences()
  })
  document.getElementById('save')?.addEventListener('click', () => void saveController.save())
  document.getElementById('map-export')?.addEventListener('click', () => saveController.exportMap())
  document.getElementById('map-import')?.addEventListener('change', (e) => {
    const file = (e.target as HTMLInputElement).files?.[0]
    if (file) void saveController.importMap(file)
  })
  document.getElementById('settings-btn')?.addEventListener('click', () => openSettings())
  for (const [panel, button] of Object.entries(shell.collapse))
    button.addEventListener('click', () => workspace.toggle(panel as 'outliner'))
  workspace.attachResizer(shell.resizers.outliner, 'outliner', 'x')
  workspace.attachResizer(shell.resizers.inspector, 'inspector', 'x', true)
  workspace.attachResizer(shell.resizers.dock, 'dock', 'y', true)
  for (const tab of shell.dockTabs.querySelectorAll<HTMLElement>('.dock-tab'))
    tab.addEventListener('click', () => showDockTab(tab.dataset['tab']!))

  // Conflict dialog.
  document
    .getElementById('conflict-load')
    ?.addEventListener('click', () => saveController.resolveConflict('theirs'))
  document
    .getElementById('conflict-keep')
    ?.addEventListener('click', () => saveController.resolveConflict('mine'))
  document
    .getElementById('conflict-export')
    ?.addEventListener('click', () => saveController.resolveConflict('export'))

  // ── Refresh ─────────────────────────────────────────────────────────
  const refreshTools = (): void => {
    for (const [id] of TOOLS)
      document.getElementById(`tool-${id}`)?.classList.toggle('active', tools.is(id))
    // Tool strips belong to the active tool and nothing else.
    shell.brush.classList.toggle('on', tools.is('terrain') || tools.is('paint'))
    shell.placement.classList.toggle('on', tools.is('mesh') || tools.is('entity'))
    shell.face.classList.toggle('on', tools.is('face'))
    shell.light.classList.toggle('on', tools.is('light'))
    shell.zone.classList.toggle('on', tools.is('zone'))
    refreshStatus()
  }

  const refreshSelection = (): void => {
    outliner.setState({
      selected: new Set(selection.ids()),
      primary: selection.primaryId,
      remote: opts.connection.remoteSelectionColors(),
      locks: opts.connection.lockOwners(),
      hidden,
    })
    const primary = selection.primaryId
    inspector.setState({
      ids: selection.ids(),
      lockedBy: primary ? opts.connection.lockOwner(primary) : null,
    })
    refreshStatus()
  }

  const refreshStatus = (): void => {
    const p = opts.prefs.current
    statusBar.render({
      tool: tools.active,
      selectionCount: selection.size,
      primary: selection.primaryId,
      transformMode: opts.gizmo.currentMode,
      space: p.space,
      snap: p.snap.translate.on ? `${p.snap.translate.step} m` : 'off',
      dirty: saveController.isDirty(),
      revision: saveController.revision(),
      peers: opts.connection.peerCount(),
      lock: selection.primaryId ? opts.connection.lockOwner(selection.primaryId) : null,
      message,
    })
    const saveBtn = document.getElementById('save')
    if (saveBtn)
      saveBtn.textContent = saveController.isDirty()
        ? '💾 Save map ● (unsaved changes)'
        : '💾 Save map (applies live)'
    const space = document.getElementById('xf-space')
    if (space) space.textContent = p.space === 'world' ? 'World' : 'Local'
    for (const mode of ['move', 'rotate', 'scale'] as const)
      document
        .getElementById(`gm-${mode}`)
        ?.classList.toggle('active', opts.gizmo.currentMode === mode)
  }

  const refreshAll = (): void => {
    outliner.render()
    refreshSelection()
    assets.setState({
      textures: doc.textures(),
      models: doc.models(),
      textureUsage: opts.assets.textureUsage(),
      modelUsage: opts.assets.modelUsage(),
    })
    historyPanel.render(history.labels(), history.state())
    renderScene()
    issues.refresh()
    refreshTools()
  }

  const showDockTab = (tab: string): void => {
    workspace.setDockTab(tab)
    for (const [id, el] of Object.entries(shell.dockPanels)) el.classList.toggle('on', id === tab)
    for (const t of shell.dockTabs.querySelectorAll<HTMLElement>('.dock-tab'))
      t.classList.toggle('active', t.dataset['tab'] === tab)
  }

  const openSettings = (): void => {
    settings.render()
    const el = document.getElementById('settings')
    if (el) el.style.display = el.style.display === 'flex' ? 'none' : 'flex'
  }

  // The document drives the panels; nothing polls.
  doc.subscribe((changes) => {
    const structural = changes.some((c) => c.type !== 'updated')
    if (structural) refreshAll()
    else {
      inspector.refreshValues()
      issues.refresh()
      refreshStatus()
    }
  })
  saveController.onChange(() => refreshStatus())
  showDockTab(workspace.dockTab)

  return {
    refreshAll,
    refreshSelection,
    refreshInspectorValues: () => inspector.refreshValues(),
    refreshStatus,
    refreshTools,
    setMessage,
    togglePanel: (panel) => workspace.toggle(panel),
    showDockTab,
    openSettings,
    duplicate: () => opts.duplicateSelection(),
    remove: () => opts.deleteSelection(),
    setProperty: (ids, key, value) => opts.setProperty(ids, key, value),
  }
}

/**
 * Document validation for the Issues panel. Runs the same
 * `validateMapFile` the SERVER runs, so an issue shown here is exactly what
 * a save would be rejected for, plus the editor-only checks the wire schema
 * cannot express.
 */
function collectIssues(doc: EditorDocument): EditorIssue[] {
  const map = doc.serialize()
  const issues: EditorIssue[] = validateMapFile(map).map((message) => ({
    severity: 'error' as const,
    message,
  }))

  for (const object of doc.list()) {
    const kind = doc.typeOf(object.id)
    const anyObj = object as Record<string, unknown>
    const pos = anyObj['pos'] as number[] | undefined
    if (pos && !pos.every(Number.isFinite))
      issues.push({
        severity: 'error',
        message: `"${object.id}" has a non-finite position`,
        objectId: object.id,
      })
    const scale = anyObj['scale'] as number[] | undefined
    if (scale?.some((v) => Math.abs(v) < 1e-3))
      issues.push({
        severity: 'warning',
        message: `"${object.id}" is scaled almost to nothing`,
        objectId: object.id,
      })
    if (kind === 'terrain') {
      const surface =
        (anyObj['surface'] as { paint?: { layers: unknown[]; mask?: string } }) ?? null
      if (surface?.paint && surface.paint.layers.length > 0 && !surface.paint.mask)
        issues.push({
          severity: 'error',
          message: `terrain "${object.id}" has paint layers but no mask`,
          objectId: object.id,
        })
    }
  }
  if (!doc.has('spawn'))
    issues.push({
      severity: 'warning',
      message: 'no spawn point — players will use the world default',
    })
  return issues
}
