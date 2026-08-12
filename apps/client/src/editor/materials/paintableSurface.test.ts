import { describe, expect, it } from 'vitest'
import {
  boxProjectionUV,
  cylindricalUV,
  faceIndexFromNormal,
  faceSurfaceId,
  faceUV,
  hasUsableUV0,
  modelSurfaceId,
  parseSurfaceId,
  planarUV,
  sphericalUV,
  toPaintUV,
  WHOLE_SURFACE,
} from './paintableSurface.js'

const inRange = (uv: { u: number; v: number }): void => {
  expect(uv.u).toBeGreaterThanOrEqual(-0.001)
  expect(uv.u).toBeLessThanOrEqual(1.001)
  expect(uv.v).toBeGreaterThanOrEqual(-0.001)
  expect(uv.v).toBeLessThanOrEqual(1.001)
}

describe('surface ids', () => {
  it('round-trips every form', () => {
    expect(parseSurfaceId(WHOLE_SURFACE)).toEqual({ kind: 'whole' })
    expect(parseSurfaceId(faceSurfaceId(3))).toEqual({ kind: 'face', index: 3 })
    expect(parseSurfaceId(modelSurfaceId('root/chair/seat', 2))).toEqual({
      kind: 'model',
      path: 'root/chair/seat',
      slot: 2,
    })
  })

  it('rejects anything it does not recognise, rather than guessing', () => {
    expect(parseSurfaceId('')).toBeNull()
    expect(parseSurfaceId('face:')).toBeNull()
    expect(parseSurfaceId('face:x')).toBeNull()
    expect(parseSurfaceId('mesh:no-slot')).toBeNull()
  })
})

describe('faceIndexFromNormal', () => {
  it('maps each axis to Babylon face order', () => {
    expect(faceIndexFromNormal({ x: 0, y: 0, z: 1 })).toBe(0)
    expect(faceIndexFromNormal({ x: 0, y: 0, z: -1 })).toBe(1)
    expect(faceIndexFromNormal({ x: 1, y: 0, z: 0 })).toBe(2)
    expect(faceIndexFromNormal({ x: -1, y: 0, z: 0 })).toBe(3)
    expect(faceIndexFromNormal({ x: 0, y: 1, z: 0 })).toBe(4)
    expect(faceIndexFromNormal({ x: 0, y: -1, z: 0 })).toBe(5)
  })

  it('picks the DOMINANT axis for an oblique normal', () => {
    // Painting one wall must not paint the other five, so a near-edge pick
    // still resolves to exactly one face.
    expect(faceIndexFromNormal({ x: 0.9, y: 0.3, z: 0.2 })).toBe(2)
    expect(faceIndexFromNormal({ x: 0.2, y: -0.95, z: 0.1 })).toBe(5)
  })
})

describe('faceUV', () => {
  const size = [4, 2, 6] as const

  it('puts the face centre at the middle of the mask', () => {
    for (let face = 0; face < 6; face++) {
      const uv = faceUV({ x: 0, y: 0, z: 0 }, size, face)
      expect(uv.u).toBeCloseTo(0.5, 6)
      expect(uv.v).toBeCloseTo(0.5, 6)
    }
  })

  it('stays inside the mask across each face', () => {
    for (let face = 0; face < 6; face++) {
      for (const p of [
        { x: 2, y: 1, z: 3 },
        { x: -2, y: -1, z: -3 },
      ])
        inRange(faceUV(p, size, face))
    }
  })

  it('gives opposite faces mirrored u, so text is not backwards on one side', () => {
    const front = faceUV({ x: 1, y: 0, z: 0 }, size, 0)
    const back = faceUV({ x: 1, y: 0, z: 0 }, size, 1)
    expect(front.u).toBeCloseTo(1 - back.u, 6)
  })
})

describe('cylindricalUV', () => {
  it('wraps a full turn across u exactly once', () => {
    // Quarter turns land on quarters of the mask; the seam sits at -X,
    // where u is 0 and 1 for the same point (that is what a seam IS).
    expect(cylindricalUV({ x: 1, y: 0, z: 0 }, 2).u).toBeCloseTo(0.5, 6)
    expect(cylindricalUV({ x: 0, y: 0, z: 1 }, 2).u).toBeCloseTo(0.75, 6)
    expect(cylindricalUV({ x: 0, y: 0, z: -1 }, 2).u).toBeCloseTo(0.25, 6)
    const seam = cylindricalUV({ x: -1, y: 0, z: 0 }, 2).u
    expect(seam === 0 || Math.abs(seam - 1) < 1e-6).toBe(true)
  })

  it('maps height to v', () => {
    expect(cylindricalUV({ x: 1, y: 1, z: 0 }, 2).v).toBeCloseTo(0, 6)
    expect(cylindricalUV({ x: 1, y: -1, z: 0 }, 2).v).toBeCloseTo(1, 6)
  })

  it('survives a zero-height cylinder without dividing by it', () => {
    expect(Number.isFinite(cylindricalUV({ x: 1, y: 0, z: 0 }, 0).v)).toBe(true)
  })
})

describe('sphericalUV', () => {
  it('puts the poles at v 0 and 1', () => {
    expect(sphericalUV({ x: 0, y: 1, z: 0 }).v).toBeCloseTo(0, 6)
    expect(sphericalUV({ x: 0, y: -1, z: 0 }).v).toBeCloseTo(1, 6)
  })

  it('stays in range everywhere, including at the origin', () => {
    for (const p of [
      { x: 1, y: 0, z: 0 },
      { x: 0, y: 0, z: 1 },
      { x: -0.5, y: 0.5, z: -0.5 },
      { x: 0, y: 0, z: 0 },
    ])
      inRange(sphericalUV(p))
  })
})

describe('planarUV', () => {
  it('maps a patch corner to corner', () => {
    expect(planarUV({ x: -8, z: -8 }, 8)).toEqual({ u: 0, v: 1 })
    expect(planarUV({ x: 8, z: 8 }, 8)).toEqual({ u: 1, v: 0 })
    expect(planarUV({ x: 0, z: 0 }, 8)).toEqual({ u: 0.5, v: 0.5 })
  })
})

describe('boxProjectionUV', () => {
  it('is the no-UV fallback, and it produces SOMETHING rather than nothing', () => {
    // Paint silently doing nothing is the worst outcome: the user cannot
    // tell whether they missed, the texture failed, or it is unsupported.
    const uv = boxProjectionUV({ x: 0.5, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, [2, 2, 2])
    inRange(uv)
  })
})

describe('hasUsableUV0', () => {
  const mesh = (uvs: number[] | null) => ({
    isVerticesDataPresent: () => uvs !== null,
    getVerticesData: () => uvs,
  })

  it('accepts a properly unwrapped mesh', () => {
    expect(hasUsableUV0(mesh([0, 0, 1, 0, 1, 1, 0, 1]))).toBe(true)
  })

  it('rejects a mesh with no UVs at all', () => {
    expect(hasUsableUV0(mesh(null))).toBe(false)
  })

  it('rejects ALL-ZERO UVs, which is what an un-unwrapped export writes', () => {
    // Painting into that puts every stamp on one texel — indistinguishable
    // from the brush not working.
    expect(hasUsableUV0(mesh([0, 0, 0, 0, 0, 0, 0, 0]))).toBe(false)
  })

  it('rejects a degenerate UV array', () => {
    expect(hasUsableUV0(mesh([0, 0]))).toBe(false)
  })
})

describe('toPaintUV', () => {
  it('converts to mask pixels and scales the radius by world extent', () => {
    const p = toPaintUV({ u: 0.5, v: 0.25 }, 512, 2, 16)
    expect(p.u).toBe(256)
    expect(p.v).toBe(128)
    expect(p.radiusPixels).toBeCloseTo(64, 6)
  })

  it('never produces a sub-pixel brush', () => {
    expect(toPaintUV({ u: 0, v: 0 }, 512, 0.0001, 1000).radiusPixels).toBe(1)
  })
})
