/**
 * Modular weapon/equipment system (client side).
 *
 * Every tool kind can register a module: a settings/info panel that the
 * Tab menu's Equipment tab renders for the currently equipped item, backed
 * by a persistent per-weapon settings store. Future weapons (guns, melee,
 * tool-gun modes...) plug in here without touching HUD or controller code —
 * gameplay consequences of a setting always flow through the protocol so
 * the server stays authoritative.
 */
export declare class WeaponSettings {
  private data
  constructor()
  get<T>(weapon: string, key: string, fallback: T): T
  set(weapon: string, key: string, value: unknown): void
}
export interface WeaponModule {
  kind: string
  title: string
  /** Renders the settings/info panel into `el`. */
  buildPanel(el: HTMLElement, settings: WeaponSettings): void
}
export declare function registerWeaponModule(module: WeaponModule): void
export declare function weaponModuleFor(kind: string | null): WeaponModule | undefined
export declare function optionRow(
  el: HTMLElement,
  label: string,
  choices: {
    label: string
    value: number
  }[],
  current: number,
  onPick: (value: number) => void,
): void
export declare function infoLines(el: HTMLElement, lines: string[]): void
//# sourceMappingURL=registry.d.ts.map
