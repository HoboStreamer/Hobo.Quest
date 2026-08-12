import { describe, expect, it } from 'vitest'
import { LockManager } from './editorLocks.js'

describe('editor lock manager', () => {
  it('grants free locks and denies held ones', () => {
    const lm = new LockManager()
    expect(lm.acquire(1, ['a'], 0).granted).toBe(true)
    const r = lm.acquire(2, ['a'], 0)
    expect(r.granted).toBe(false)
    expect(r.blocked).toEqual([{ id: 'a', owner: 1 }])
    expect(lm.ownerOf('a')).toBe(1)
  })

  it('re-acquiring your own lock is fine', () => {
    const lm = new LockManager()
    lm.acquire(1, ['a'], 0)
    expect(lm.acquire(1, ['a', 'b'], 0).granted).toBe(true)
  })

  it('multi-lock is all-or-nothing', () => {
    const lm = new LockManager()
    lm.acquire(1, ['b'], 0)
    const r = lm.acquire(2, ['a', 'b', 'c'], 0)
    expect(r.granted).toBe(false)
    // Nothing partially acquired: a and c stay free.
    expect(lm.ownerOf('a')).toBeUndefined()
    expect(lm.ownerOf('c')).toBeUndefined()
  })

  it('release frees only your own locks', () => {
    const lm = new LockManager()
    lm.acquire(1, ['a'], 0)
    lm.acquire(2, ['b'], 0)
    lm.release(2, ['a', 'b'])
    expect(lm.ownerOf('a')).toBe(1)
    expect(lm.ownerOf('b')).toBeUndefined()
  })

  it('releaseAll on disconnect frees everything owned', () => {
    const lm = new LockManager()
    lm.acquire(1, ['a', 'terrain:floor'], 0)
    expect(lm.releaseAll(1).sort()).toEqual(['a', 'terrain:floor'])
    expect(lm.ownerOf('terrain:floor')).toBeUndefined()
  })

  it('leases expire without heartbeats; heartbeats keep them alive', () => {
    const lm = new LockManager()
    lm.acquire(1, ['a'], 0)
    lm.acquire(2, ['b'], 0)
    lm.heartbeat(1, 40_000)
    const freed = lm.sweep(60_000) // peer 2 silent for 60s, peer 1 fresh
    expect(freed).toEqual(['b'])
    expect(lm.ownerOf('a')).toBe(1)
    expect(lm.sweep(120_000)).toEqual(['a'])
  })

  it('exposes broadcastable state', () => {
    const lm = new LockManager()
    lm.acquire(3, ['spawn', 'terrain:p1'], 0)
    expect(lm.state()).toEqual({ spawn: 3, 'terrain:p1': 3 })
  })
})
