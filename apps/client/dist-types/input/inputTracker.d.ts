/**
 * Raw input capture: pointer lock, mouse look, key states, wheel, and
 * edge-triggered action callbacks. Gameplay semantics live elsewhere —
 * this module only reports what the hands are doing.
 *
 * Pointer events are bound on `document` (not the canvas): while the
 * pointer is locked some browsers retarget events inconsistently, and a
 * document listener sees them regardless.
 */
export declare class InputTracker {
  private readonly canvas
  yaw: number
  pitch: number
  sensitivity: number
  private keys
  private locked
  /** UI-open state suppresses look/keys feeding the simulation. */
  uiCapture: boolean
  onAction: ((action: InputAction) => void) | null
  onWheel: ((delta: number) => void) | null
  /** When this returns true, mouse motion is redirected to rotate_held. */
  captureLook: (() => boolean) | null
  private lookDx
  private lookDy
  constructor(canvas: HTMLCanvasElement)
  /** Accumulated look deltas since the last call (viewmodel sway). */
  consumeLookDelta(): {
    dx: number
    dy: number
  }
  keyDown(code: string): boolean
  get shiftHeld(): boolean
  get pointerLocked(): boolean
  exitLock(): void
}
export type InputAction =
  | {
      kind: 'use_down'
    }
  | {
      kind: 'use_up'
    }
  | {
      kind: 'drop'
    }
  | {
      kind: 'toggle_menu'
    }
  | {
      kind: 'primary_down'
    }
  | {
      kind: 'primary_up'
    }
  | {
      kind: 'rmb_down'
    }
  | {
      kind: 'hotbar1'
    }
  | {
      kind: 'hotbar2'
    }
  | {
      kind: 'hotbar3'
    }
  | {
      kind: 'hotbar4'
    }
  | {
      kind: 'hotbar5'
    }
  | {
      kind: 'hotbar6'
    }
  | {
      kind: 'rotate_held'
      dyaw: number
      dpitch: number
    }
//# sourceMappingURL=inputTracker.d.ts.map
