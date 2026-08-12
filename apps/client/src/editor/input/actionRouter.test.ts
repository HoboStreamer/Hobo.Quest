// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { ActionRouter, isTypingTarget, normalizeCode, specificity } from './actionRouter.js'
import type { Binding } from '../bindings.js'

const BINDINGS: Record<string, Binding> = {
  'edit.undo': { code: 'KeyZ', ctrl: true },
  'edit.redo': { code: 'KeyZ', ctrl: true, shift: true },
  'tool.mesh': { code: 'Digit1' },
  'cam.forward': { code: 'KeyW' },
  'cam.left': { code: 'KeyA' },
  'cam.fast': { code: 'ShiftLeft' },
}

const router = (handler = vi.fn(() => true)) => {
  const actions = Object.keys(BINDINGS).map((id) => ({
    id,
    hold: id.startsWith('cam.') && id !== 'cam.forward' ? false : false,
  }))
  return {
    router: new ActionRouter(actions, (id) => BINDINGS[id] ?? { code: 'F24' }, handler),
    handler,
  }
}

const key = (init: KeyboardEventInit & { target?: EventTarget }): KeyboardEvent => {
  const e = new KeyboardEvent('keydown', { cancelable: true, ...init })
  if (init.target) Object.defineProperty(e, 'target', { value: init.target })
  return e
}

describe('normalizeCode', () => {
  it('treats right shift as left — nobody binds them separately', () => {
    expect(normalizeCode('ShiftRight')).toBe('ShiftLeft')
    expect(normalizeCode('KeyW')).toBe('KeyW')
  })
})

describe('isTypingTarget', () => {
  it('recognises text entry', () => {
    for (const tag of ['INPUT', 'SELECT', 'TEXTAREA']) {
      const el = document.createElement(tag)
      expect(isTypingTarget(el), tag).toBe(true)
    }
  })

  it('recognises a keybind capture, so rebinding W does not fly forward', () => {
    const el = document.createElement('button')
    el.dataset['capturing'] = 'true'
    expect(isTypingTarget(el)).toBe(true)
  })

  it('recognises contenteditable', () => {
    const el = document.createElement('div')
    Object.defineProperty(el, 'isContentEditable', { value: true })
    expect(isTypingTarget(el)).toBe(true)
  })

  it('lets the canvas through', () => {
    expect(isTypingTarget(document.createElement('canvas'))).toBe(false)
    expect(isTypingTarget(null)).toBe(false)
  })
})

describe('specificity', () => {
  it('counts modifiers, so redo outranks undo', () => {
    expect(specificity(BINDINGS['edit.redo']!)).toBeGreaterThan(specificity(BINDINGS['edit.undo']!))
  })
})

describe('ActionRouter', () => {
  it('runs the bound action and consumes the event', () => {
    const { router: r, handler } = router()
    const e = key({ code: 'Digit1' })
    expect(r.keyDown(e)).toBe(true)
    expect(handler).toHaveBeenCalledWith('tool.mesh')
    expect(e.defaultPrevented).toBe(true)
  })

  it('picks the MOST SPECIFIC binding — Ctrl+Shift+Z is redo, not undo', () => {
    const { router: r, handler } = router()
    r.keyDown(key({ code: 'KeyZ', ctrlKey: true, shiftKey: true }))
    expect(handler).toHaveBeenCalledWith('edit.redo')
    handler.mockClear()
    r.keyDown(key({ code: 'KeyZ', ctrlKey: true }))
    expect(handler).toHaveBeenCalledWith('edit.undo')
  })

  it('runs NOTHING while focus is in a text field', () => {
    // Typing "wasd" into a name must not fly the camera across the map.
    const { router: r, handler } = router()
    const input = document.createElement('input')
    expect(r.keyDown(key({ code: 'KeyW', target: input }))).toBe(false)
    expect(handler).not.toHaveBeenCalled()
    // …and the key must not register as held either.
    expect(r.holding('cam.forward')).toBe(false)
  })

  it('tracks held keys for flight', () => {
    const { router: r } = router()
    r.keyDown(key({ code: 'KeyW' }))
    expect(r.holding('cam.forward')).toBe(true)
    expect(r.movement().z).toBe(1)
    r.keyUp(new KeyboardEvent('keyup', { code: 'KeyW' }))
    expect(r.movement().z).toBe(0)
  })

  it('combines movement axes', () => {
    const { router: r } = router()
    r.keyDown(key({ code: 'KeyW' }))
    r.keyDown(key({ code: 'KeyA' }))
    r.keyDown(key({ code: 'ShiftLeft' }))
    const m = r.movement()
    expect(m).toMatchObject({ x: -1, z: 1, fast: true })
  })

  it('releases everything when the window loses focus', () => {
    // Otherwise alt-tabbing mid-flight leaves the camera drifting forever.
    const { router: r } = router()
    r.keyDown(key({ code: 'KeyW' }))
    r.clear()
    expect(r.movement().z).toBe(0)
  })

  it('leaves an unhandled key alone for the browser', () => {
    const { router: r } = router(vi.fn(() => false))
    const e = key({ code: 'Digit1' })
    expect(r.keyDown(e)).toBe(false)
    expect(e.defaultPrevented).toBe(false)
  })

  it('ignores a key nothing is bound to', () => {
    const { router: r, handler } = router()
    expect(r.keyDown(key({ code: 'KeyQ' }))).toBe(false)
    expect(handler).not.toHaveBeenCalled()
  })
})
