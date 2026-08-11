import { describe, expect, it } from 'vitest'
import {
  ACTIONS,
  bindingFromEvent,
  bindingMatches,
  defaultBindings,
  findConflicts,
  formatBinding,
  loadBindings,
} from './bindings.js'

const ev = (code: string, mods: Partial<KeyboardEvent> = {}): KeyboardEvent =>
  ({
    code,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ...mods,
  }) as KeyboardEvent

describe('editor bindings', () => {
  it('ships defaults with no internal conflicts', () => {
    const b = defaultBindings()
    for (const a of ACTIONS) {
      expect(findConflicts(b, b[a.id]!, a.id)).toEqual([])
    }
  })

  it('matches modifiers exactly for non-modifier keys', () => {
    const b = defaultBindings()
    expect(bindingMatches(b['edit.undo']!, ev('KeyZ', { ctrlKey: true }))).toBe(true)
    expect(bindingMatches(b['edit.undo']!, ev('KeyZ'))).toBe(false)
    expect(bindingMatches(b['cam.freelook']!, ev('KeyZ'))).toBe(true)
    expect(bindingMatches(b['cam.freelook']!, ev('KeyZ', { ctrlKey: true }))).toBe(false)
    expect(bindingMatches(b['edit.redo']!, ev('KeyZ', { ctrlKey: true, shiftKey: true }))).toBe(
      true,
    )
  })

  it('hold-modifier bindings match regardless of other modifiers', () => {
    const b = defaultBindings()
    expect(bindingMatches(b['cam.fast']!, ev('ShiftLeft', { shiftKey: true }))).toBe(true)
    expect(bindingMatches(b['cam.fast']!, ev('ShiftRight', { shiftKey: true }))).toBe(true)
  })

  it('detects conflicts including modifier-sensitive ones', () => {
    const b = defaultBindings()
    expect(findConflicts(b, { code: 'Digit1' }, 'tool.paint')).toEqual(['tool.terrain'])
    expect(findConflicts(b, { code: 'KeyZ', ctrl: true }, 'x')).toEqual(['edit.undo'])
    expect(findConflicts(b, { code: 'KeyZ' }, 'x')).toEqual(['cam.freelook'])
  })

  it('serializes round-trip and tolerates garbage', () => {
    const b = defaultBindings()
    b['tool.select'] = { code: 'KeyV' }
    const loaded = loadBindings(JSON.stringify(b))
    expect(loaded['tool.select']).toEqual({ code: 'KeyV' })
    expect(loadBindings('{{{')['tool.select']).toEqual({ code: 'Digit5' })
    expect(loadBindings(null)['edit.save']).toEqual({ code: 'KeyS', ctrl: true })
  })

  it('formats and captures bindings', () => {
    expect(formatBinding({ code: 'KeyZ', ctrl: true, shift: true })).toBe('Ctrl+Shift+Z')
    expect(formatBinding({ code: 'BracketRight' })).toBe(']')
    expect(bindingFromEvent(ev('KeyQ', { ctrlKey: true }))).toEqual({ code: 'KeyQ', ctrl: true })
    expect(bindingFromEvent(ev('ShiftRight', { shiftKey: true }))).toEqual({ code: 'ShiftLeft' })
  })

  it('no default camera-movement key collides with a tool key', () => {
    const b = defaultBindings()
    const move = ['cam.forward', 'cam.back', 'cam.left', 'cam.right', 'cam.up', 'cam.down']
    const tools = ACTIONS.filter((a) => a.group === 'tools').map((a) => a.id)
    for (const m of move) {
      for (const t of tools) {
        expect(JSON.stringify(b[m])).not.toBe(JSON.stringify(b[t]))
      }
    }
  })
})
