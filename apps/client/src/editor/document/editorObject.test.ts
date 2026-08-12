import { describe, expect, it } from 'vitest'
import { blankHeights } from '@hobo/content'
import { EditorDocument } from './editorDocument.js'
import { dirFromQuat, quatFromDir, setTransform, transformOf } from './editorObject.js'
import { eulerOf, transformFromEuler } from '../viewport/transformMath.js'

const doc = (): EditorDocument => new EditorDocument()

const near = (a: readonly number[], b: readonly number[], eps = 1e-4): void => {
  expect(a).toHaveLength(b.length)
  a.forEach((v, i) => expect(Math.abs(v - b[i]!), `[${i}] ${v} vs ${b[i]}`).toBeLessThan(eps))
}

describe('transformOf / setTransform', () => {
  it('round-trips a static, including rotation and scale', () => {
    const d = doc()
    d.add('static', {
      id: 's1',
      shape: { type: 'box', size: [1, 1, 1] },
      pos: [1, 2, 3],
      yaw: 0.5,
      color: '#ffffff',
    } as never)
    const t = transformOf(d, 's1')!
    near(t.position, [1, 2, 3])
    near(eulerOf(t), [0, 0.5, 0])

    setTransform(d, 's1', transformFromEuler([4, 5, 6], [0.1, 0.2, 0.3], [2, 3, 4]))
    const b = d.get('s1', 'static')!
    near(b.pos, [4, 5, 6])
    near(b.rot!, [0.1, 0.2, 0.3])
    near(b.scale!, [2, 3, 4])
  })

  it('drops identity rotation and scale, so a drag adds no wire noise', () => {
    const d = doc()
    d.add('static', {
      id: 's1',
      shape: { type: 'box', size: [1, 1, 1] },
      pos: [0, 0, 0],
      yaw: 0,
      color: '#ffffff',
      rot: [0.5, 0.5, 0.5],
      scale: [2, 2, 2],
    } as never)
    setTransform(d, 's1', transformFromEuler([1, 1, 1], [0, 0.7, 0]))
    const b = d.get('s1', 'static')!
    expect(b.rot).toBeUndefined()
    expect(b.scale).toBeUndefined()
    expect(b.yaw).toBeCloseTo(0.7, 4)
  })

  it('keeps a terrain rotation that is yaw-only', () => {
    // A static folds yaw into `yaw`, but a terrain has no such field: a
    // yaw-only terrain rotation must survive as `rot`.
    const d = doc()
    d.add('terrain', {
      id: 't1',
      pos: [0, 0, 0],
      halfExtent: 8,
      sub: 4,
      heights: blankHeights(4),
    } as never)
    setTransform(d, 't1', transformFromEuler([0, 0, 0], [0, 0.9, 0]))
    near(d.get('t1', 'terrain')!.rot!, [0, 0.9, 0])
  })

  it('pins a node to the ground plane — only its footprint is authored', () => {
    const d = doc()
    d.add('node', { id: 'n1', node: 'oak_tree', pos: [0, 0, 0] } as never)
    setTransform(d, 'n1', transformFromEuler([5, 99, 7], [0, 0, 0]))
    expect(d.get('n1', 'node')!.pos).toEqual([5, 0, 7])
  })

  it('keeps a prop upright and yaw-only', () => {
    const d = doc()
    d.add('prop', { id: 'p1', item: 'crate', pos: [0, 1, 0] } as never)
    setTransform(d, 'p1', transformFromEuler([2, 8, 3], [0.4, 0.6, 0.2]))
    const p = d.get('p1', 'prop')!
    expect(p.pos).toEqual([2, 1, 3])
    expect(p.yaw).toBeCloseTo(0.6, 3)
  })

  it('turns a light rotation into a direction vector, and back', () => {
    const d = doc()
    d.add('light', { id: 'l1', type: 'spot', pos: [0, 5, 0], dir: [0, -1, 0] } as never)
    const t = transformOf(d, 'l1')!
    near(dirFromQuat(t.rotation), [0, -1, 0])

    setTransform(d, 'l1', {
      position: [1, 6, 2],
      rotation: quatFromDir([1, 0, 0]),
      scale: [1, 1, 1],
    })
    const l = d.get('l1', 'light')!
    near(l.pos, [1, 6, 2])
    near(l.dir!, [1, 0, 0])
  })

  it('leaves a point light without a direction — it has no beam', () => {
    const d = doc()
    d.add('light', { id: 'l1', type: 'point', pos: [0, 5, 0] } as never)
    setTransform(d, 'l1', {
      position: [0, 6, 0],
      rotation: quatFromDir([1, 0, 0]),
      scale: [1, 1, 1],
    })
    expect(d.get('l1', 'light')!.dir).toBeUndefined()
  })

  it('drives a zone by centre and half-extent, so scale RESIZES the volume', () => {
    const d = doc()
    d.add('zone', {
      id: 'z1',
      name: 'Z',
      min: [-2, -1, -3],
      max: [4, 5, 9],
      rules: { pvp: true, build: true, physgun: true },
    } as never)
    const t = transformOf(d, 'z1')!
    near(t.position, [1, 2, 3])
    near(t.scale, [3, 3, 6])

    setTransform(d, 'z1', { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [5, 5, 5] })
    const z = d.get('z1', 'zone')!
    near(z.min, [-5, -5, -5])
    near(z.max, [5, 5, 5])
  })

  it('never lets a zone collapse to zero volume', () => {
    const d = doc()
    d.add('zone', {
      id: 'z1',
      name: 'Z',
      min: [0, 0, 0],
      max: [1, 1, 1],
      rules: { pvp: true, build: true, physgun: true },
    } as never)
    setTransform(d, 'z1', { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [0, 0, 0] })
    const z = d.get('z1', 'zone')!
    expect(z.max[0]).toBeGreaterThan(z.min[0])
  })

  it('round-trips spawn', () => {
    const d = doc()
    d.add('spawn', { id: 'spawn', pos: [1, 2, 3], yaw: 0.25 })
    setTransform(d, 'spawn', transformFromEuler([9, 0, 9], [0, 1.5, 0]))
    const s = d.get('spawn', 'spawn')!
    near(s.pos, [9, 0, 9])
    expect(s.yaw).toBeCloseTo(1.5, 4)
  })

  it('returns null for an id the document does not have', () => {
    expect(transformOf(doc(), 'ghost')).toBeNull()
    expect(() =>
      setTransform(doc(), 'ghost', transformFromEuler([0, 0, 0], [0, 0, 0])),
    ).not.toThrow()
  })
})

describe('quatFromDir / dirFromQuat', () => {
  it('round-trips arbitrary directions', () => {
    for (const dir of [
      [0, -1, 0],
      [1, 0, 0],
      [0, 1, 0],
      [0.3, -0.5, 0.8],
      [-1, -1, -1],
    ] as [number, number, number][]) {
      const len = Math.hypot(...dir)
      near(
        dirFromQuat(quatFromDir(dir)),
        dir.map((v) => v / len),
      )
    }
  })

  it('handles the degenerate straight-up case without producing NaN', () => {
    // -Y onto +Y has no unique axis; a naive cross product gives zero.
    const q = quatFromDir([0, 1, 0])
    expect(q.every(Number.isFinite)).toBe(true)
    near(dirFromQuat(q), [0, 1, 0])
  })
})
