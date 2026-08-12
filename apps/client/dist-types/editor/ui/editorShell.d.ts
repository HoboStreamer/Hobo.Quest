import { type Tool } from '../catalog.js'
export interface ShellElements {
  root: HTMLElement
  toolbar: HTMLElement
  tools: HTMLElement
  outliner: HTMLElement
  outlinerFilter: HTMLInputElement
  inspector: HTMLElement
  viewport: HTMLElement
  dock: HTMLElement
  dockTabs: HTMLElement
  dockPanels: Record<string, HTMLElement>
  status: HTMLElement
  message: HTMLElement
  /** Tool-specific control strips shown above the dock. */
  brush: HTMLElement
  placement: HTMLElement
  face: HTMLElement
  light: HTMLElement
  zone: HTMLElement
  resizers: {
    outliner: HTMLElement
    inspector: HTMLElement
    dock: HTMLElement
  }
  collapse: Record<'outliner' | 'inspector' | 'dock', HTMLButtonElement>
}
export declare const TOOLS: [Tool, string, string][]
/** Build the workspace into `mount` and return every element the app drives. */
export declare function buildShell(mount: HTMLElement, canvas: HTMLCanvasElement): ShellElements
/** Every keyboard action, for the settings panel's completeness check. */
export declare const ALL_ACTIONS: import('../bindings.js').ActionDef[]
//# sourceMappingURL=editorShell.d.ts.map
