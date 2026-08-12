import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import type { Scene } from '@babylonjs/core/scene.js';
import type { InteractionController } from '../interaction/interactionController.js';
import type { EditorTransform } from './transformMath.js';
import type { TransformSpace } from './editorPreferences.js';
export type GizmoMode = 'move' | 'rotate' | 'scale';
export interface GizmoControllerOptions {
    scene: Scene;
    interaction: InteractionController;
    /** Begin a transform over these ids; false = do not start the drag. */
    onDragStart: (mode: GizmoMode) => boolean;
    onDrag: (pivot: EditorTransform) => void;
    onDragEnd: () => void;
}
export declare class GizmoController {
    private readonly opts;
    private readonly manager;
    private readonly pivot;
    private readonly wired;
    private mode;
    private space;
    private snap;
    constructor(opts: GizmoControllerOptions);
    get active(): boolean;
    /** The pivot's current pose — what a drag frame reports. */
    pivotTransform(): EditorTransform;
    /**
     * Put the pivot at the group's centre with identity rotation and scale, so
     * the gizmo reports DELTAS — which is what the group inspector labels them
     * as, and what makes a group rotation rotate about the group rather than
     * about whichever member happened to be first.
     */
    setPivot(centre: readonly [number, number, number], orientation?: EditorTransform): void;
    attach(on: boolean): void;
    setMode(mode: GizmoMode): void;
    get currentMode(): GizmoMode;
    /**
     * World vs local handle orientation. This changes the MATHS, not only the
     * label: in local space the handles align with the object's own axes, so
     * dragging "X" on a rotated wall slides along the wall.
     */
    setSpace(space: TransformSpace): void;
    /** Snap increments; 0 disables. Applied to Babylon's own drag steps. */
    setSnap(translate: number, rotate: number, scale: number): void;
    private applySnap;
    /** Screen position of a handle, for the browser test harness. */
    handleScreenPosition(axis: 'x' | 'y' | 'z'): TransformNode | null;
    get utilityScene(): Scene | null;
    private wire;
    /** Frame helper: the pivot's world position as a Vector3. */
    pivotPosition(): Vector3;
    dispose(): void;
}
//# sourceMappingURL=gizmoController.d.ts.map