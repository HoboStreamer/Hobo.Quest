import { describe, expect, it } from 'vitest'
import { sculptDab, toTerrainLocal, type SculptTarget } from './terrainTool.js'

const target = (sub = 16, halfExtent = 8): SculptTarget => ({
  heights: new Float32Array((sub + 1) * (sub + 1)),
  sub,
  halfExtent,
})

const at = (t: SculptTarget, i: number, j: number): number => t.heights[j * (t.sub + 1) + i] ?? 0
const brush = { radius: 3, strength: 1, feather: 1 }

describe('sculptDab', () => {
  it('raises under the cursor and falls off with distance', () => {
    const t = target()
    sculptDab(t, 0, 0, 1, 'sculpt', brush)
    const centre = at(t, 8, 8)
    const edge = at(t, 10, 8)
    expect(centre).toBeGreaterThan(0)
    expect(edge).toBeGreaterThan(0)
    expect(centre).toBeGreaterThan(edge)
  })

  it('lowers with a negative sign', () => {
    const t = target()
    sculptDab(t, 0, 0, -1, 'sculpt', brush)
    expect(at(t, 8, 8)).toBeLessThan(0)
  })

  it('touches ONLY the samples inside the brush', () => {
    // The whole point of the bounded loop: a dab on a 512² terrain must not
    // walk a quarter of a million samples.
    const t = target(64, 32)
    sculptDab(t, 0, 0, 1, 'sculpt', { ...brush, radius: 2 })
    const touched = [...t.heights].filter((h) => h !== 0).length
    expect(touched).toBeGreaterThan(0)
    expect(touched).toBeLessThan(40)
  })

  it('a higher feather makes a tighter, flatter plateau', () => {
    const soft = target()
    const hard = target()
    sculptDab(soft, 0, 0, 1, 'sculpt', { ...brush, feather: 0.3 })
    sculptDab(hard, 0, 0, 1, 'sculpt', { ...brush, feather: 4 })
    // Near the rim, the soft brush has deposited more than the hard one.
    expect(at(soft, 10, 8)).toBeGreaterThan(at(hard, 10, 8))
  })

  it('flatten levels toward the height where the stroke landed', () => {
    // Dragging across a slope should level it to ONE plane rather than
    // chasing the height under the cursor.
    const t = target()
    t.heights.fill(0)
    for (let j = 0; j <= t.sub; j++)
      for (let i = 0; i <= t.sub; i++) t.heights[j * (t.sub + 1) + i] = i
    const before = at(t, 10, 8)
    sculptDab(t, 0, 0, 1, 'flatten', brush)
    // The sample at the centre is unchanged (it IS the target height); a
    // neighbour has moved toward it.
    expect(at(t, 8, 8)).toBeCloseTo(8, 5)
    expect(Math.abs(at(t, 10, 8) - 8)).toBeLessThan(Math.abs(before - 8))
  })

  it('smooth pulls a spike toward its neighbours', () => {
    const t = target()
    t.heights[8 * (t.sub + 1) + 8] = 10
    sculptDab(t, 0, 0, 1, 'smooth', brush)
    expect(at(t, 8, 8)).toBeLessThan(10)
    expect(at(t, 8, 8)).toBeGreaterThan(0)
  })

  it('stays inside the field at an edge instead of writing out of bounds', () => {
    const t = target()
    expect(() => sculptDab(t, -8, -8, 1, 'sculpt', { ...brush, radius: 6 })).not.toThrow()
    expect([...t.heights].every(Number.isFinite)).toBe(true)
    expect(at(t, 0, 0)).toBeGreaterThan(0)
  })

  it('accumulates across dabs, as a held brush does', () => {
    const t = target()
    sculptDab(t, 0, 0, 1, 'sculpt', brush)
    const once = at(t, 8, 8)
    sculptDab(t, 0, 0, 1, 'sculpt', brush)
    expect(at(t, 8, 8)).toBeCloseTo(once * 2, 5)
  })
})

describe('toTerrainLocal', () => {
  it('subtracts the terrain position', () => {
    expect(toTerrainLocal({ x: 5, y: 1, z: 7 }, [2, 0, 3], undefined, undefined)).toEqual({
      x: 3,
      y: 1,
      z: 4,
    })
  })

  it('undoes a yaw, so sculpting a rotated terrain lands under the cursor', () => {
    const local = toTerrainLocal({ x: 0, y: 0, z: 1 }, [0, 0, 0], [0, Math.PI / 2, 0], undefined)
    expect(local.x).toBeCloseTo(1, 6)
    expect(local.z).toBeCloseTo(0, 6)
  })

  it('undoes a scale', () => {
    const local = toTerrainLocal({ x: 4, y: 2, z: 6 }, [0, 0, 0], undefined, [2, 1, 3])
    expect(local).toEqual({ x: 2, y: 2, z: 2 })
  })

  it('does not divide by a zero scale component', () => {
    const local = toTerrainLocal({ x: 4, y: 0, z: 0 }, [0, 0, 0], undefined, [0, 1, 1])
    expect(Number.isFinite(local.x)).toBe(true)
  })
})
