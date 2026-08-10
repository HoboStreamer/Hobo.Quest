/**
 * Raw input capture: pointer lock, mouse look, key states, wheel, and
 * edge-triggered action callbacks. Gameplay semantics live elsewhere —
 * this module only reports what the hands are doing.
 *
 * Pointer events are bound on `document` (not the canvas): while the
 * pointer is locked some browsers retarget events inconsistently, and a
 * document listener sees them regardless.
 */
export class InputTracker {
  yaw = 0
  pitch = 0
  sensitivity = 0.0022
  private keys = new Set<string>()
  private locked = false
  /** UI-open state suppresses look/keys feeding the simulation. */
  uiCapture = false

  onAction: ((action: InputAction) => void) | null = null
  onWheel: ((delta: number) => void) | null = null
  /** When this returns true, mouse motion is redirected to rotate_held. */
  captureLook: (() => boolean) | null = null
  private lookDx = 0
  private lookDy = 0

  constructor(private readonly canvas: HTMLCanvasElement) {
    // Lock on button DOWN, not on click: click only fires on RELEASE, so a
    // click-and-hold (the physgun grab gesture) would spend the entire hold
    // unlocked — no look, no actions, "game frozen until I let go".
    canvas.addEventListener('pointerdown', () => {
      if (!this.uiCapture && !this.locked) {
        canvas.requestPointerLock()
      }
    })
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas
    })
    document.addEventListener('contextmenu', (e) => {
      if (this.locked) e.preventDefault()
    })
    // pointermove, NOT mousemove: canceling pointerdown (which we must do to
    // stop native drag/selection) suppresses ALL compatibility mouse events
    // for the rest of that press — including mousemove. Holding a button
    // would freeze the view. Pointer events keep flowing regardless.
    document.addEventListener('pointermove', (e) => {
      if (!this.locked || this.uiCapture) return
      if (this.captureLook?.()) {
        this.onAction?.({
          kind: 'rotate_held',
          dyaw: e.movementX * 0.005,
          dpitch: e.movementY * 0.005,
        })
        return
      }
      this.yaw += e.movementX * this.sensitivity
      this.pitch -= e.movementY * this.sensitivity
      this.lookDx += e.movementX * this.sensitivity
      this.lookDy += e.movementY * this.sensitivity
      const limit = Math.PI / 2 - 0.01
      this.pitch = Math.max(-limit, Math.min(limit, this.pitch))
    })
    document.addEventListener('keydown', (e) => {
      if (e.repeat) return
      this.keys.add(e.code)
      if (e.code === 'KeyE' && !this.uiCapture) {
        e.preventDefault()
        this.onAction?.({ kind: 'use_down' })
        return
      }
      const action = KEY_ACTIONS[e.code]
      if (action) {
        const uiToggle = action === 'toggle_menu'
        if (!this.uiCapture || uiToggle) {
          e.preventDefault()
          this.onAction?.({ kind: action })
        }
      }
      if (e.code === 'Tab') e.preventDefault()
    })
    document.addEventListener('keyup', (e) => {
      this.keys.delete(e.code)
      if (e.code === 'KeyE' && !this.uiCapture) {
        this.onAction?.({ kind: 'use_up' })
      }
    })
    document.addEventListener('pointerdown', (e) => {
      if (!this.locked || this.uiCapture) return
      // Without this, holding a button and moving starts a native browser
      // drag/selection, which SWALLOWS all mousemove events until release —
      // the game appears frozen while the physgun button is held.
      e.preventDefault()
      if (e.button === 0) this.onAction?.({ kind: 'primary_down' })
      if (e.button === 2) this.onAction?.({ kind: 'rmb_down' })
    })
    document.addEventListener('dragstart', (e) => {
      // Native drags are only ever wanted for inventory slots in the menu.
      if (!this.uiCapture) e.preventDefault()
    })
    document.addEventListener('selectstart', (e) => {
      if (!this.uiCapture) e.preventDefault()
    })
    document.addEventListener('pointerup', (e) => {
      if (e.button === 0) this.onAction?.({ kind: 'primary_up' })
    })
    document.addEventListener(
      'wheel',
      (e) => {
        if (this.locked && !this.uiCapture) this.onWheel?.(Math.sign(e.deltaY))
      },
      { passive: true },
    )
    window.addEventListener('blur', () => this.keys.clear())
  }

  /** Accumulated look deltas since the last call (viewmodel sway). */
  consumeLookDelta(): { dx: number; dy: number } {
    const d = { dx: this.lookDx, dy: this.lookDy }
    this.lookDx = 0
    this.lookDy = 0
    return d
  }

  keyDown(code: string): boolean {
    return !this.uiCapture && this.keys.has(code)
  }

  get shiftHeld(): boolean {
    return this.keys.has('ShiftLeft') || this.keys.has('ShiftRight')
  }

  get pointerLocked(): boolean {
    return this.locked
  }

  exitLock(): void {
    if (this.locked) document.exitPointerLock()
  }

  /** Re-engage pointer lock (used when closing menus — needs a user gesture). */
  requestLock(): void {
    if (!this.locked && !this.uiCapture) this.canvas.requestPointerLock()
  }

  /** Test harness only: headless browsers cannot pointer-lock. */
  debugForceLock(): void {
    this.locked = true
  }
}

export type InputAction =
  | { kind: 'use_down' }
  | { kind: 'use_up' }
  | { kind: 'drop' }
  | { kind: 'toggle_menu' }
  | { kind: 'primary_down' }
  | { kind: 'primary_up' }
  | { kind: 'rmb_down' }
  | { kind: 'hotbar1' }
  | { kind: 'hotbar2' }
  | { kind: 'hotbar3' }
  | { kind: 'hotbar4' }
  | { kind: 'hotbar5' }
  | { kind: 'hotbar6' }
  | { kind: 'rotate_held'; dyaw: number; dpitch: number }

const KEY_ACTIONS: Record<
  string,
  Exclude<InputAction, { kind: 'rotate_held' } | { kind: 'use_down' } | { kind: 'use_up' }>['kind']
> = {
  KeyG: 'drop',
  Tab: 'toggle_menu',
  Digit1: 'hotbar1',
  Digit2: 'hotbar2',
  Digit3: 'hotbar3',
  Digit4: 'hotbar4',
  Digit5: 'hotbar5',
  Digit6: 'hotbar6',
}
