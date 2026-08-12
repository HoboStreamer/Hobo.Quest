import { describe, expect, it } from 'vitest'
import { encodeHeights, type MapFile } from './mapFile.js'
import {
  MAIN_TERRAIN_MIGRATED_ID,
  blankHeights,
  canonicalizeMapFile,
  emptyMapV2,
  migrateV1ToV2,
  parseMapFile,
  validateMapFile,
  type MapFileV2,
} from './mapFileV2.js'

const SUB = 8
const heightsOf = (fill: number): string => {
  const a = new Float32Array((SUB + 1) * (SUB + 1))
  a.fill(fill)
  return encodeHeights(a)
}

const v1Map = (over: Partial<MapFile> = {}): MapFile => ({
  v: 1,
  halfExtent: 100,
  sub: SUB,
  heights: heightsOf(0),
  statics: [],
  ...over,
})

describe('empty map', () => {
  it('a brand-new map has no terrain and no geometry at all', () => {
    const m = emptyMapV2()
    expect(m.terrains).toEqual([])
    expect(m.statics).toEqual([])
    expect(m.nodes).toEqual([])
    expect(m.props).toEqual([])
    // No starter island, no hidden ground plane, no terrain:main.
    expect(JSON.stringify(m)).not.toContain('main')
  })
})

describe('v1 → v2 migration', () => {
  it('turns the privileged main heightfield into ONE ordinary terrain', () => {
    const out = migrateV1ToV2(v1Map({ heights: heightsOf(3) }))
    expect(out.v).toBe(2)
    expect(out.terrains).toHaveLength(1)
    const t = out.terrains[0]!
    expect(t.id).toBe(MAIN_TERRAIN_MIGRATED_ID)
    expect(t.pos).toEqual([0, 0, 0])
    expect(t.halfExtent).toBe(100)
    // Nothing about it is special any more.
    expect(t).not.toHaveProperty('main')
  })

  it('is deterministic — the same v1 map yields the same ids twice', () => {
    const src = v1Map({
      statics: [
        { shape: { type: 'box', size: [1, 1, 1] }, pos: [0, 0, 0], yaw: 0, color: '#ffffff' },
      ],
    })
    expect(canonicalizeMapFile(migrateV1ToV2(src))).toBe(canonicalizeMapFile(migrateV1ToV2(src)))
  })

  it('drops a main terrain that was "deleted" by sinking it below the waterline', () => {
    // v1 faked deletion with heights.fill(-6) and an invisible collider.
    const out = migrateV1ToV2(v1Map({ heights: heightsOf(-6) }))
    expect(out.terrains).toHaveLength(0)
  })

  it('maps the legacy splat onto paint layers with channels preserved', () => {
    const out = migrateV1ToV2(v1Map({ mix: 'data:image/png;base64,AAA' }))
    const paint = out.terrains[0]!.surface!.paint!
    expect(paint.mask).toBe('data:image/png;base64,AAA')
    expect(paint.layers.map((l) => [l.tex, l.channel])).toEqual([
      ['leafy_grass', 'r'],
      ['gray_rocks', 'g'],
      ['brown_mud_dry', 'b'],
    ])
  })

  it('migrates v1 patches, keeping ids, transforms and surfaces', () => {
    const out = migrateV1ToV2(
      v1Map({
        terrains: [
          {
            id: 'patch-7',
            origin: [10, 2, -4],
            halfExtent: 16,
            sub: SUB,
            heights: heightsOf(1),
            rot: [0, 0.5, 0],
            scale: [2, 1, 2],
            tex: 'red_brick',
            color: '#aabbcc',
          },
        ],
      }),
    )
    const t = out.terrains.find((x) => x.id === 'patch-7')!
    expect(t.pos).toEqual([10, 2, -4])
    expect(t.rot).toEqual([0, 0.5, 0])
    expect(t.scale).toEqual([2, 1, 2])
    expect(t.surface!.base).toEqual({ tex: 'red_brick', color: '#aabbcc' })
  })

  it("treats the 'none' texture sentinel as a plain-colour base", () => {
    const out = migrateV1ToV2(
      v1Map({
        terrains: [
          {
            id: 'p1',
            origin: [0, 0, 0],
            halfExtent: 8,
            sub: SUB,
            heights: heightsOf(0),
            tex: 'none',
          },
        ],
      }),
    )
    expect(out.terrains.find((t) => t.id === 'p1')!.surface!.base.tex).toBeUndefined()
  })

  it('gives ids to v1 objects that never had one', () => {
    const out = migrateV1ToV2(
      v1Map({
        statics: [
          { shape: { type: 'box', size: [1, 1, 1] }, pos: [0, 0, 0], yaw: 0, color: '#ffffff' },
        ],
        nodes: [{ node: 'oak_tree', pos: [1, 0, 1] }],
      }),
    )
    expect(out.statics[0]!.id).toBe('s-v1-0')
    expect(out.nodes[0]!.id).toBe('n-v1-0')
  })
})

describe('parseMapFile', () => {
  it('accepts a v2 map unchanged', () => {
    const m = emptyMapV2()
    const r = parseMapFile(m)
    expect(r.ok && r.migrated).toBe(false)
    expect(r.ok).toBe(true)
  })

  it('accepts a v1 map and reports that it migrated', () => {
    const r = parseMapFile(v1Map())
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.migrated).toBe(true)
  })

  it('rejects unknown versions and non-objects', () => {
    expect(parseMapFile({ v: 99 }).ok).toBe(false)
    expect(parseMapFile(null).ok).toBe(false)
    expect(parseMapFile('nope').ok).toBe(false)
  })

  it('rejects a zero scale, which would collapse the body', () => {
    const m = emptyMapV2()
    m.terrains.push({
      id: 't1',
      pos: [0, 0, 0],
      scale: [1, 0, 1],
      halfExtent: 8,
      sub: SUB,
      heights: blankHeights(SUB),
    })
    const r = parseMapFile(m)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.issues.join(' ')).toContain('scale')
  })

  it('rejects non-finite transforms', () => {
    const m = emptyMapV2()
    m.terrains.push({
      id: 't1',
      pos: [Number.NaN, 0, 0],
      halfExtent: 8,
      sub: SUB,
      heights: blankHeights(SUB),
    })
    expect(parseMapFile(m).ok).toBe(false)
  })
})

describe('validateMapFile', () => {
  const withTerrain = (over: Partial<MapFileV2['terrains'][number]> = {}): MapFileV2 => {
    const m = emptyMapV2()
    m.terrains.push({
      id: 't1',
      pos: [0, 0, 0],
      halfExtent: 8,
      sub: SUB,
      heights: blankHeights(SUB),
      ...over,
    })
    return m
  }

  it('accepts a clean map', () => {
    expect(validateMapFile(withTerrain())).toEqual([])
  })

  it('catches a height count that disagrees with the resolution', () => {
    const m = withTerrain({ heights: blankHeights(4) })
    expect(validateMapFile(m).join(' ')).toContain('height samples')
  })

  it('catches duplicate ids across kinds', () => {
    const m = withTerrain()
    m.statics.push({
      id: 't1',
      shape: { type: 'box', size: [1, 1, 1] },
      pos: [0, 0, 0],
      yaw: 0,
      color: '#ffffff',
    })
    expect(validateMapFile(m).join(' ')).toContain('duplicate id')
  })

  it('catches dangling texture, model and paint references', () => {
    const m = withTerrain({
      surface: {
        base: { tex: 'custom:missing' },
        paint: { mask: 'data:x', layers: [{ id: 'l1', tex: 'custom:alsogone', channel: 'r' }] },
      },
    })
    m.statics.push({
      id: 's1',
      shape: { type: 'box', size: [1, 1, 1] },
      pos: [0, 0, 0],
      yaw: 0,
      color: '#ffffff',
      model: 'no-such-model',
    })
    const issues = validateMapFile(m).join(' ')
    expect(issues).toContain('missing base texture')
    expect(issues).toContain('missing paint texture')
    expect(issues).toContain('missing model')
  })

  it('accepts stock texture names without a registry entry', () => {
    expect(validateMapFile(withTerrain({ surface: { base: { tex: 'red_brick' } } }))).toEqual([])
  })
})

describe('paint layer tint survives the canonical wire', () => {
  // Regression: PaintLayerSchemaV2 once omitted `color`, so Zod stripped the
  // tint on parse. Painting "red brick tinted blue" saved as untinted brick,
  // and a plain-colour layer lost the only property that made it visible.
  const mapWithLayers = (layers: unknown[]): unknown => ({
    ...emptyMapV2(),
    terrains: [
      {
        id: 't1',
        pos: [0, 0, 0],
        halfExtent: 8,
        sub: SUB,
        heights: blankHeights(SUB),
        surface: { base: { tex: 'red_brick' }, paint: { mask: 'data:x', layers } },
      },
    ],
  })

  const parsedLayers = (layers: unknown[]): { tex: string; color?: string }[] => {
    const r = parseMapFile(mapWithLayers(layers))
    expect(r.ok, r.ok ? '' : r.issues.join(', ')).toBe(true)
    if (!r.ok) throw new Error('unreachable')
    return r.map.terrains[0]!.surface!.paint!.layers
  }

  it('keeps the tint on a textured layer', () => {
    const [l] = parsedLayers([{ id: 'l1', tex: 'red_brick', color: '#3366cc', channel: 'r' }])
    expect(l!.tex).toBe('red_brick')
    expect(l!.color).toBe('#3366cc')
  })

  it('keeps the colour of a plain-colour (tex: none) layer', () => {
    const [l] = parsedLayers([{ id: 'l1', tex: 'none', color: '#00ff00', channel: 'g' }])
    expect(l!.color).toBe('#00ff00')
  })

  it('survives canonicalisation and a second parse', () => {
    const first = parseMapFile(
      mapWithLayers([
        { id: 'l1', tex: 'red_brick', color: '#3366cc', channel: 'r' },
        { id: 'l2', tex: 'none', color: '#00ff00', channel: 'g' },
      ]),
    )
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const wire = canonicalizeMapFile(first.map)
    expect(wire).toContain('#3366cc')
    const second = parseMapFile(JSON.parse(wire))
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.map.terrains[0]!.surface!.paint!.layers.map((l) => l.color)).toEqual([
      '#3366cc',
      '#00ff00',
    ])
  })

  it('leaves an untinted layer untinted rather than inventing white', () => {
    const [l] = parsedLayers([{ id: 'l1', tex: 'red_brick', channel: 'r' }])
    expect(l!.color).toBeUndefined()
  })

  it('rejects a malformed colour instead of dropping it', () => {
    for (const bad of ['#FFF', '#GGGGGG', 'red', '#3366CC', '#3366cc7f', '']) {
      const r = parseMapFile(
        mapWithLayers([{ id: 'l1', tex: 'red_brick', color: bad, channel: 'r' }]),
      )
      expect(r.ok, `expected "${bad}" to be rejected`).toBe(false)
    }
  })

  it('carries the tint through a v1 migration parse too', () => {
    const v1 = v1Map({
      terrains: [
        {
          id: 'p1',
          origin: [0, 0, 0],
          halfExtent: 8,
          sub: SUB,
          heights: blankHeights(SUB),
          surface: {
            base: { tex: 'red_brick' },
            paint: {
              mask: 'data:x',
              layers: [{ id: 'l1', tex: 'none', color: '#123456', channel: 'a' }],
            },
          },
        },
      ],
    } as Partial<MapFile>)
    const r = parseMapFile(v1)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const t = r.map.terrains.find((x) => x.id === 'p1')!
    expect(t.surface!.paint!.layers[0]!.color).toBe('#123456')
  })
})

describe('canonicalisation', () => {
  it('is key-order independent, so the revision hash is stable', () => {
    const a = { ...emptyMapV2(), spawn: [1, 2, 3] as [number, number, number] }
    const b = { spawn: [1, 2, 3] as [number, number, number], ...emptyMapV2() }
    expect(canonicalizeMapFile(a)).toBe(canonicalizeMapFile(b))
  })

  it('drops undefined members instead of emitting them', () => {
    const m = emptyMapV2()
    ;(m as unknown as Record<string, unknown>)['spawnYaw'] = undefined
    expect(canonicalizeMapFile(m)).not.toContain('spawnYaw')
  })
})
