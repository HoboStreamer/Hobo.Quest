import { describe, expect, it } from 'vitest'
import {
  containerAdd,
  containerCanFit,
  containerCount,
  containerMove,
  containerSort,
  containerTake,
  containerTransfer,
  type Container,
} from './containers.js'

const maxStack = (id: string) => (id === 'coin' ? 999 : id === 'unique' ? 1 : 20)

const box = (n: number): Container => new Array<null>(n).fill(null)

describe('container domain', () => {
  it('adds with stacking, existing stacks first', () => {
    const b = box(3)
    expect(containerAdd(b, 'stone', 25, maxStack)).toBe(25)
    expect(b).toEqual([{ defId: 'stone', count: 20 }, { defId: 'stone', count: 5 }, null])
    expect(containerAdd(b, 'stone', 40, maxStack)).toBe(35) // 15 top-up + 20 new
    expect(containerCount(b, 'stone')).toBe(60)
  })

  it('canFit accounts for partial stacks and empties', () => {
    const b: Container = [{ defId: 'stone', count: 18 }, null]
    expect(containerCanFit(b, 'stone', 22, maxStack)).toBe(true)
    expect(containerCanFit(b, 'stone', 23, maxStack)).toBe(false)
    expect(containerCanFit(b, 'wood', 20, maxStack)).toBe(true)
    expect(containerCanFit(b, 'wood', 21, maxStack)).toBe(false)
  })

  it('takes partial and full stacks', () => {
    const b: Container = [{ defId: 'stone', count: 5 }]
    expect(containerTake(b, 0, 3)).toEqual({ defId: 'stone', count: 3 })
    expect(containerTake(b, 0, 99)).toEqual({ defId: 'stone', count: 2 })
    expect(b[0]).toBeNull()
    expect(containerTake(b, 0, 1)).toBeNull()
  })

  it('moves, merges and swaps within a container', () => {
    const b: Container = [
      { defId: 'stone', count: 15 },
      { defId: 'stone', count: 10 },
      { defId: 'wood', count: 4 },
      null,
    ]
    expect(containerMove(b, 0, 3, maxStack)).toBe(true) // to empty
    expect(b[3]).toEqual({ defId: 'stone', count: 15 })
    expect(containerMove(b, 3, 1, maxStack)).toBe(true) // merge capped at 20
    expect(b[1]).toEqual({ defId: 'stone', count: 20 })
    expect(b[3]).toEqual({ defId: 'stone', count: 5 })
    expect(containerMove(b, 2, 3, maxStack)).toBe(true) // different item: swap
    expect(b[2]).toEqual({ defId: 'stone', count: 5 })
    expect(b[3]).toEqual({ defId: 'wood', count: 4 })
  })

  it('splits with an explicit count', () => {
    const b: Container = [{ defId: 'stone', count: 10 }, null]
    expect(containerMove(b, 0, 1, maxStack, 4)).toBe(true)
    expect(b).toEqual([
      { defId: 'stone', count: 6 },
      { defId: 'stone', count: 4 },
    ])
    expect(containerMove(b, 0, 1, maxStack, 99)).toBe(false) // more than held
  })

  it('sorts loss-free: merges partials, orders by id, trailing empties', () => {
    const b: Container = [
      { defId: 'wood', count: 3 },
      null,
      { defId: 'stone', count: 15 },
      { defId: 'wood', count: 19 },
      { defId: 'stone', count: 15 },
    ]
    containerSort(b, maxStack)
    expect(b).toEqual([
      { defId: 'stone', count: 20 },
      { defId: 'stone', count: 10 },
      { defId: 'wood', count: 20 },
      { defId: 'wood', count: 2 },
      null,
    ])
  })

  it('transfers between containers as much as fits', () => {
    const from: Container = [{ defId: 'stone', count: 20 }]
    const to: Container = [{ defId: 'stone', count: 15 }] // 5 space
    expect(containerTransfer(from, 0, to, maxStack)).toBe(5)
    expect(from[0]).toEqual({ defId: 'stone', count: 15 })
    expect(to[0]).toEqual({ defId: 'stone', count: 20 })
    // Full target: nothing moves, nothing lost.
    expect(containerTransfer(from, 0, to, maxStack)).toBe(0)
    expect(from[0]).toEqual({ defId: 'stone', count: 15 })
  })

  it('transfer honors an explicit count', () => {
    const from: Container = [{ defId: 'stone', count: 10 }]
    const to: Container = [null, null]
    expect(containerTransfer(from, 0, to, maxStack, 4)).toBe(4)
    expect(from[0]).toEqual({ defId: 'stone', count: 6 })
    expect(containerCount(to, 'stone')).toBe(4)
  })
})
