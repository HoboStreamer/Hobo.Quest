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
  onImportTexture: (file: File) => void
  onImportModel: (file: File) => void
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
export declare function canDeleteAsset(usage: AssetUsage | undefined): {
  ok: boolean
  reason?: string
}
export declare class AssetBrowser {
  private readonly root
  private readonly callbacks
  private state
  constructor(root: HTMLElement, callbacks: AssetBrowserCallbacks)
  setState(next: Partial<AssetBrowserState>): void
  private render
  private textureItem
  private modelItem
  private actions
}
export interface HistoryEntryView {
  label: string
  undone: boolean
}
/**
 * A view of the ONE CommandHistory. It has no stack of its own — a second
 * undo system is exactly the bug this whole program is about.
 */
export declare class HistoryPanel {
  private readonly root
  private readonly onJump
  constructor(root: HTMLElement, onJump: (steps: number) => void)
  render(entries: readonly HistoryEntryView[], state: HistoryState): void
}
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
export declare function statusText(s: StatusState): string
export declare class StatusBar {
  private readonly root
  private readonly messageEl
  constructor(root: HTMLElement, messageEl: HTMLElement)
  render(state: StatusState): void
}
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
export declare class ScenePanel {
  private readonly root
  private readonly callbacks
  constructor(root: HTMLElement, callbacks: ScenePanelCallbacks)
  render(prefs: EditorPreferences, timeOfDay: number, playing: boolean): void
}
//# sourceMappingURL=panels.d.ts.map
