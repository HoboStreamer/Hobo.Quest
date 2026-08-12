import { infoLines, optionRow, registerWeaponModule, type WeaponSettings } from './registry.js'

/**
 * Rigging tool equipment module: which constraint the next two clicks
 * create, plus per-type tuning. Pure convenience — the server validates
 * the type, skill gate, materials and every parameter.
 */

export type RiggingKind = 'weld' | 'rope' | 'hinge' | 'axis' | 'slider' | 'spring' | 'motor'

const KINDS: { label: string; value: number; kind: RiggingKind }[] = [
  { label: 'Weld', value: 0, kind: 'weld' },
  { label: 'Rope', value: 1, kind: 'rope' },
  { label: 'Hinge', value: 2, kind: 'hinge' },
  { label: 'Axis', value: 3, kind: 'axis' },
  { label: 'Slider', value: 4, kind: 'slider' },
  { label: 'Spring', value: 5, kind: 'spring' },
  { label: 'Motor', value: 6, kind: 'motor' },
]

export function riggingKind(settings: WeaponSettings): RiggingKind {
  const index = settings.get('rigging', 'kind', 0)
  return KINDS[index]?.kind ?? 'weld'
}

/** Extra slack added to the measured anchor gap for ropes (fraction). */
export function riggingRopeSlack(settings: WeaponSettings): number {
  return settings.get('rigging', 'ropeSlack', 0.15)
}

/** Hinge swing limit in degrees each way (0 = free). */
export function riggingHingeLimitDeg(settings: WeaponSettings): number {
  return settings.get('rigging', 'hingeLimitDeg', 0)
}

/** Slider travel in meters each way (0 = unbounded). */
export function riggingSliderTravel(settings: WeaponSettings): number {
  return settings.get('rigging', 'sliderTravel', 1)
}

export function riggingSpringStiffness(settings: WeaponSettings): number {
  return settings.get('rigging', 'springStiffness', 400)
}

export function riggingMotorSpeed(settings: WeaponSettings): number {
  return settings.get('rigging', 'motorSpeed', 3)
}

function buildRiggingPanel(el: HTMLElement, settings: WeaponSettings): void {
  el.replaceChildren()
  const rebuild = () => buildRiggingPanel(el, settings)
  optionRow(
    el,
    'Link type',
    KINDS.map(({ label, value }) => ({ label, value })),
    settings.get('rigging', 'kind', 0),
    (v) => {
      settings.set('rigging', 'kind', v)
      rebuild()
    },
  )
  const kind = riggingKind(settings)
  if (kind === 'rope') {
    optionRow(
      el,
      'Rope slack',
      [
        { label: 'Taut', value: 0 },
        { label: '+15%', value: 0.15 },
        { label: '+40%', value: 0.4 },
        { label: '+100%', value: 1 },
      ],
      riggingRopeSlack(settings),
      (v) => {
        settings.set('rigging', 'ropeSlack', v)
        rebuild()
      },
    )
  }
  if (kind === 'hinge') {
    optionRow(
      el,
      'Swing limit (± each way)',
      [
        { label: 'Free', value: 0 },
        { label: '45°', value: 45 },
        { label: '90°', value: 90 },
        { label: '135°', value: 135 },
      ],
      riggingHingeLimitDeg(settings),
      (v) => {
        settings.set('rigging', 'hingeLimitDeg', v)
        rebuild()
      },
    )
  }
  if (kind === 'slider') {
    optionRow(
      el,
      'Travel (± each way)',
      [
        { label: '0.5m', value: 0.5 },
        { label: '1m', value: 1 },
        { label: '2m', value: 2 },
        { label: 'Rail (4m)', value: 4 },
      ],
      riggingSliderTravel(settings),
      (v) => {
        settings.set('rigging', 'sliderTravel', v)
        rebuild()
      },
    )
  }
  if (kind === 'spring') {
    optionRow(
      el,
      'Stiffness',
      [
        { label: 'Soft', value: 120 },
        { label: 'Medium', value: 400 },
        { label: 'Stiff', value: 1200 },
      ],
      riggingSpringStiffness(settings),
      (v) => {
        settings.set('rigging', 'springStiffness', v)
        rebuild()
      },
    )
  }
  if (kind === 'motor') {
    optionRow(
      el,
      'Motor speed',
      [
        { label: 'Reverse', value: -3 },
        { label: 'Slow', value: 1.5 },
        { label: 'Cruise', value: 3 },
        { label: 'Fast', value: 8 },
      ],
      riggingMotorSpeed(settings),
      (v) => {
        settings.set('rigging', 'motorSpeed', v)
        rebuild()
      },
    )
  }
  const materials: Partial<Record<RiggingKind, string>> = {
    rope: 'Costs 1 Rope per tether',
    spring: 'Costs 2 Scrap Metal per spring',
    motor: 'Costs 1 Salvaged Motor per drive',
  }
  infoLines(el, [
    'LMB — pick the first point, then the second point to link',
    'Hinge / Axis / Slider / Motor take their axis from the second surface you click',
    'RMB — cut every link off the prop under the crosshair',
    ...(materials[kind] ? [materials[kind]] : []),
    'Higher Construction levels unlock more link types',
  ])
}

export function registerRiggingModule(): void {
  registerWeaponModule({
    kind: 'rigging',
    title: 'Rigging Tool',
    buildPanel: buildRiggingPanel,
  })
}
