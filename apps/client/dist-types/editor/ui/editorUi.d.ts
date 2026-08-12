/**
 * The panels, wired to the editor's state.
 *
 * Each panel is a dumb renderer (see `outliner.ts`, `inspector.ts`,
 * `panels.ts`); this is where they learn what to show and where their
 * callbacks go. Splitting it this way is what lets the panels be tested
 * without an engine, a document or a server.
 */
import type { Environment } from '../../render/environment.js'
import type { MapModelV2, MapTextureEntry } from '@hobo/content'
import type { EditorDocument } from '../document/editorDocument.js'
import type { CommandHistory } from '../history/commandHistory.js'
import type { SelectionManager } from '../selection/selectionManager.js'
import type { ToolManager } from '../tools/toolManager.js'
import type { EditorViewRegistry } from '../viewport/editorViewRegistry.js'
import type { GizmoController } from '../viewport/gizmoController.js'
import type { EditorPreferences } from '../viewport/editorPreferences.js'
import type { Binding } from '../bindings.js'
import { type ShellElements } from './editorShell.js'
import type { SaveController } from '../net/saveController.js'
export interface EditorConnectionView {
  peerCount: () => number
  remoteSelectionColors: () => ReadonlyMap<string, string>
  lockOwners: () => ReadonlyMap<string, string>
  lockOwner: (id: string) => string | null
  canEdit: (id: string) => boolean
}
export interface EditorUiOptions {
  shell: ShellElements
  doc: EditorDocument
  views: EditorViewRegistry
  selection: SelectionManager
  history: CommandHistory<EditorDocument>
  tools: ToolManager
  prefs: {
    current: EditorPreferences
  }
  gizmo: GizmoController
  env: Environment
  connection: EditorConnectionView
  saveController: SaveController
  bindings: Record<string, Binding>
  bindingOf: (action: string) => Binding
  textures: () => readonly MapTextureEntry[]
  models: () => readonly MapModelV2[]
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
}
export declare function createEditorUi(opts: EditorUiOptions): EditorUi
//# sourceMappingURL=editorUi.d.ts.map
