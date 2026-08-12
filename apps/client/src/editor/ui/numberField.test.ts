/**
 * Number-field behaviour, driven through synthesised DOM events so the
 * assertions are about what a user's pointer and keyboard actually produce.
 */
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NumberField, commonValue, formatNumber } from './numberField.js'

interface FieldOverrides {
  step?: number
  degrees?: boolean
  min?: number
  max?: number
}

function field(over: FieldOverrides = {}) {
  const input = document.createElement('input')
  document.body.append(input)
  const commits: number[] = []
  const previews: number[] = []
  const cancels = vi.fn()
  const f = new NumberField({
    input,
    onCommit: (v) => commits.push(v),
    onPreview: (v) => previews.push(v),
    onCancel: cancels,
    ...over,
  })
  f.set(0)
  return { input, field: f, commits, previews, cancels }
}

/** jsdom has no pointer capture; stub it so the field can call it. */
beforeEach(() => {
  document.body.innerHTML = ''
  Object.assign(HTMLElement.prototype, {
    setPointerCapture: () => undefined,
    releasePointerCapture: () => undefined,
    hasPointerCapture: () => true,
  })
})

const drag = (input: HTMLInputElement, dx: number, mods: Partial<PointerEventInit> = {}): void => {
  input.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: 0, bubbles: true }))
  input.dispatchEvent(new PointerEvent('pointermove', { clientX: dx, bubbles: true, ...mods }))
  input.dispatchEvent(new PointerEvent('pointerup', { button: 0, clientX: dx, bubbles: true }))
}

const key = (input: HTMLInputElement, init: KeyboardEventInit): KeyboardEvent => {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  input.dispatchEvent(e)
  return e
}

describe('NumberField: typing', () => {
  it('commits what was typed', () => {
    const f = field()
    f.input.value = '12.5'
    f.input.dispatchEvent(new Event('change'))
    expect(f.commits).toEqual([12.5])
  })

  it('falls back to the last good value for unparseable text', () => {
    const f = field()
    f.field.set(7)
    f.input.value = 'banana'
    f.input.dispatchEvent(new Event('change'))
    expect(f.commits).toEqual([7])
  })

  it('clamps to min/max', () => {
    const f = field({ min: 0, max: 10 })
    f.input.value = '99'
    f.input.dispatchEvent(new Event('change'))
    expect(f.commits).toEqual([10])
  })
})

describe('NumberField: drag to scrub', () => {
  it('previews during the drag and commits ONCE at the end', () => {
    // The whole point: a scrub is one history entry, not one per pixel.
    const f = field()
    drag(f.input, 100)
    expect(f.previews.length).toBeGreaterThan(0)
    expect(f.commits).toHaveLength(1)
  })

  it('moves the value in the drag direction', () => {
    const f = field()
    drag(f.input, 100)
    expect(f.commits[0]!).toBeGreaterThan(0)
    const g = field()
    drag(g.input, -100)
    expect(g.commits[0]!).toBeLessThan(0)
  })

  it('shift makes it fine and ctrl makes it coarse', () => {
    const fine = field()
    drag(fine.input, 100, { shiftKey: true })
    const plain = field()
    drag(plain.input, 100)
    const coarse = field()
    drag(coarse.input, 100, { ctrlKey: true })
    expect(fine.commits[0]!).toBeLessThan(plain.commits[0]!)
    expect(coarse.commits[0]!).toBeGreaterThan(plain.commits[0]!)
  })

  it('commits nothing when the drag did not move', () => {
    const f = field()
    drag(f.input, 0)
    expect(f.commits).toEqual([])
  })

  it('does not scrub a field that is being typed into', () => {
    const f = field()
    f.input.focus()
    drag(f.input, 100)
    expect(f.commits).toEqual([])
  })
})

describe('NumberField: keyboard', () => {
  it('steps with the arrow keys', () => {
    const f = field({ step: 2 })
    key(f.input, { key: 'ArrowUp' })
    expect(f.commits).toEqual([2])
    key(f.input, { key: 'ArrowDown' })
    expect(f.commits).toEqual([2, 0])
  })

  it('never lets an arrow key reach the editor as camera movement', () => {
    const f = field()
    const reachedEditor = vi.fn()
    document.body.addEventListener('keydown', reachedEditor)
    const e = key(f.input, { key: 'ArrowUp' })
    expect(e.defaultPrevented).toBe(true)
    expect(reachedEditor).not.toHaveBeenCalled()
  })

  it('Escape restores the value the gesture started from', () => {
    const f = field()
    f.field.set(5)
    f.input.value = '999'
    key(f.input, { key: 'Escape' })
    expect(f.input.value).toBe('5')
    expect(f.commits).toEqual([])
    expect(f.cancels).toHaveBeenCalled()
  })

  it('Enter commits', () => {
    const f = field()
    f.input.value = '3'
    key(f.input, { key: 'Enter' })
    expect(f.commits).toEqual([3])
  })
})

describe('NumberField: display', () => {
  it('shows an em dash for a mixed multi-selection, never a fake zero', () => {
    // "0" is a value someone then accidentally applies to everything.
    const f = field()
    f.field.set(null)
    expect(f.input.value).toBe('—')
  })

  it('converts radians to degrees for the author', () => {
    const f = field({ degrees: true })
    f.field.set(Math.PI / 2)
    expect(f.input.value).toBe('90')
    f.input.value = '180'
    f.input.dispatchEvent(new Event('change'))
    expect(f.commits[0]!).toBeCloseTo(Math.PI, 6)
  })

  it('set() does not fire a commit', () => {
    const f = field()
    f.field.set(42)
    expect(f.commits).toEqual([])
  })
})

describe('formatNumber / commonValue', () => {
  it('trims float noise without hiding precision', () => {
    expect(formatNumber(0.1 + 0.2)).toBe('0.3')
    expect(formatNumber(1.23456)).toBe('1.235')
    expect(formatNumber(-0)).toBe('0')
  })

  it('reports a shared value, or null when they disagree', () => {
    expect(commonValue([2, 2, 2])).toBe(2)
    expect(commonValue([2, 3])).toBeNull()
    expect(commonValue([])).toBeNull()
  })
})
