/**
 * Canonical transform maths for the editor.
 *
 * Every authored object — primitive static, imported model, terrain — has the
 * same transform shape: position, ORIENTATION AS A QUATERNION, and scale.
 * Euler triples are a display format only; accumulating rotations through
 * them is what produced drifting angles and gimbal surprises before.
 *
 * Group edits are expressed as ONE delta matrix applied to each member's
 * IMMUTABLE START transform:
 *
 *     newWorld = delta × startWorld
 *
 * Deriving from the start snapshot (rather than from the current, already
 * transformed state) is what makes a drag idempotent per frame and makes
 * cancel an exact restore.
 */
import { Matrix } from '@babylonjs/core/Maths/math.vector.js';
export interface EditorTransform {
    position: [number, number, number];
    /** Orientation as a quaternion [x, y, z, w]. */
    rotation: [number, number, number, number];
    scale: [number, number, number];
}
export declare const IDENTITY_TRANSFORM: EditorTransform;
export declare const cloneTransform: (t: EditorTransform) => EditorTransform;
/** Babylon uses YXZ order for its Euler helpers; match it exactly. */
export declare function transformFromEuler(position: [number, number, number], euler: [number, number, number], scale?: [number, number, number]): EditorTransform;
/** Degrees for the inspector; radians/quaternions everywhere else. */
export declare function eulerOf(t: EditorTransform): [number, number, number];
export declare function composeMatrix(t: EditorTransform): Matrix;
export declare function decomposeMatrix(m: Matrix): EditorTransform;
/**
 * The delta that carries `from` onto `to`, i.e. `delta = to × from⁻¹`.
 * Used to turn "where the gizmo pivot started / is now" into the single
 * transform every selected object should receive.
 */
export declare function deltaBetween(from: EditorTransform, to: EditorTransform): Matrix;
/** Apply a world-space delta to a start transform. */
export declare function applyDelta(start: EditorTransform, delta: Matrix): EditorTransform;
/**
 * Apply one pivot delta to every member of a group, always from the members'
 * START transforms. Passing the same pivot pair twice yields the same result,
 * which is what stops a drag from compounding frame over frame.
 */
export declare function applyGroupDelta(starts: readonly EditorTransform[], pivotStart: EditorTransform, pivotNow: EditorTransform): EditorTransform[];
/** Centroid of a set of transforms — the default group pivot. */
export declare function centroidOf(items: readonly EditorTransform[]): [number, number, number];
/** Reject NaN/Infinity and non-positive scale before they reach the document. */
export declare function isFiniteTransform(t: EditorTransform): boolean;
/** Snap a position to a grid; `step <= 0` disables snapping. */
export declare function snapPosition(p: [number, number, number], step: number): [number, number, number];
/** Mixed-value detection for the multi-selection inspector. */
export declare function mixedComponents(items: readonly EditorTransform[]): {
    position: [boolean, boolean, boolean];
    scale: [boolean, boolean, boolean];
    rotation: boolean;
};
//# sourceMappingURL=transformMath.d.ts.map