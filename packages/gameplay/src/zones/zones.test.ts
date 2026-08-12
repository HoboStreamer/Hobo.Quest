import { describe, expect, it } from 'vitest'
import { vec3 } from '@hobo/shared'
import type { ZoneDef } from '@hobo/content'
import { ZoneIndex } from './zones.js'

const safe: ZoneDef = {
  id: 'safe',
  name: 'Safe',
  min: [-10, -1, -10],
  max: [10, 5, 10],
  rules: { pvp: false, build: true, physgun: true },
}

describe('ZoneIndex', () => {
  const index = new ZoneIndex([safe])

  it('applies restrictive rules inside the zone', () => {
    expect(index.rulesAt(vec3(0, 1, 0))).toEqual({ pvp: false, build: true, physgun: true })
  })

  it('uses defaults outside', () => {
    expect(index.rulesAt(vec3(50, 1, 0))).toEqual({ pvp: true, build: true, physgun: true })
  })

  it('overlapping zones: most restrictive wins', () => {
    const noBuild: ZoneDef = {
      ...safe,
      id: 'nb',
      rules: { pvp: true, build: false, physgun: true },
    }
    const both = new ZoneIndex([safe, noBuild])
    expect(both.rulesAt(vec3(0, 1, 0))).toEqual({ pvp: false, build: false, physgun: true })
  })
})

describe('map-authored zones', () => {
  // A map save must never mutate the base content list: the statics path once
  // appended into `content.world.*` on every apply, so each save stacked
  // another copy. Map zones live in their own replaceable layer instead.
  const mapZone: ZoneDef = {
    id: 'map-arena',
    name: 'Arena',
    min: [100, -5, 100],
    max: [120, 20, 120],
    rules: { pvp: true, build: false, physgun: true },
  }

  it('augment the base zones rather than replacing them', () => {
    const index = new ZoneIndex([safe])
    index.setMapZones([mapZone])
    expect(index.rulesAt(vec3(0, 1, 0)).pvp).toBe(false)
    expect(index.rulesAt(vec3(110, 1, 110)).build).toBe(false)
  })

  it('cannot lift a restriction the world def declared', () => {
    const index = new ZoneIndex([safe])
    // Same volume as `safe`, but permissive: most-restrictive still wins.
    index.setMapZones([
      { ...safe, id: 'map-pvp', rules: { pvp: true, build: true, physgun: true } },
    ])
    expect(index.rulesAt(vec3(0, 1, 0)).pvp).toBe(false)
  })

  it('replaces the map layer, so applying the same map twice is a no-op', () => {
    const index = new ZoneIndex([safe])
    index.setMapZones([mapZone])
    const once = index.all().length
    index.setMapZones([mapZone])
    expect(index.all().length).toBe(once)
  })

  it('removes a zone the map no longer authors', () => {
    const index = new ZoneIndex([safe])
    index.setMapZones([mapZone])
    index.setMapZones([])
    expect(index.rulesAt(vec3(110, 1, 110)).build).toBe(true)
    // …without disturbing the base list.
    expect(index.rulesAt(vec3(0, 1, 0)).pvp).toBe(false)
  })
})
