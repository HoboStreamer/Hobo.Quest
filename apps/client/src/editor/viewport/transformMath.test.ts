import { describe, expect, it } from 'vitest'
import { Matrix, Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector.js'
import {
  applyDelta,
  applyGroupDelta,
  centroidOf,
  cloneTransform,
  composeMatrix,
  decomposeMatrix,
  deltaBetween,
  eulerOf,
  IDENTITY_TRANSFORM,
  isFiniteTransform,
  mixedComponents,
  snapPosition,
  transformFromEuler,
  type EditorTransform,
} from './transformMath.js'

const near = (a: number, b: number, eps = 1e-6): boolean => Math.abs(a - b) < eps
const closeTo = (a: EditorTransform, b: EditorTransform, eps = 1e-5): boolean =>
  a.position.every((v, i) => near(v, b.position[i]!, eps)) &&
  a.scale.every((v, i) => near(v, b.scale[i]!, eps)) &&
  // q and -q are the same orientation.
  (a.rotation.every((v, i) => near(v, b.rotation[i]!, eps)) ||
    a.rotation.every((v, i) => near(v, -b.rotation[i]!, eps)))

const t = (
  p: [number, number, number],
  e: [number, number, number] = [0, 0, 0],
  s: [number, number, number] = [1, 1, 1],
): EditorTransform => transformFromEuler(p, e, s)

describe('transform composition', () => {
  it('compose → decompose round-trips', () => {
    const a = t([3, -2, 7], [0.3, 1.1, -0.4], [2, 0.5, 1.5])
    expect(closeTo(decomposeMatrix(composeMatrix(a)), a)).toBe(true)
  })

  it('identity delta leaves a transform untouched', () => {
    const a = t([1, 2, 3], [0.2, 0.4, 0.6], [1, 2, 3])
    expect(closeTo(applyDelta(a, Matrix.Identity()), a)).toBe(true)
  })

  it('euler conversion round-trips through the quaternion', () => {
    const e: [number, number, number] = [0.4, -0.9, 0.15]
    const got = eulerOf(transformFromEuler([0, 0, 0], e))
    expect(got.every((v, i) => near(v, e[i]!, 1e-5))).toBe(true)
  })
})

describe('group deltas', () => {
  it('translating the pivot translates every member equally', () => {
    const starts = [t([0, 0, 0]), t([10, 0, 0]), t([0, 0, 10])]
    const pivotStart = t(centroidOf(starts))
    const pivotNow = t([
      pivotStart.position[0] + 5,
      pivotStart.position[1] + 1,
      pivotStart.position[2] - 2,
    ])
    const out = applyGroupDelta(starts, pivotStart, pivotNow)
    for (let i = 0; i < starts.length; i++) {
      expect(near(out[i]!.position[0], starts[i]!.position[0] + 5)).toBe(true)
      expect(near(out[i]!.position[1], starts[i]!.position[1] + 1)).toBe(true)
      expect(near(out[i]!.position[2], starts[i]!.position[2] - 2)).toBe(true)
    }
  })

  it('rotating the pivot orbits members around it', () => {
    const starts = [t([10, 0, 0]), t([-10, 0, 0])]
    const pivotStart = t([0, 0, 0])
    const pivotNow = t([0, 0, 0], [0, Math.PI / 2, 0])
    const out = applyGroupDelta(starts, pivotStart, pivotNow)
    // +90° about Y sends +x to -z in Babylon's left-handed frame.
    expect(near(out[0]!.position[0], 0, 1e-5)).toBe(true)
    expect(near(Math.abs(out[0]!.position[2]), 10, 1e-5)).toBe(true)
    // Members stay opposite each other.
    expect(near(out[0]!.position[2], -out[1]!.position[2], 1e-5)).toBe(true)
  })

  it('scaling the pivot scales positions about it and member scale with it', () => {
    const starts = [t([4, 0, 0]), t([-4, 0, 0])]
    const pivotStart = t([0, 0, 0])
    const pivotNow = t([0, 0, 0], [0, 0, 0], [2, 2, 2])
    const out = applyGroupDelta(starts, pivotStart, pivotNow)
    expect(near(out[0]!.position[0], 8)).toBe(true)
    expect(near(out[1]!.position[0], -8)).toBe(true)
    expect(near(out[0]!.scale[0], 2)).toBe(true)
  })

  it('is IDEMPOTENT — re-applying the same pivot pair does not compound', () => {
    // This is the property that makes a per-frame drag safe: each frame
    // recomputes from the START snapshot, never from the previous frame.
    const starts = [t([1, 2, 3], [0.1, 0.2, 0.3]), t([-4, 0, 2])]
    const pivotStart = t(centroidOf(starts))
    const pivotNow = t([9, 9, 9], [0, 0.7, 0])
    const once = applyGroupDelta(starts, pivotStart, pivotNow)
    const twice = applyGroupDelta(starts, pivotStart, pivotNow)
    expect(once.every((o, i) => closeTo(o, twice[i]!))).toBe(true)
  })

  it('cancel is exact: the inverse delta restores the start transforms', () => {
    const starts = [t([1, 2, 3], [0.3, 0, 0.2], [1.5, 1, 2]), t([-7, 1, 0], [0, 1.2, 0])]
    const pivotStart = t(centroidOf(starts))
    const pivotNow = t([4, -3, 8], [0.4, 0.5, 0.6], [3, 3, 3])
    const moved = applyGroupDelta(starts, pivotStart, pivotNow)
    const back = applyGroupDelta(moved, pivotNow, pivotStart)
    expect(back.every((b, i) => closeTo(b, starts[i]!, 1e-4))).toBe(true)
  })

  it('a mixed terrain + static group receives ONE shared delta', () => {
    const terrain = t([0, 0, 0], [0, 0, 0], [2, 1, 2])
    const box = t([6, 2, 0])
    const pivotStart = t(centroidOf([terrain, box]))
    const pivotNow = t([pivotStart.position[0], pivotStart.position[1] + 5, pivotStart.position[2]])
    const [tt, bb] = applyGroupDelta([terrain, box], pivotStart, pivotNow)
    expect(near(tt!.position[1], 5)).toBe(true)
    expect(near(bb!.position[1], 7)).toBe(true)
    // The terrain keeps its own non-uniform scale.
    expect(near(tt!.scale[0], 2)).toBe(true)
  })

  it('deltaBetween composes to exactly the target pivot', () => {
    const a = t([1, 1, 1], [0.2, 0.3, 0.4], [2, 2, 2])
    const b = t([5, -1, 3], [0.9, 0.1, 0.5], [0.5, 0.5, 0.5])
    expect(closeTo(applyDelta(a, deltaBetween(a, b)), b, 1e-4)).toBe(true)
  })
})

describe('validation and helpers', () => {
  it('rejects NaN, Infinity and zero scale', () => {
    expect(isFiniteTransform(IDENTITY_TRANSFORM)).toBe(true)
    expect(isFiniteTransform({ ...IDENTITY_TRANSFORM, position: [NaN, 0, 0] })).toBe(false)
    expect(isFiniteTransform({ ...IDENTITY_TRANSFORM, position: [Infinity, 0, 0] })).toBe(false)
    expect(isFiniteTransform({ ...IDENTITY_TRANSFORM, scale: [0, 1, 1] })).toBe(false)
  })

  it('scale defaults to 1, never 0', () => {
    expect(IDENTITY_TRANSFORM.scale).toEqual([1, 1, 1])
    expect(t([0, 0, 0]).scale).toEqual([1, 1, 1])
  })

  it('snaps positions and passes through when disabled', () => {
    expect(snapPosition([1.2, 3.7, -0.4], 0.5)).toEqual([1, 3.5, -0.5])
    expect(snapPosition([1.234, 0, 0], 0)).toEqual([1.234, 0, 0])
  })

  it('reports mixed components for a multi-selection', () => {
    const m = mixedComponents([
      t([0, 5, 0], [0, 0, 0], [1, 1, 1]),
      t([9, 5, 0], [0, 0, 0], [1, 2, 1]),
    ])
    expect(m.position).toEqual([true, false, false])
    expect(m.scale).toEqual([false, true, false])
    expect(m.rotation).toBe(false)
    // A single selection is never "mixed".
    expect(mixedComponents([t([1, 2, 3])]).position).toEqual([false, false, false])
  })

  it('clone does not alias the source arrays', () => {
    const a = t([1, 2, 3])
    const b = cloneTransform(a)
    b.position[0] = 99
    expect(a.position[0]).toBe(1)
  })

  it('centroid averages positions', () => {
    expect(centroidOf([t([0, 0, 0]), t([6, 3, -9])])).toEqual([3, 1.5, -4.5])
    expect(centroidOf([])).toEqual([0, 0, 0])
  })

  it('matches Babylon Compose/decompose directly', () => {
    const q = Quaternion.FromEulerAngles(0.3, 0.2, 0.1)
    const m = Matrix.Compose(new Vector3(2, 3, 4), q, new Vector3(5, 6, 7))
    const d = decomposeMatrix(m)
    expect(d.position.every((v, i) => near(v, [5, 6, 7][i]!, 1e-5))).toBe(true)
    expect(d.scale.every((v, i) => near(v, [2, 3, 4][i]!, 1e-5))).toBe(true)
  })
})
