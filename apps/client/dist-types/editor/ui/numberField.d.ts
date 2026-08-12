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
    input: HTMLInputElement;
    /** Live value while dragging/typing. Not a history entry. */
    onPreview?: (value: number) => void;
    /** End of gesture: make it one history entry. */
    onCommit: (value: number) => void;
    /** Called when the gesture is abandoned; restore the starting value. */
    onCancel?: () => void;
    /** Units per pixel of horizontal drag. */
    sensitivity?: number;
    step?: number;
    min?: number;
    max?: number;
    /** Author-facing degrees over a radian model. */
    degrees?: boolean;
}
export declare class NumberField {
    private readonly input;
    private readonly opts;
    private dragging;
    private startValue;
    private startX;
    private accumulated;
    /** True while `set()` is writing, so the change handler stays quiet. */
    private writing;
    private readonly disposers;
    constructor(options: NumberFieldOptions);
    private on;
    dispose(): void;
    /**
     * Write a value in without firing a commit — gizmo drags, undo, a remote
     * document replacement. This also becomes the value Escape returns to and
     * the one arrow keys step from: it is the field's truth, just not one the
     * field caused.
     */
    set(value: number | null): void;
    /**
     * Write the text only. During a drag the displayed value changes every
     * frame while `startValue` must stay at the pose the gesture started from
     * — that is what Escape restores and what makes "did this drag change
     * anything?" answerable at the end.
     */
    private show;
    value(): number;
    private display;
    private model;
    private read;
    private clamp;
    private onPointerDown;
    private onPointerMove;
    private onPointerUp;
    private finishDrag;
    private onKeyDown;
    private commit;
}
/** Trim float noise without hiding real precision. */
export declare function formatNumber(v: number): string;
/** Common value across a selection, or null when they disagree. */
export declare function commonValue(values: readonly number[]): number | null;
//# sourceMappingURL=numberField.d.ts.map