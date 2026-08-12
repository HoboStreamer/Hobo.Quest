import { describe, expect, it, vi } from 'vitest'
import { SelectionManager, selectModeFromEvent } from './selectionManager.js'

describe('SelectionManager', () => {
  it('plain click replaces the selection', () => {
    const s = new SelectionManager()
    s.applyClick('a', 'replace')
    s.applyClick('b', 'replace')
    expect(s.ids()).toEqual(['b'])
    expect(s.primaryId).toBe('b')
  })

  it('walks the exact Ctrl/Alt sequence from the spec', () => {
    const s = new SelectionManager()
    s.applyClick('A', 'replace')
    expect(s.ids()).toEqual(['A'])
    s.applyClick('B', 'add')
    expect(new Set(s.ids())).toEqual(new Set(['A', 'B']))
    s.applyClick('C', 'add')
    expect(new Set(s.ids())).toEqual(new Set(['A', 'B', 'C']))
    s.applyClick('B', 'remove')
    expect(new Set(s.ids())).toEqual(new Set(['A', 'C']))
    // Alt on an UNSELECTED object does nothing.
    s.applyClick('D', 'remove')
    expect(new Set(s.ids())).toEqual(new Set(['A', 'C']))
    // Ctrl / Alt on empty space preserve the selection.
    s.applyClick(null, 'add')
    s.applyClick(null, 'remove')
    expect(new Set(s.ids())).toEqual(new Set(['A', 'C']))
    // Plain click on an object replaces; plain click on empty clears.
    s.applyClick('D', 'replace')
    expect(s.ids()).toEqual(['D'])
    s.applyClick(null, 'replace')
    expect(s.ids()).toEqual([])
    expect(s.primaryId).toBeNull()
  })

  it('Ctrl+click on an already selected object keeps it selected', () => {
    const s = new SelectionManager()
    s.replaceMany(['a', 'b'])
    s.applyClick('a', 'add')
    expect(new Set(s.ids())).toEqual(new Set(['a', 'b']))
    expect(s.primaryId).toBe('a')
  })

  it('promotes a new primary when the primary is removed', () => {
    const s = new SelectionManager()
    s.replaceMany(['a', 'b', 'c'])
    expect(s.primaryId).toBe('a')
    s.remove('a')
    expect(s.primaryId).toBe('b')
  })

  it('refuses mutations while frozen (mid transform)', () => {
    const s = new SelectionManager()
    s.replaceMany(['a', 'b'])
    s.freeze()
    expect(s.applyClick('c', 'replace')).toBe(false)
    expect(s.applyClick('c', 'add')).toBe(false)
    expect(s.clear()).toBe(false)
    expect(new Set(s.ids())).toEqual(new Set(['a', 'b']))
    s.unfreeze()
    expect(s.applyClick('c', 'replace')).toBe(true)
  })

  it('retain() drops only the ids that disappeared', () => {
    const s = new SelectionManager()
    s.replaceMany(['a', 'b', 'c'])
    const alive = new Set(['a', 'c'])
    expect(s.retain((id) => alive.has(id))).toBe(true)
    expect(s.ids()).toEqual(['a', 'c'])
    expect(s.primaryId).toBe('a')
    // No-op when nothing vanished.
    expect(s.retain((id) => alive.has(id))).toBe(false)
  })

  it('notifies listeners only on real changes', () => {
    const s = new SelectionManager()
    const spy = vi.fn()
    s.onChange(spy)
    s.replace('a')
    s.replace('a')
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('maps modifiers to modes (Shift is not multi-select)', () => {
    expect(selectModeFromEvent({})).toBe('replace')
    expect(selectModeFromEvent({ ctrlKey: true })).toBe('add')
    expect(selectModeFromEvent({ metaKey: true })).toBe('add')
    expect(selectModeFromEvent({ altKey: true })).toBe('remove')
    // Alt wins over Ctrl so Alt+Ctrl never silently adds.
    expect(selectModeFromEvent({ altKey: true, ctrlKey: true })).toBe('remove')
  })
})
