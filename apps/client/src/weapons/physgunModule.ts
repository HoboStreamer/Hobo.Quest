import { infoLines, optionRow, registerWeaponModule, type WeaponSettings } from './registry.js'

/**
 * Physgun equipment module: building-related tuning. Values are read by
 * the interaction controller when it sends grid/rotate intents — the
 * server clamps everything, so these are conveniences, not authority.
 */

export function physgunGridSize(settings: WeaponSettings): number {
  return settings.get('physgun', 'gridSize', 0.25)
}

export function physgunSnapDeg(settings: WeaponSettings): number {
  return settings.get('physgun', 'snapDeg', 15)
}

function buildPhysgunPanel(el: HTMLElement, settings: WeaponSettings): void {
  el.replaceChildren()
  optionRow(
    el,
    'Grid size (hold Shift)',
    [
      { label: '0.1m', value: 0.1 },
      { label: '0.25m', value: 0.25 },
      { label: '0.5m', value: 0.5 },
      { label: '1m', value: 1 },
    ],
    physgunGridSize(settings),
    (v) => {
      settings.set('physgun', 'gridSize', v)
      buildPhysgunPanel(el, settings)
    },
  )
  optionRow(
    el,
    'Rotation snap (Shift + E)',
    [
      { label: '5°', value: 5 },
      { label: '15°', value: 15 },
      { label: '30°', value: 30 },
      { label: '45°', value: 45 },
      { label: '90°', value: 90 },
    ],
    physgunSnapDeg(settings),
    (v) => {
      settings.set('physgun', 'snapDeg', v)
      buildPhysgunPanel(el, settings)
    },
  )
  infoLines(el, [
    'Hold LMB — grab from the point you aim at (frozen props unfreeze)',
    'RMB — freeze in place · wheel — push / pull',
    'Hold E — rotate like a globe · Shift+E — snap rotation',
    'Hold Shift — grid-lock position while carrying',
  ])
}

export function registerPhysgunModule(): void {
  registerWeaponModule({
    kind: 'physgun',
    title: 'Physgun',
    buildPanel: buildPhysgunPanel,
  })
}
