import type { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import type { Scene } from '@babylonjs/core/scene.js';
/**
 * Physgun beam visuals: a thin emissive strip stretched between a source
 * point (viewmodel muzzle / remote hand) and the held prop, with a slight
 * pulse. One beam per holding player, created/removed as heldBy changes.
 */
export declare class BeamRenderer {
    private readonly scene;
    private readonly beams;
    private readonly mat;
    private time;
    constructor(scene: Scene);
    /** Reconcile active beams: key -> [from, to] world points. */
    update(dt: number, active: Map<string, [Vector3, Vector3]>): void;
    dispose(): void;
}
//# sourceMappingURL=beams.d.ts.map