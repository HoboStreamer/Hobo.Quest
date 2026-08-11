/**
 * One authoritative viewport interaction state machine.
 *
 * The rule this exists to enforce: ONE pointer gesture performs ONE editor
 * action. A gizmo drag is not also a selection; a camera orbit is not also a
 * selection; a sculpt stroke never becomes a click. Previously that was
 * approximated with a `gizmoDragging` boolean, `gizmo.isHovered` and a 50ms
 * timeout — three racing signals with no ownership guarantee.
 *
 * Here, a gesture is *claimed* on pointer-down and stays claimed until
 * pointer-up. Everything else asks `canStartGesture()` / `is()` instead of
 * guessing from stale hover flags.
 */

export type InteractionState =
  | 'idle'
  /** Pointer is down over nothing special; may still become a click. */
  | 'selection-click-candidate'
  | 'camera-orbit'
  | 'camera-pan'
  | 'camera-freelook'
  | 'gizmo-drag'
  | 'placement'
  | 'terrain-sculpt'
  | 'surface-paint'
  | 'face-edit'

/** States in which the camera controller is allowed to move the camera. */
const CAMERA_STATES = new Set<InteractionState>(['camera-orbit', 'camera-pan', 'camera-freelook'])

/** States that own the pointer exclusively — nothing else may pick. */
const EXCLUSIVE_STATES = new Set<InteractionState>([
  'gizmo-drag',
  'camera-orbit',
  'camera-pan',
  'terrain-sculpt',
  'surface-paint',
])

export interface GestureOrigin {
  x: number
  y: number
  pointerId: number
}

export class InteractionController {
  private _state: InteractionState = 'idle'
  private _origin: GestureOrigin | null = null
  /** Largest pointer travel since the gesture began, in CSS pixels. */
  private _travel = 0
  private _listeners = new Set<(s: InteractionState) => void>()
  /** A click is only a click if the pointer barely moved. */
  readonly clickSlop: number

  constructor(clickSlop = 4) {
    this.clickSlop = clickSlop
  }

  get state(): InteractionState {
    return this._state
  }
  get travel(): number {
    return this._travel
  }
  get origin(): GestureOrigin | null {
    return this._origin
  }

  is(...states: InteractionState[]): boolean {
    return states.includes(this._state)
  }

  /** True when the camera controller may consume this frame's input. */
  cameraMayMove(): boolean {
    return CAMERA_STATES.has(this._state)
  }

  /**
   * True when free camera flight (WASD, wheel zoom) is permitted. Flight is
   * blocked during any object-editing gesture so a transform can never be
   * polluted by camera motion.
   */
  flightAllowed(): boolean {
    return (
      !EXCLUSIVE_STATES.has(this._state) ||
      this._state === 'camera-orbit' ||
      this._state === 'camera-pan'
    )
  }

  /** True when scene picking / selection logic may run for this event. */
  pickingAllowed(): boolean {
    return !EXCLUSIVE_STATES.has(this._state)
  }

  /** A new gesture may only start from idle (or from a bare click candidate). */
  canStartGesture(): boolean {
    return this._state === 'idle' || this._state === 'selection-click-candidate'
  }

  /**
   * Claim the pointer for `state`. Returns false when another gesture already
   * owns it — the caller must then do nothing at all.
   */
  begin(state: InteractionState, origin: GestureOrigin): boolean {
    if (state !== 'camera-freelook' && !this.canStartGesture()) return false
    this._origin = origin
    this._travel = 0
    this._set(state)
    return true
  }

  /** Feed pointer motion so click-vs-drag can be decided on release. */
  move(x: number, y: number): void {
    if (!this._origin) return
    const d = Math.hypot(x - this._origin.x, y - this._origin.y)
    if (d > this._travel) this._travel = d
  }

  /**
   * End the gesture. Returns true when it should be treated as a CLICK —
   * i.e. it was a click candidate and the pointer never meaningfully moved.
   * A drag never produces a selection.
   */
  end(): boolean {
    const wasClick = this._state === 'selection-click-candidate' && this._travel <= this.clickSlop
    this._origin = null
    this._travel = 0
    this._set('idle')
    return wasClick
  }

  /** Abandon the gesture without it counting as a click (Escape, lost lock). */
  cancel(): void {
    this._origin = null
    this._travel = 0
    this._set('idle')
  }

  onChange(fn: (s: InteractionState) => void): () => void {
    this._listeners.add(fn)
    return () => this._listeners.delete(fn)
  }

  private _set(s: InteractionState): void {
    if (this._state === s) return
    this._state = s
    for (const fn of this._listeners) fn(s)
  }
}
