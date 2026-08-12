/**
 * The editor's number input.
 *
 * Typing a value into a box is the least of what this has to do. Level
 * editors are driven by DRAGGING numbers, and the details are what make it
 * usable: a drag must be one undo entry rather than one per pixel, Escape
 * must return the value you started from, arrow keys must step, a modifier
 * must make the step fine or coarse, and the box must keep showing the truth
 * while a gizmo moves the same object underneath it.
 *
 * Committing is explicit (`onCommit`) and separate from previewing
 * (`onPreview`), which is what lets the caller open one history transaction
 * for the whole gesture.
 */
export interface NumberFieldOptions {
  input: HTMLInputElement
  /** Live value while dragging/typing. Not a history entry. */
  onPreview?: (value: number) => void
  /** End of gesture: make it one history entry. */
  onCommit: (value: number) => void
  /** Called when the gesture is abandoned; restore the starting value. */
  onCancel?: () => void
  /** Units per pixel of horizontal drag. */
  sensitivity?: number
  step?: number
  min?: number
  max?: number
  /** Author-facing degrees over a radian model. */
  degrees?: boolean
}

const FINE = 0.1
const COARSE = 10

export class NumberField {
  private readonly input: HTMLInputElement
  private readonly opts: Required<Pick<NumberFieldOptions, 'sensitivity' | 'step'>> &
    NumberFieldOptions
  private dragging = false
  private startValue = 0
  private startX = 0
  private accumulated = 0
  /** True while `set()` is writing, so the change handler stays quiet. */
  private writing = false
  private readonly disposers: (() => void)[] = []

  constructor(options: NumberFieldOptions) {
    this.opts = { sensitivity: 0.05, step: 1, ...options }
    this.input = options.input
    this.input.classList.add('scrub')

    this.on(this.input, 'pointerdown', (e) => this.onPointerDown(e as PointerEvent))
    this.on(this.input, 'pointermove', (e) => this.onPointerMove(e as PointerEvent))
    this.on(this.input, 'pointerup', (e) => this.onPointerUp(e as PointerEvent))
    this.on(this.input, 'keydown', (e) => this.onKeyDown(e as KeyboardEvent))
    this.on(this.input, 'change', () => {
      if (!this.writing) this.commit(this.read())
    })
    this.on(this.input, 'blur', () => {
      if (this.dragging) this.finishDrag()
    })
  }

  private on(target: EventTarget, type: string, fn: (e: Event) => void): void {
    target.addEventListener(type, fn)
    this.disposers.push(() => target.removeEventListener(type, fn))
  }

  dispose(): void {
    for (const d of this.disposers) d()
    this.disposers.length = 0
  }

  /**
   * Write a value in without firing a commit — gizmo drags, undo, a remote
   * document replacement. This also becomes the value Escape returns to and
   * the one arrow keys step from: it is the field's truth, just not one the
   * field caused.
   */
  set(value: number | null): void {
    if (value !== null) {
      this.startValue = value
      this.accumulated = value
    }
    this.show(value)
  }

  /**
   * Write the text only. During a drag the displayed value changes every
   * frame while `startValue` must stay at the pose the gesture started from
   * — that is what Escape restores and what makes "did this drag change
   * anything?" answerable at the end.
   */
  private show(value: number | null): void {
    this.writing = true
    // Mixed values across a multi-selection show an em dash, never a fake 0:
    // "0" is a value someone will then accidentally apply to everything.
    this.input.value = value === null ? '—' : formatNumber(this.display(value))
    this.writing = false
  }

  value(): number {
    return this.read()
  }

  private display(v: number): number {
    return this.opts.degrees ? (v * 180) / Math.PI : v
  }

  private model(v: number): number {
    return this.opts.degrees ? (v * Math.PI) / 180 : v
  }

  private read(): number {
    const raw = Number.parseFloat(this.input.value)
    if (!Number.isFinite(raw)) return this.startValue
    return this.clamp(this.model(raw))
  }

  private clamp(v: number): number {
    const { min, max } = this.opts
    let out = v
    if (min !== undefined) out = Math.max(min, out)
    if (max !== undefined) out = Math.min(max, out)
    return out
  }

  private onPointerDown(e: PointerEvent): void {
    // Only a drag on an unfocused field scrubs; once focused it is a text
    // box, so selecting characters with the mouse still works.
    if (document.activeElement === this.input) return
    if (e.button !== 0) return
    this.dragging = true
    this.startValue = this.read()
    this.startX = e.clientX
    this.accumulated = this.startValue
    this.input.setPointerCapture(e.pointerId)
    e.preventDefault()
  }

  private onPointerMove(e: PointerEvent): void {
    if (!this.dragging) return
    const scale = e.shiftKey ? FINE : e.ctrlKey || e.metaKey ? COARSE : 1
    const dx = e.clientX - this.startX
    this.startX = e.clientX
    this.accumulated = this.clamp(
      this.accumulated + this.model(dx * this.opts.sensitivity * this.opts.step * scale),
    )
    this.show(this.accumulated)
    this.opts.onPreview?.(this.accumulated)
  }

  private onPointerUp(e: PointerEvent): void {
    if (!this.dragging) return
    if (this.input.hasPointerCapture(e.pointerId)) this.input.releasePointerCapture(e.pointerId)
    this.finishDrag()
  }

  private finishDrag(): void {
    this.dragging = false
    if (this.accumulated === this.startValue) return
    this.commit(this.accumulated)
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      this.dragging = false
      this.set(this.startValue)
      this.opts.onCancel?.()
      this.input.blur()
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      this.commit(this.read())
      this.input.blur()
      return
    }
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
    e.preventDefault()
    // Stop it reaching the editor's action system: an arrow key inside a
    // field is a step, never camera movement.
    e.stopPropagation()
    const scale = e.shiftKey ? FINE : e.ctrlKey || e.metaKey ? COARSE : 1
    const delta = this.model(this.opts.step * scale) * (e.key === 'ArrowUp' ? 1 : -1)
    this.startValue = this.read()
    this.commit(this.clamp(this.startValue + delta))
  }

  private commit(value: number): void {
    this.startValue = value
    this.set(value)
    this.opts.onCommit(value)
  }
}

/** Trim float noise without hiding real precision. */
export function formatNumber(v: number): string {
  if (!Number.isFinite(v)) return '0'
  const rounded = Math.round(v * 1000) / 1000
  return String(Object.is(rounded, -0) ? 0 : rounded)
}

/** Common value across a selection, or null when they disagree. */
export function commonValue(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const first = values[0]!
  return values.every((v) => Math.abs(v - first) < 1e-6) ? first : null
}
