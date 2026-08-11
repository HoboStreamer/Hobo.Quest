/**
 * Centralized editor keybindings: every keyboard action routes through one
 * structured, remappable system (KeyboardEvent.code + modifiers), with
 * conflict detection for the settings UI. Pure module — unit tested.
 */
export interface Binding {
  code: string
  ctrl?: boolean
  shift?: boolean
  alt?: boolean
  meta?: boolean
}
export interface ActionDef {
  id: string
  label: string
  group: 'camera' | 'tools' | 'transform' | 'edit' | 'terrain' | 'ui'
  default: Binding
  /** Held key (movement) rather than a triggered action. */
  hold?: boolean
}
export declare const ACTIONS: ActionDef[]
export declare function bindingMatches(b: Binding, e: KeyboardEvent): boolean
export declare function formatBinding(b: Binding): string
export declare function bindingFromEvent(e: KeyboardEvent): Binding
export declare function sameBinding(a: Binding, b: Binding): boolean
/** Action ids whose current binding collides with `b` (excluding `except`). */
export declare function findConflicts(
  bindings: Record<string, Binding>,
  b: Binding,
  except?: string,
): string[]
export declare function defaultBindings(): Record<string, Binding>
export declare function loadBindings(stored: string | null): Record<string, Binding>
//# sourceMappingURL=bindings.d.ts.map
