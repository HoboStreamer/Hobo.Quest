import { describe, expect, it } from 'vitest'
import { EditorProfiler } from './editorProfiler.js'

describe('EditorProfiler', () => {
  it('records nothing until it is switched on', () => {
    // An unobserved counter must cost nothing; these run in hot loops.
    const p = new EditorProfiler()
    p.count('a')
    expect(p.snapshot()).toEqual({})
  })

  it('counts', () => {
    const p = new EditorProfiler()
    p.setEnabled(true)
    p.count('a')
    p.count('a', 3)
    expect(p.snapshot()['a']).toEqual({ count: 4, ms: 0 })
  })

  it('times a section and still returns its value', () => {
    const p = new EditorProfiler()
    p.setEnabled(true)
    expect(p.time('work', () => 42)).toBe(42)
    expect(p.snapshot()['work']!.count).toBe(1)
  })

  it('still returns the value while disabled', () => {
    const p = new EditorProfiler()
    expect(p.time('work', () => 42)).toBe(42)
  })

  it('records a section that threw, and rethrows', () => {
    // Otherwise one failure silently stops the counter from ever moving.
    const p = new EditorProfiler()
    p.setEnabled(true)
    expect(() =>
      p.time('work', () => {
        throw new Error('boom')
      }),
    ).toThrow('boom')
    expect(p.snapshot()['work']!.count).toBe(1)
  })

  it('reset clears the samples but leaves it enabled', () => {
    const p = new EditorProfiler()
    p.setEnabled(true)
    p.count('a')
    p.reset()
    p.count('b')
    expect(p.snapshot()).toEqual({ b: { count: 1, ms: 0 } })
  })

  it('hands out a copy, not the live samples', () => {
    const p = new EditorProfiler()
    p.setEnabled(true)
    p.count('a')
    const snap = p.snapshot()
    snap['a']!.count = 999
    expect(p.snapshot()['a']!.count).toBe(1)
  })
})
