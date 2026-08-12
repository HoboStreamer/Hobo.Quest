/**
 * Keyboard actions, in one place.
 *
 * Every keyboard behaviour in the editor goes through here and therefore
 * through the centralised bindings, which is what makes them all remappable
 * and all visible in the settings panel. A shortcut wired directly to a
 * `keydown` somewhere else is invisible to conflict detection and cannot be
 * changed, so there are none.
 *
 * Two rules the previous handling got wrong:
 *  - Typing is not shortcuts. While focus is in a text field, a number field
 *    or a keybind capture, no action runs at all — otherwise typing "wasd"
 *    into a name flies the camera across the map.
 *  - The most specific binding wins. Ctrl+Shift+Z must beat Ctrl+Z rather
 *    than depending on the order the actions happen to be declared in.
 */
import { bindingMatches, type Binding } from '../bindings.js'

export interface ActionDescriptor {
  id: string
  hold?: boolean
}

export type ActionHandler = (id: string) => boolean

/** Right Shift is treated as Left: nobody binds them separately. */
export const normalizeCode = (code: string): string => (code === 'ShiftRight' ? 'ShiftLeft' : code)

/**
 * True when the event came from somewhere text is being entered. A keybind
 * capture marks itself with `data-capturing`, so pressing "W" to rebind
 * forward does not also fly forward.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || typeof el.tagName !== 'string') return false
  if (el.isContentEditable) return true
  if (el.dataset?.['capturing'] === 'true') return true
  return el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA'
}

/** Specificity: more modifiers = more specific, so redo beats undo. */
export function specificity(b: Binding): number {
  return Number(Boolean(b.shift)) + Number(Boolean(b.ctrl)) + Number(Boolean(b.alt))
}

export class ActionRouter {
  private readonly held = new Set<string>()

  constructor(
    private readonly actions: readonly ActionDescriptor[],
    private readonly bindingOf: (id: string) => Binding,
    private readonly handler: ActionHandler,
  ) {}

  /** True while the key bound to `action` is down. */
  holding(action: string): boolean {
    return this.held.has(normalizeCode(this.bindingOf(action).code))
  }

  /** Returns true when an action ran and the event should be consumed. */
  keyDown(e: KeyboardEvent): boolean {
    if (isTypingTarget(e.target)) return false
    this.held.add(normalizeCode(e.code))
    const candidates = this.actions
      .filter((a) => !a.hold && bindingMatches(this.bindingOf(a.id), e))
      .sort((a, b) => specificity(this.bindingOf(b.id)) - specificity(this.bindingOf(a.id)))
    for (const a of candidates) {
      if (this.handler(a.id)) {
        e.preventDefault()
        return true
      }
    }
    return false
  }

  keyUp(e: KeyboardEvent): void {
    this.held.delete(normalizeCode(e.code))
  }

  /** The window losing focus must not leave a key stuck down forever. */
  clear(): void {
    this.held.clear()
  }

  /** Movement axes from the held bindings, for the flight integrator. */
  movement(): { x: number; y: number; z: number; fast: boolean } {
    return {
      x: (this.holding('cam.right') ? 1 : 0) - (this.holding('cam.left') ? 1 : 0),
      y: (this.holding('cam.up') ? 1 : 0) - (this.holding('cam.down') ? 1 : 0),
      z: (this.holding('cam.forward') ? 1 : 0) - (this.holding('cam.back') ? 1 : 0),
      fast: this.holding('cam.fast'),
    }
  }
}
