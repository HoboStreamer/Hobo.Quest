import { describe, expect, it } from 'vitest'
import { MapZoneSchemaV2, MapLightSchemaV2 } from '@hobo/content'
import { lightForPlacement, type LightType } from './lightTool.js'
import { nextZoneId, zoneForPlacement } from './zoneTool.js'

const place = (type: LightType) =>
  lightForPlacement({
    type,
    color: '#ffeecc',
    intensity: 3,
    point: [4, 0, 6],
    normal: [0, 1, 0],
  })

describe('lightForPlacement', () => {
  it('produces a light the schema accepts, for every type', () => {
    for (const type of ['point', 'spot', 'directional', 'hemi', 'rect'] as LightType[]) {
      const parsed = MapLightSchemaV2.safeParse(place(type))
      expect(parsed.success, `${type}: ${parsed.success ? '' : parsed.error.message}`).toBe(true)
    }
  })

  it('sits the light OFF the surface it was dropped on', () => {
    // Inside the wall it lights nothing, and the user cannot tell whether
    // placement worked.
    expect(place('point').pos[1]).toBeGreaterThan(0)
  })

  it('gives a point light a usable range rather than zero', () => {
    expect(place('point').range).toBeGreaterThan(0)
  })

  it('aims a spot back along the normal — at the thing you clicked', () => {
    const spot = place('spot')
    expect(spot.dir).toEqual([-0, -1, -0])
    expect(spot.angle).toBeGreaterThan(0)
    expect(spot.exponent).toBeGreaterThan(0)
  })

  it('lifts a directional light and gives it a sun direction', () => {
    const sun = place('directional')
    expect(sun.pos[1]).toBeGreaterThanOrEqual(12)
    expect(sun.dir![1]).toBeLessThan(0)
  })

  it('gives a hemispheric light a ground colour and no range', () => {
    const hemi = place('hemi')
    expect(hemi.ground).toBeDefined()
    expect(hemi.range).toBeUndefined()
  })

  it('gives a rect light a non-zero area', () => {
    expect(place('rect').size!.every((n) => n > 0)).toBe(true)
  })

  it('mints a unique id each time', () => {
    expect(place('point').id).not.toBe(place('point').id)
  })
})

describe('zoneForPlacement', () => {
  const zone = (over: Partial<Parameters<typeof zoneForPlacement>[0]> = {}) =>
    zoneForPlacement({ point: [10, 2, -4], size: 16, height: 12, taken: () => false, ...over })

  it('produces a zone the schema accepts', () => {
    const parsed = MapZoneSchemaV2.safeParse(zone())
    expect(parsed.success, parsed.success ? '' : parsed.error.message).toBe(true)
  })

  it('centres the footprint on the click and sits ON the surface', () => {
    // A zone half buried in the ground is almost never what was meant.
    const z = zone()
    expect(z.min).toEqual([2, 2, -12])
    expect(z.max).toEqual([18, 14, 4])
  })

  it('is permissive by default', () => {
    // A placement click that silently forbade PvP would be a surprise.
    expect(zone().rules).toEqual({ pvp: true, build: true, physgun: true })
  })

  it('never produces a zero-volume zone', () => {
    const z = zone({ size: 0, height: 0 })
    expect(z.max[0]).toBeGreaterThan(z.min[0])
    expect(z.max[1]).toBeGreaterThan(z.min[1])
  })

  it('uses an id shape the zone schema allows', () => {
    // Zone ids are lower-case alphanumeric with _/-, so the generic
    // timestamp id format would be rejected.
    expect(zone().id).toMatch(/^[a-z0-9_-]+$/)
  })

  it('avoids ids already in use', () => {
    const taken = new Set(['zone-1', 'zone-2'])
    expect(nextZoneId((id) => taken.has(id))).toBe('zone-3')
  })
})
