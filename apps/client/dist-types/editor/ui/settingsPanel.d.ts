/**
 * The keybinding settings panel.
 *
 * Self-contained: it owns the bindings map, persists it, and tells the caller
 * when something changed so tool chips and help text can re-render. Nothing
 * about the viewport, the document or the tools leaks in here.
 */
import { type Binding } from '../bindings.js'
export interface SettingsPanelDeps {
  /** The live bindings map, mutated in place so holders stay in sync. */
  bindings: Record<string, Binding>
  bindingOf: (action: string) => Binding
  /** Called after any change, so hotkey chips and help text can refresh. */
  onChanged: () => void
}
export declare function createSettingsPanel(deps: SettingsPanelDeps): {
  render: () => void
}
//# sourceMappingURL=settingsPanel.d.ts.map
