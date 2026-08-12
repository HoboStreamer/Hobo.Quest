import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PREFERENCES,
  loadPreferences,
  snapRotationRadians,
  snapScale,
  snapTo,
  snapTranslation,
} from './editorPreferences.js'

describe('loadPreferences', () => {
  it('returns defaults for missing storage', () => {
    expect(loadPreferences(null)).toEqual(DEFAULT_PREFERENCES)
  })

  it('survives corrupt storage rather than breaking boot', () => {
    expect(loadPreferences('{not json')).toEqual(DEFAULT_PREFERENCES)
    expect(loadPreferences('null')).toEqual(DEFAULT_PREFERENCES)
    expect(loadPreferences('42')).toEqual(DEFAULT_PREFERENCES)
  })

  it('round-trips a full set', () => {
    const prefs = {
      space: 'local' as const,
      snap: {
        translate: { on: false, step: 0.5 },
        rotate: { on: true, step: 45 },
        scale: { on: true, step: 0.1 },
      },
      grid: { on: false, size: 4 },
    }
    expect(loadPreferences(JSON.stringify(prefs))).toEqual(prefs)
  })

  it('rejects nonsensical values field by field', () => {
    const loaded = loadPreferences(
      JSON.stringify({
        space: 'sideways',
        snap: { translate: { on: 'yes', step: -3 }, rotate: { step: Number.NaN } },
        grid: { size: 0 },
      }),
    )
    expect(loaded.space).toBe('world')
    expect(loaded.snap.translate.on).toBe(DEFAULT_PREFERENCES.snap.translate.on)
    expect(loaded.snap.translate.step).toBe(DEFAULT_PREFERENCES.snap.translate.step)
    expect(loaded.snap.rotate.step).toBe(DEFAULT_PREFERENCES.snap.rotate.step)
    expect(loaded.grid.size).toBe(DEFAULT_PREFERENCES.grid.size)
  })
})

describe('snapping', () => {
  it('rounds to the nearest step when on', () => {
    expect(snapTo(1.4, 1, true)).toBe(1)
    expect(snapTo(1.6, 1, true)).toBe(2)
    expect(snapTo(1.4, 0.5, true)).toBe(1.5)
  })

  it('is a no-op when off', () => {
    expect(snapTo(1.4, 1, false)).toBe(1.4)
  })

  it('honours the bypass modifier', () => {
    // Snapping you cannot temporarily switch off is worse than none: the one
    // time an exact offset is needed you would have to change the setting.
    expect(snapTo(1.4, 1, true, true)).toBe(1.4)
  })

  it('ignores a zero or negative step instead of dividing by it', () => {
    expect(snapTo(1.4, 0, true)).toBe(1.4)
    expect(snapTo(1.4, -1, true)).toBe(1.4)
  })

  it('snaps a translation per axis', () => {
    const snap = { ...DEFAULT_PREFERENCES.snap, translate: { on: true, step: 2 } }
    expect(snapTranslation([1.2, 3.9, -0.9], snap, false)).toEqual([2, 4, -0])
  })

  it('snaps rotation in DEGREES but applies it in radians', () => {
    const snap = { ...DEFAULT_PREFERENCES.snap, rotate: { on: true, step: 90 } }
    expect(snapRotationRadians(1.4, snap, false)).toBeCloseTo(Math.PI / 2, 6)
    expect(snapRotationRadians(0.1, snap, false)).toBeCloseTo(0, 6)
    expect(snapRotationRadians(1.4, snap, true)).toBe(1.4)
  })

  it('snaps scale per axis', () => {
    const snap = { ...DEFAULT_PREFERENCES.snap, scale: { on: true, step: 0.25 } }
    expect(snapScale([1.1, 2.6, 0.3], snap, false)).toEqual([1, 2.5, 0.25])
  })
})
