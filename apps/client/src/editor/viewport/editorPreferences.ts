/**
 * Viewport preferences that outlive a session: gizmo coordinate space, snap
 * increments, grid, and editor-only environment preview settings.
 *
 * These are EDITOR state, not map data. Persisting them in localStorage
 * rather than the document means two people editing the same map can have
 * different snap settings without fighting over a save.
 */
export type TransformSpace = 'world' | 'local'

export interface SnapSettings {
  translate: { on: boolean; step: number }
  rotate: { on: boolean; step: number }
  scale: { on: boolean; step: number }
}

export interface EditorPreferences {
  space: TransformSpace
  snap: SnapSettings
  grid: { on: boolean; size: number }
}

const KEY = 'hobo.editor.prefs'

export const DEFAULT_PREFERENCES: EditorPreferences = {
  space: 'world',
  snap: {
    translate: { on: true, step: 1 },
    // Degrees for rotation and a multiplier for scale: the units the
    // inspector shows, so the number in the box is the number that snaps.
    rotate: { on: false, step: 15 },
    scale: { on: false, step: 0.25 },
  },
  grid: { on: true, size: 1 },
}

const num = (v: unknown, fallback: number, min: number): number =>
  typeof v === 'number' && Number.isFinite(v) && v >= min ? v : fallback

const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback)

/** Tolerant of anything in storage: a corrupt value must not break boot. */
export function loadPreferences(raw: string | null): EditorPreferences {
  const d = DEFAULT_PREFERENCES
  if (!raw) return structuredClone(d)
  let parsed: Record<string, unknown>
  try {
    const value: unknown = JSON.parse(raw)
    // `null` and `42` are valid JSON but not preferences.
    if (value === null || typeof value !== 'object') return structuredClone(d)
    parsed = value as Record<string, unknown>
  } catch {
    return structuredClone(d)
  }
  const obj = (v: unknown): Record<string, never> =>
    v !== null && typeof v === 'object'
      ? (v as Record<string, never>)
      : ({} as Record<string, never>)
  const snap = obj(parsed['snap']) as unknown as Record<string, { on?: unknown; step?: unknown }>
  const grid = obj(parsed['grid']) as unknown as { on?: unknown; size?: unknown }
  return {
    space: parsed['space'] === 'local' ? 'local' : 'world',
    snap: {
      translate: {
        on: bool(snap['translate']?.on, d.snap.translate.on),
        step: num(snap['translate']?.step, d.snap.translate.step, 1e-4),
      },
      rotate: {
        on: bool(snap['rotate']?.on, d.snap.rotate.on),
        step: num(snap['rotate']?.step, d.snap.rotate.step, 1e-4),
      },
      scale: {
        on: bool(snap['scale']?.on, d.snap.scale.on),
        step: num(snap['scale']?.step, d.snap.scale.step, 1e-4),
      },
    },
    grid: { on: bool(grid.on, d.grid.on), size: num(grid.size, d.grid.size, 1e-4) },
  }
}

export function savePreferences(prefs: EditorPreferences, storage?: Storage): void {
  try {
    ;(storage ?? localStorage).setItem(KEY, JSON.stringify(prefs))
  } catch {
    // Private mode / quota: preferences are a convenience, never a blocker.
  }
}

export function readPreferences(storage?: Storage): EditorPreferences {
  try {
    return loadPreferences((storage ?? localStorage).getItem(KEY))
  } catch {
    return structuredClone(DEFAULT_PREFERENCES)
  }
}

/**
 * Snap a value to a step. `bypass` is the held modifier — snapping you
 * cannot temporarily switch off is worse than no snapping, because the one
 * time you need an exact offset you have to go and change the setting.
 */
export function snapTo(value: number, step: number, on: boolean, bypass = false): number {
  if (!on || bypass || step <= 0) return value
  return Math.round(value / step) * step
}

export const snapTranslation = (
  v: readonly [number, number, number],
  snap: SnapSettings,
  bypass: boolean,
): [number, number, number] => [
  snapTo(v[0], snap.translate.step, snap.translate.on, bypass),
  snapTo(v[1], snap.translate.step, snap.translate.on, bypass),
  snapTo(v[2], snap.translate.step, snap.translate.on, bypass),
]

/** Rotation snap is authored in degrees and applied in radians. */
export const snapRotationRadians = (
  radians: number,
  snap: SnapSettings,
  bypass: boolean,
): number => {
  if (!snap.rotate.on || bypass) return radians
  const step = (snap.rotate.step * Math.PI) / 180
  return step > 0 ? Math.round(radians / step) * step : radians
}

export const snapScale = (
  v: readonly [number, number, number],
  snap: SnapSettings,
  bypass: boolean,
): [number, number, number] => [
  snapTo(v[0], snap.scale.step, snap.scale.on, bypass),
  snapTo(v[1], snap.scale.step, snap.scale.on, bypass),
  snapTo(v[2], snap.scale.step, snap.scale.on, bypass),
]
