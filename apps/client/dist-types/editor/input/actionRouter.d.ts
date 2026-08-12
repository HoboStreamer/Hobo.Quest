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
import { type Binding } from '../bindings.js';
export interface ActionDescriptor {
    id: string;
    hold?: boolean;
}
export type ActionHandler = (id: string) => boolean;
/** Right Shift is treated as Left: nobody binds them separately. */
export declare const normalizeCode: (code: string) => string;
/**
 * True when the event came from somewhere text is being entered. A keybind
 * capture marks itself with `data-capturing`, so pressing "W" to rebind
 * forward does not also fly forward.
 */
export declare function isTypingTarget(target: EventTarget | null): boolean;
/** Specificity: more modifiers = more specific, so redo beats undo. */
export declare function specificity(b: Binding): number;
export declare class ActionRouter {
    private readonly actions;
    private readonly bindingOf;
    private readonly handler;
    private readonly held;
    constructor(actions: readonly ActionDescriptor[], bindingOf: (id: string) => Binding, handler: ActionHandler);
    /** True while the key bound to `action` is down. */
    holding(action: string): boolean;
    /** Returns true when an action ran and the event should be consumed. */
    keyDown(e: KeyboardEvent): boolean;
    keyUp(e: KeyboardEvent): void;
    /** The window losing focus must not leave a key stuck down forever. */
    clear(): void;
    /** Movement axes from the held bindings, for the flight integrator. */
    movement(): {
        x: number;
        y: number;
        z: number;
        fast: boolean;
    };
}
//# sourceMappingURL=actionRouter.d.ts.map