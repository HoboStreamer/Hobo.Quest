/**
 * Everything that shows what is selected, in one place.
 *
 * The old code decided highlights from mesh identity, scattered across
 * `deselect()`, `select()`, five `selected*` variables and four `multi*`
 * arrays — so an undo, a remote merge or a material change (all of which
 * rebuild meshes) silently dropped the highlight, and a terrain's wireframe
 * flickered off whenever anything rebuilt.
 *
 * Here the visuals are derived from the selection SET and the view registry
 * every time they are recomputed. A mesh being rebuilt cannot lose a
 * highlight, because the highlight was never attached to the mesh.
 *
 * The five states are visually distinct on purpose:
 *   hover           pale blue outline
 *   local secondary warm amber
 *   local primary   strong orange (what the inspector is editing)
 *   remote selected the collaborator's colour
 *   remote locked   the collaborator's colour, plus a lock badge in the UI
 */
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import type { Scene } from '@babylonjs/core/scene.js';
import type { EditorViewRegistry } from '../viewport/editorViewRegistry.js';
export declare const C_PRIMARY: Color3;
export declare const C_SECONDARY: Color3;
export declare const C_HOVER: Color3;
export interface RemoteSelection {
    color: Color3;
    ids: string[];
}
export interface SelectionVisualState {
    /** Local selection, primary first. */
    ids: readonly string[];
    primary: string | null;
    hover: string | null;
    /** peer id → what that collaborator has selected. */
    remote: ReadonlyMap<number, RemoteSelection>;
    /** object id → lock owner colour. */
    locks: ReadonlyMap<string, string>;
    /** True while the terrain tool wants a hovered terrain's grid shown. */
    terrainHoverWire: string | null;
    /** Terrain being sculpted/painted right now — its wire is pinned on. */
    strokeWire: string | null;
}
export declare class SelectionVisuals {
    private readonly views;
    private readonly layer;
    constructor(scene: Scene, views: EditorViewRegistry);
    /**
     * Recompute every highlight from the current state. Cheap enough to call
     * on any selection or document change; deliberately NOT called per frame.
     */
    refresh(state: SelectionVisualState): void;
    /**
     * A selected terrain keeps its grid visible until deselected — it is the
     * only cue that a flat terrain is selected at all, and it must survive
     * hover, transforms, sculpting, undo and UI interaction.
     */
    private refreshTerrainWires;
    private add;
    dispose(): void;
}
//# sourceMappingURL=selectionVisuals.d.ts.map