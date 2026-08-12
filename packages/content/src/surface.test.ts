import { describe, expect, it } from 'vitest'
import {
  MAX_PAINT_LAYERS,
  activeLayers,
  allocateLayer,
  emptySurface,
  freeChannel,
  layerForTexture,
  migrateLegacyMix,
  removeLayer,
  validateSurface,
  type SurfacePaint,
} from './surface.js'

let n = 0
const makeId = (): string => `layer-${n++}`

describe('paint layer allocation', () => {
  it('allocates a channel per texture, up to the budget', () => {
    let paint: SurfacePaint | undefined
    const texes = ['red_brick', 'wood_planks', 'gray_rocks', 'metal_plate']
    for (const tex of texes) {
      const a = allocateLayer(paint, tex, makeId)
      expect(a).not.toBeNull()
      paint = a!.paint
      expect(a!.created).toBe(true)
    }
    expect(paint!.layers.map((l) => l.channel)).toEqual(['r', 'g', 'b', 'a'])
    expect(paint!.layers).toHaveLength(MAX_PAINT_LAYERS)
  })

  it('reuses the existing layer when the same texture is picked again', () => {
    const a = allocateLayer(undefined, 'red_brick', makeId)!
    const b = allocateLayer(a.paint, 'red_brick', makeId)!
    expect(b.created).toBe(false)
    expect(b.layer.id).toBe(a.layer.id)
    expect(a.paint.layers).toHaveLength(1)
  })

  it('refuses a fifth texture instead of silently replacing one', () => {
    let paint: SurfacePaint | undefined
    for (const tex of ['a', 'b', 'c', 'd']) paint = allocateLayer(paint, tex, makeId)!.paint
    // The caller must open the layer manager; nothing is overwritten.
    expect(allocateLayer(paint, 'e', makeId)).toBeNull()
    expect(paint!.layers.map((l) => l.tex)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('frees the channel when a layer is removed, and reuses it', () => {
    let paint: SurfacePaint | undefined
    for (const tex of ['a', 'b', 'c', 'd']) paint = allocateLayer(paint, tex, makeId)!.paint
    const removed = removeLayer(paint!, paint!.layers[1]!.id)
    expect(removed).toBe('g')
    expect(freeChannel(paint)).toBe('g')
    const next = allocateLayer(paint, 'e', makeId)!
    expect(next.layer.channel).toBe('g')
  })

  it('un-hides a hidden layer rather than duplicating it', () => {
    const a = allocateLayer(undefined, 'red_brick', makeId)!
    a.layer.hidden = true
    expect(activeLayers(a.paint)).toHaveLength(0)
    const b = allocateLayer(a.paint, 'red_brick', makeId)!
    expect(b.created).toBe(false)
    expect(b.layer.hidden).toBeUndefined()
    expect(a.paint.layers).toHaveLength(1)
  })

  it('finds a layer by texture', () => {
    const a = allocateLayer(undefined, 'wood_planks', makeId)!
    expect(layerForTexture(a.paint, 'wood_planks')?.id).toBe(a.layer.id)
    expect(layerForTexture(a.paint, 'nope')).toBeNull()
  })
})

describe('paint colour', () => {
  it('the same texture in two tints becomes two layers', () => {
    const a = allocateLayer(undefined, 'red_brick', makeId, '#ff0000')!
    const b = allocateLayer(a.paint, 'red_brick', makeId, '#0000ff')!
    expect(b.created).toBe(true)
    expect(a.paint.layers).toHaveLength(2)
    expect(a.paint.layers.map((l) => l.color)).toEqual(['#ff0000', '#0000ff'])
  })

  it('the same texture in the SAME tint reuses its layer', () => {
    const a = allocateLayer(undefined, 'red_brick', makeId, '#ff0000')!
    const b = allocateLayer(a.paint, 'red_brick', makeId, '#ff0000')!
    expect(b.created).toBe(false)
    expect(b.layer.id).toBe(a.layer.id)
  })

  it('an untinted layer is distinct from a tinted one', () => {
    const a = allocateLayer(undefined, 'red_brick', makeId)!
    const b = allocateLayer(a.paint, 'red_brick', makeId, '#00ff00')!
    expect(b.created).toBe(true)
    expect(a.paint.layers[0]!.color).toBeUndefined()
  })

  it('supports plain-colour layers with no texture at all', () => {
    const a = allocateLayer(undefined, 'none', makeId, '#123456')!
    expect(a.layer.tex).toBe('none')
    expect(a.layer.color).toBe('#123456')
    // 'none' is not a dangling texture reference.
    expect(
      validateSurface({ base: {}, paint: { mask: 'data:x', layers: [a.layer] } }, () => false),
    ).toEqual([])
  })

  it('flags a plain-colour layer that has no colour', () => {
    const issues = validateSurface(
      { base: {}, paint: { mask: 'data:x', layers: [{ id: 'l', tex: 'none', channel: 'r' }] } },
      () => true,
    )
    expect(issues.join(' ')).toContain('no colour')
  })
})

describe('base texture survives painting', () => {
  it('painting never touches the base style', () => {
    const surface = emptySurface({ tex: 'custom:sand', color: '#ddccaa' })
    const a = allocateLayer(surface.paint, 'red_brick', makeId)!
    surface.paint = a.paint
    // The whole point: base is still sand after a brick layer is added.
    expect(surface.base.tex).toBe('custom:sand')
    expect(surface.base.color).toBe('#ddccaa')
    expect(surface.paint.layers[0]!.tex).toBe('red_brick')
  })

  it('a second custom texture becomes its own layer, base still intact', () => {
    const surface = emptySurface({ tex: 'custom:sand' })
    surface.paint = allocateLayer(surface.paint, 'custom:brick_a', makeId)!.paint
    surface.paint = allocateLayer(surface.paint, 'custom:moss_b', makeId)!.paint
    expect(surface.base.tex).toBe('custom:sand')
    expect(surface.paint.layers.map((l) => l.tex)).toEqual(['custom:brick_a', 'custom:moss_b'])
  })
})

describe('legacy migration', () => {
  it('maps the old grass/rock/mud splat onto channels r/g/b', () => {
    const paint = migrateLegacyMix('data:image/png;base64,AAA', makeId)!
    expect(paint.mask).toBe('data:image/png;base64,AAA')
    expect(paint.layers.map((l) => [l.tex, l.channel])).toEqual([
      ['leafy_grass', 'r'],
      ['gray_rocks', 'g'],
      ['brown_mud_dry', 'b'],
    ])
    // The alpha channel stays free for a newly painted texture.
    expect(freeChannel(paint)).toBe('a')
  })

  it('an unpainted legacy surface migrates to no paint at all', () => {
    expect(migrateLegacyMix(undefined, makeId)).toBeUndefined()
  })
})

describe('validation', () => {
  const exists = (ref: string): boolean => ref.startsWith('ok')

  it('accepts a clean surface', () => {
    const s = emptySurface({ tex: 'ok_base' })
    s.paint = { mask: 'data:x', layers: [{ id: 'l1', tex: 'ok_layer', channel: 'r' }] }
    expect(validateSurface(s, exists)).toEqual([])
  })

  it('reports missing textures, duplicate channels, over-budget and no mask', () => {
    const s = emptySurface({ tex: 'gone_base' })
    s.paint = {
      layers: [
        { id: 'l1', tex: 'ok_a', channel: 'r' },
        { id: 'l2', tex: 'gone_b', channel: 'r' },
      ],
    }
    const issues = validateSurface(s, exists)
    expect(issues.some((i) => i.includes('missing base texture'))).toBe(true)
    expect(issues.some((i) => i.includes('missing paint texture'))).toBe(true)
    expect(issues.some((i) => i.includes('share channel r'))).toBe(true)
    expect(issues.some((i) => i.includes('mask is missing'))).toBe(true)
  })

  it("does not complain about the 'none' sentinel base", () => {
    expect(validateSurface(emptySurface({ tex: 'none' }), exists)).toEqual([])
  })
})
