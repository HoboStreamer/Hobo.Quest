/**
 * Editor navigation.
 *
 * Babylon's own camera inputs are cleared: they fight the editor's action
 * system for the same keys and cannot be remapped, and their wheel handler
 * dollies along the view axis regardless of what is under the cursor. All
 * movement comes from here, driven by the centralised bindings.
 *
 * Three rules the previous handling broke:
 *  - MMB uses POINTER CAPTURE, so a drag keeps working past the canvas edge
 *    and the browser's middle-click autoscroll never appears.
 *  - Nothing moves while another gesture owns the pointer, so a gizmo drag
 *    cannot also orbit the camera.
 *  - The wheel zooms toward what is UNDER the cursor, not toward the centre
 *    of the screen, and scales its step by distance so approaching a small
 *    object does not overshoot it.
 */
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import type { FreeCamera } from '@babylonjs/core/Cameras/freeCamera.js';
import type { Scene } from '@babylonjs/core/scene.js';
import type { InteractionController } from '../interaction/interactionController.js';
export interface CameraControllerOptions {
    scene: Scene;
    camera: FreeCamera;
    canvas: HTMLCanvasElement;
    interaction: InteractionController;
    /** True while the named binding's key is held (centralised bindings). */
    holding: (action: string) => boolean;
    /**
     * True when the wheel belongs to something else — a placement preview
     * rotating, a brush radius. The context is the tool's, not the camera's.
     */
    wheelIsClaimed: () => boolean;
}
export declare class EditorCameraController {
    private readonly opts;
    private freeLook;
    private mmb;
    private lastX;
    private lastY;
    private readonly disposers;
    constructor(opts: CameraControllerOptions);
    private on;
    dispose(): void;
    get isFreeLook(): boolean;
    get isDragging(): boolean;
    toggleFreeLook(): void;
    private onPointerDown;
    private onPointerUp;
    private onPointerMove;
    private onMouseMove;
    /**
     * Cursor-centric dolly. Picks the point under the cursor and moves along
     * the ray toward it, so the thing you are looking at stays put and grows —
     * which is what makes approaching a doorway feel aimed rather than
     * approximate. Step scales with distance and clamps at both ends.
     */
    private onWheel;
    /** Frame a world-space bounding sphere (F, Outliner focus). */
    frame(centre: Vector3, radius: number): void;
    /** Fly step for the movement actions, in world units for this frame. */
    fly(forward: number, right: number, up: number, speed: number): void;
    /** Project a world point to screen pixels (probe + Outliner helpers). */
    worldToScreen(p: Vector3): [number, number];
}
//# sourceMappingURL=editorCameraController.d.ts.map