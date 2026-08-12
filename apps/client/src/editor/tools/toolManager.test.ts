import { describe, expect, it, vi } from 'vitest'
import { ToolManager } from './toolManager.js'

describe('ToolManager', () => {
  it('starts with NO tool — the editor is not always in a mode', () => {
    expect(new ToolManager().active).toBeNull()
  })

  it('activates an inactive tool', () => {
    const tm = new ToolManager()
    tm.toggle('mesh')
    expect(tm.active).toBe('mesh')
    expect(tm.is('mesh')).toBe(true)
  })

  it('DEACTIVATES the active tool when its control is used again', () => {
    // The old editor had no way to express this: pressing the active tool's
    // hotkey again did nothing at all.
    const tm = new ToolManager()
    tm.toggle('terrain')
    tm.toggle('terrain')
    expect(tm.active).toBeNull()
  })

  it('switches directly between tools', () => {
    const tm = new ToolManager()
    tm.toggle('mesh')
    tm.toggle('paint')
    expect(tm.active).toBe('paint')
  })

  it('clear() leaves every mode', () => {
    const tm = new ToolManager()
    tm.set('face')
    tm.clear()
    expect(tm.active).toBeNull()
  })

  it('notifies with both the new and the previous tool', () => {
    const seen: [string | null, string | null][] = []
    const tm = new ToolManager()
    tm.subscribe((next, prev) => seen.push([next, prev]))
    tm.set('mesh')
    tm.set('paint')
    tm.set(null)
    expect(seen).toEqual([
      ['mesh', null],
      ['paint', 'mesh'],
      [null, 'paint'],
    ])
  })

  it('stays silent when the tool did not change', () => {
    const tm = new ToolManager()
    const listener = vi.fn()
    tm.set('mesh')
    tm.subscribe(listener)
    tm.set('mesh')
    expect(listener).not.toHaveBeenCalled()
  })

  it('runs leave/enter hooks so a tool can drop its transient state', () => {
    const order: string[] = []
    const tm = new ToolManager({
      onLeave: (t) => void order.push(`leave:${t}`),
      onEnter: (t) => void order.push(`enter:${t}`),
    })
    tm.set('mesh')
    tm.set('paint')
    tm.set(null)
    expect(order).toEqual(['enter:mesh', 'leave:mesh', 'enter:paint', 'leave:paint'])
  })

  it('lets a mid-flight gesture veto the change', () => {
    const tm = new ToolManager({ onLeave: () => false })
    tm.set('terrain')
    tm.set('paint')
    expect(tm.active).toBe('terrain')
  })

  it('unsubscribes cleanly', () => {
    const tm = new ToolManager()
    const listener = vi.fn()
    const off = tm.subscribe(listener)
    tm.set('mesh')
    off()
    tm.set('paint')
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
