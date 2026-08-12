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
export interface GestureOrigin {
  x: number
  y: number
  pointerId: number
}
export declare class InteractionController {
  private _state
  private _origin
  /** Largest pointer travel since the gesture began, in CSS pixels. */
  private _travel
  private _listeners
  /** A click is only a click if the pointer barely moved. */
  readonly clickSlop: number
  constructor(clickSlop?: number)
  get state(): InteractionState
  get travel(): number
  get origin(): GestureOrigin | null
  is(...states: InteractionState[]): boolean
  /** True when the camera controller may consume this frame's input. */
  cameraMayMove(): boolean
  /**
   * True when free camera flight (WASD, wheel zoom) is permitted. Flight is
   * blocked during any object-editing gesture so a transform can never be
   * polluted by camera motion.
   */
  flightAllowed(): boolean
  /** True when scene picking / selection logic may run for this event. */
  pickingAllowed(): boolean
  /** A new gesture may only start from idle (or from a bare click candidate). */
  canStartGesture(): boolean
  /**
   * Claim the pointer for `state`. Returns false when another gesture already
   * owns it — the caller must then do nothing at all.
   */
  begin(state: InteractionState, origin: GestureOrigin): boolean
  /** Feed pointer motion so click-vs-drag can be decided on release. */
  move(x: number, y: number): void
  /**
   * End the gesture. Returns true when it should be treated as a CLICK —
   * i.e. it was a click candidate and the pointer never meaningfully moved.
   * A drag never produces a selection.
   */
  end(): boolean
  /** Abandon the gesture without it counting as a click (Escape, lost lock). */
  cancel(): void
  onChange(fn: (s: InteractionState) => void): () => void
  private _set
}
//# sourceMappingURL=interactionController.d.ts.map
