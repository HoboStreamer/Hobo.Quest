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
  /** While R is held, mouse motion rotates the held prop instead of the view. */
  rotateModifier: boolean
  constructor(canvas: HTMLCanvasElement)
  keyDown(code: string): boolean
  get pointerLocked(): boolean
  exitLock(): void
}
export type InputAction =
  | {
      kind: 'use'
    }
  | {
      kind: 'freeze'
    }
  | {
      kind: 'secondary'
    }
  | {
      kind: 'place'
    }
  | {
      kind: 'toggle_inventory'
    }
  | {
      kind: 'toggle_craft'
    }
  | {
      kind: 'toggle_skills'
    }
  | {
      kind: 'toggle_players'
    }
  | {
      kind: 'primary_down'
    }
  | {
      kind: 'primary_up'
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
