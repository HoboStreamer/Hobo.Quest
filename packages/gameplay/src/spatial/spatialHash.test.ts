import { describe, expect, it } from 'vitest'
import { RegionTracker, SpatialHash } from './spatialHash.js'

describe('SpatialHash', () => {
  it('finds items within radius and never misses (vs brute force)', () => {
    const hash = new SpatialHash<number>(8)
    const items: { id: number; x: number; z: number }[] = []
    let seed = 42
    const rand = () => {
      seed = (seed * 9301 + 49297) % 233280
      return seed / 233280
    }
    for (let i = 0; i < 500; i++) {
      const x = (rand() - 0.5) * 400
      const z = (rand() - 0.5) * 400
      items.push({ id: i, x, z })
      hash.insert(i, x, z)
    }
    for (const [qx, qz, r] of [
      [0, 0, 30],
      [100, -50, 12],
      [-180, 180, 60],
    ] as const) {
      const got = new Set(hash.queryRadius(qx, qz, r))
      for (const item of items) {
        const d = Math.hypot(item.x - qx, item.z - qz)
        if (d <= r) expect(got.has(item.id), `item ${item.id} at d=${d}`).toBe(true)
      }
    }
  })

  it('move updates cells; remove clears', () => {
    const hash = new SpatialHash<string>(10)
    hash.insert('a', 0, 0)
    expect(hash.queryRadius(0, 0, 5)).toContain('a')
    hash.move('a', 100, 100)
    expect(hash.queryRadius(0, 0, 5)).not.toContain('a')
    expect(hash.queryRadius(100, 100, 5)).toContain('a')
    // In-cell move is a no-op that keeps the item findable.
    hash.move('a', 101, 101)
    expect(hash.queryRadius(100, 100, 5)).toContain('a')
    hash.remove('a')
    expect(hash.queryRadius(100, 100, 5)).toHaveLength(0)
    expect(hash.size).toBe(0)
  })

  it('handles negative coordinates', () => {
    const hash = new SpatialHash<string>(16)
    hash.insert('n', -500, -500)
    expect(hash.queryRadius(-500, -500, 1)).toContain('n')
    expect(hash.queryRadius(500, 500, 1)).not.toContain('n')
  })
})

describe('RegionTracker', () => {
  it('activates the player region plus one ring', () => {
    const regions = new RegionTracker(32)
    regions.update([{ x: 0, z: 0 }])
    expect(regions.isActive(0, 0)).toBe(true)
    expect(regions.isActive(40, 0)).toBe(true) // neighbor ring
    expect(regions.isActive(100, 100)).toBe(false)
    expect(regions.activeRegionCount).toBe(9)
    expect(regions.occupiedRegionCount).toBe(1)
  })

  it('deactivates when players leave', () => {
    const regions = new RegionTracker(32)
    regions.update([{ x: 0, z: 0 }])
    regions.update([{ x: 500, z: 500 }])
    expect(regions.isActive(0, 0)).toBe(false)
    expect(regions.isActive(500, 500)).toBe(true)
  })

  it('merges overlapping player rings', () => {
    const regions = new RegionTracker(32)
    regions.update([
      { x: 0, z: 0 },
      { x: 33, z: 0 },
    ])
    expect(regions.activeRegionCount).toBe(12) // 3x3 + 3x3 overlapping by 6
    expect(regions.occupiedRegionCount).toBe(2)
  })
})
