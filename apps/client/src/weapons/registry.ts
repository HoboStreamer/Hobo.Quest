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

export class WeaponSettings {
  private data: Record<string, Record<string, unknown>> = {}

  constructor() {
    try {
      const raw = localStorage.getItem('hobo.weaponcfg')
      if (raw) this.data = JSON.parse(raw) as typeof this.data
    } catch {
      this.data = {}
    }
  }

  get<T>(weapon: string, key: string, fallback: T): T {
    const v = this.data[weapon]?.[key]
    return v === undefined ? fallback : (v as T)
  }

  set(weapon: string, key: string, value: unknown): void {
    ;(this.data[weapon] ??= {})[key] = value
    localStorage.setItem('hobo.weaponcfg', JSON.stringify(this.data))
  }
}

export interface WeaponModule {
  kind: string
  title: string
  /** Renders the settings/info panel into `el`. */
  buildPanel(el: HTMLElement, settings: WeaponSettings): void
  /**
   * Weapon emits a muzzle-anchored beam/tracer while its trigger is held.
   * The shared pipeline (viewmodel muzzle origin -> crosshair raycast end,
   * bright + flare when latched) renders it — future beam/projectile
   * weapons opt in here instead of adding bespoke render code.
   */
  firesBeam?: boolean
}

const modules = new Map<string, WeaponModule>()

export function registerWeaponModule(module: WeaponModule): void {
  modules.set(module.kind, module)
}

export function weaponModuleFor(kind: string | null): WeaponModule | undefined {
  return kind ? modules.get(kind) : undefined
}

// ── Helpers for building sleek option rows ───────────────────────────

export function optionRow(
  el: HTMLElement,
  label: string,
  choices: { label: string; value: number }[],
  current: number,
  onPick: (value: number) => void,
): void {
  const row = document.createElement('div')
  row.className = 'weapon-opt'
  const lab = document.createElement('div')
  lab.className = 'weapon-opt-label'
  lab.textContent = label
  row.appendChild(lab)
  const group = document.createElement('div')
  group.className = 'weapon-opt-choices'
  for (const choice of choices) {
    const b = document.createElement('button')
    b.className = Math.abs(choice.value - current) < 1e-9 ? 'cust-btn selected' : 'cust-btn'
    b.textContent = choice.label
    b.addEventListener('click', () => onPick(choice.value))
    group.appendChild(b)
  }
  row.appendChild(group)
  el.appendChild(row)
}

export function infoLines(el: HTMLElement, lines: string[]): void {
  for (const line of lines) {
    const div = document.createElement('div')
    div.className = 'hint-line'
    div.textContent = line
    el.appendChild(div)
  }
}
