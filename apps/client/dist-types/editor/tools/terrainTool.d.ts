/**
 * Terrain sculpting: the brush maths, and the rule that one stroke is one
 * history entry holding only what changed.
 *
 * The heightfield the brush edits is the TerrainView's decoded working
 * buffer. Writing it back to the document as base64 on every dab would
 * re-encode a quarter of a million floats per frame, so the stroke edits the
 * buffer live and commits once on release — the same shape as a gizmo drag.
 */
export type SculptMode = 'sculpt' | 'smooth' | 'flatten';
export interface BrushSettings {
    radius: number;
    strength: number;
    feather: number;
}
export interface SculptTarget {
    heights: Float32Array;
    /** Grid subdivisions; the field is (sub+1)². */
    sub: number;
    /** Half-width in metres. */
    halfExtent: number;
}
/**
 * Apply one brush dab at terrain-local (px, pz). `sign` is +1 to raise and
 * -1 to lower. Mutates `target.heights` in place; the caller refreshes the
 * mesh and, on release, computes the delta for history.
 */
export declare function sculptDab(target: SculptTarget, px: number, pz: number, sign: number, mode: SculptMode, brush: BrushSettings): void;
/**
 * World point → terrain-local, accounting for the terrain's own transform.
 * Sculpting a rotated or scaled terrain has to land where the cursor is, not
 * where it would be if the terrain were at the origin.
 */
export declare function toTerrainLocal(world: {
    x: number;
    y: number;
    z: number;
}, pos: readonly [number, number, number], rot: readonly [number, number, number] | undefined, scale: readonly [number, number, number] | undefined): {
    x: number;
    y: number;
    z: number;
};
//# sourceMappingURL=terrainTool.d.ts.map