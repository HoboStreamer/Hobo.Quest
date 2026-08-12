import { describe, expect, it } from 'vitest'
import { InteractionController } from './interactionController.js'

const at = (x: number, y: number) => ({ x, y, pointerId: 1 })

describe('InteractionController', () => {
  it('starts idle and allows a gesture', () => {
    const c = new InteractionController()
    expect(c.state).toBe('idle')
    expect(c.canStartGesture()).toBe(true)
    expect(c.pickingAllowed()).toBe(true)
  })

  it('gives a claimed gesture exclusive ownership of the pointer', () => {
    const c = new InteractionController()
    expect(c.begin('gizmo-drag', at(10, 10))).toBe(true)
    // Nothing else may claim the pointer or pick while the gizmo owns it.
    expect(c.begin('selection-click-candidate', at(10, 10))).toBe(false)
    expect(c.begin('terrain-sculpt', at(10, 10))).toBe(false)
    expect(c.pickingAllowed()).toBe(false)
    expect(c.cameraMayMove()).toBe(false)
  })

  it('freezes the camera during a gizmo drag and restores it after', () => {
    const c = new InteractionController()
    c.begin('gizmo-drag', at(0, 0))
    expect(c.cameraMayMove()).toBe(false)
    expect(c.flightAllowed()).toBe(false)
    c.end()
    expect(c.cameraMayMove()).toBe(false) // idle: no camera gesture active
    expect(c.flightAllowed()).toBe(true)
  })

  it('a short press is a click, a drag is not', () => {
    const c = new InteractionController()
    c.begin('selection-click-candidate', at(100, 100))
    c.move(101, 100)
    c.move(102, 101)
    expect(c.end()).toBe(true)

    c.begin('selection-click-candidate', at(100, 100))
    c.move(140, 100)
    c.move(100, 100) // back to the origin — still a drag: travel is the MAX
    expect(c.end()).toBe(false)
  })

  it('a drag gesture never reports a click', () => {
    const c = new InteractionController()
    c.begin('camera-orbit', at(0, 0))
    expect(c.end()).toBe(false)
    c.begin('terrain-sculpt', at(0, 0))
    expect(c.end()).toBe(false)
  })

  it('cancel abandons without producing a click', () => {
    const c = new InteractionController()
    c.begin('selection-click-candidate', at(5, 5))
    c.cancel()
    expect(c.state).toBe('idle')
    expect(c.end()).toBe(false)
  })

  it('camera gestures allow camera motion but block picking', () => {
    const c = new InteractionController()
    c.begin('camera-orbit', at(0, 0))
    expect(c.cameraMayMove()).toBe(true)
    expect(c.pickingAllowed()).toBe(false)
    c.end()
    c.begin('camera-pan', at(0, 0))
    expect(c.cameraMayMove()).toBe(true)
  })

  it('freelook may be entered from any state (pointer lock is modal)', () => {
    const c = new InteractionController()
    c.begin('gizmo-drag', at(0, 0))
    expect(c.begin('camera-freelook', at(0, 0))).toBe(true)
    expect(c.cameraMayMove()).toBe(true)
  })

  it('emits state changes once per transition', () => {
    const c = new InteractionController()
    const seen: string[] = []
    c.onChange((s) => seen.push(s))
    c.begin('gizmo-drag', at(0, 0))
    c.move(1, 1)
    c.end()
    expect(seen).toEqual(['gizmo-drag', 'idle'])
  })
})
