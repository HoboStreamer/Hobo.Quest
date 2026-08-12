import { describe, expect, it } from 'vitest'
import { ConstraintIslands } from './islands.js'

describe('ConstraintIslands', () => {
  it('groups transitively connected nodes into one island', () => {
    const g = new ConstraintIslands<string>()
    g.addEdge('e1', 'a', 'b')
    g.addEdge('e2', 'b', 'c')
    g.addEdge('e3', 'x', 'y')
    expect(g.islandOf('a')).toEqual(new Set(['a', 'b', 'c']))
    expect(g.islandOf('y')).toEqual(new Set(['x', 'y']))
    expect(g.connected('a', 'c')).toBe(true)
    expect(g.connected('a', 'x')).toBe(false)
    expect(g.islandCount()).toBe(2)
  })

  it('returns a singleton island for unconstrained nodes', () => {
    const g = new ConstraintIslands<string>()
    expect(g.islandOf('lonely')).toEqual(new Set(['lonely']))
    expect(g.connected('lonely', 'lonely')).toBe(false)
  })

  it('splits islands when a bridge edge is removed', () => {
    const g = new ConstraintIslands<string>()
    g.addEdge('e1', 'a', 'b')
    g.addEdge('e2', 'b', 'c')
    g.removeEdge('e2')
    expect(g.islandOf('a')).toEqual(new Set(['a', 'b']))
    expect(g.connected('a', 'c')).toBe(false)
    expect(g.islandCount()).toBe(1)
  })

  it('keeps islands whole when a redundant edge is removed', () => {
    const g = new ConstraintIslands<string>()
    g.addEdge('e1', 'a', 'b')
    g.addEdge('e2', 'b', 'c')
    g.addEdge('e3', 'c', 'a') // triangle
    g.removeEdge('e3')
    expect(g.connected('a', 'c')).toBe(true)
  })

  it('removes every edge touching a despawned node', () => {
    const g = new ConstraintIslands<string>()
    g.addEdge('e1', 'a', 'b')
    g.addEdge('e2', 'b', 'c')
    g.addEdge('e3', 'c', 'd')
    const removed = g.removeNode('b')
    expect(removed.sort()).toEqual(['e1', 'e2'])
    expect(g.connected('a', 'c')).toBe(false)
    expect(g.connected('c', 'd')).toBe(true)
    expect(g.edgeCount).toBe(1)
  })

  it('supports growth after removals (dirty rebuild then incremental)', () => {
    const g = new ConstraintIslands<string>()
    g.addEdge('e1', 'a', 'b')
    g.removeEdge('e1')
    g.addEdge('e2', 'a', 'c')
    g.addEdge('e3', 'c', 'd')
    expect(g.islandOf('a')).toEqual(new Set(['a', 'c', 'd']))
    expect(g.connected('a', 'b')).toBe(false)
  })

  it('scales to hundreds of connected props', () => {
    const g = new ConstraintIslands<number>()
    // A 400-node chain plus cross-braces.
    for (let i = 0; i < 399; i++) g.addEdge(`c${i}`, i, i + 1)
    for (let i = 0; i < 390; i += 10) g.addEdge(`b${i}`, i, i + 5)
    expect(g.islandOf(0).size).toBe(400)
    expect(g.islandCount()).toBe(1)
    // Cutting one mid-chain link (no brace across it) splits the island.
    g.removeEdge('c397')
    expect(g.connected(0, 399)).toBe(false)
    expect(g.islandCount()).toBe(2)
    expect(
      g
        .allIslands()
        .map((s) => s.size)
        .sort((x, y) => x - y),
    ).toEqual([2, 398])
  })
})
