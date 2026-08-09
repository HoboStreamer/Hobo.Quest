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
