/**
 * The Inspector: a registry of per-kind property editors.
 *
 * The old inspector was one floating popover with every control for every
 * kind in it, shown and hidden by hand — so a terrain showed cylinder radius
 * fields, a light showed box dimensions, and adding a kind meant another
 * round of `style.display = 'none'`. Here each kind declares the fields it
 * has, and the panel renders exactly those.
 *
 * Multi-selection shows the fields the selection has in COMMON. Where the
 * values disagree the field shows an em dash rather than a zero: an editor
 * that displays 0 for "these differ" invites you to apply 0 to all of them.
 *
 * Every edit goes through the callbacks, which route to CommandHistory.
 * Nothing here writes to the document.
 */
import type { EditorDocument, EditorObject, EditorObjectKind } from '../document/editorDocument.js';
export type FieldType = 'number' | 'text' | 'color' | 'checkbox' | 'select' | 'readonly';
export interface FieldSpec {
    key: string;
    label: string;
    type: FieldType;
    /** Radians in the model, degrees in the box. */
    degrees?: boolean;
    step?: number;
    min?: number;
    max?: number;
    options?: {
        value: string;
        label: string;
    }[];
    /** Vector components are edited together under one label. */
    vector?: 3;
    /** Not editable while another user holds the lock; still readable. */
    section: string;
}
export interface InspectorCallbacks {
    /** One edit → one history entry, applied to every selected id. */
    setProperty: (ids: readonly string[], key: string, value: unknown) => void;
    /** A scrub gesture: preview without recording. */
    previewProperty?: (ids: readonly string[], key: string, value: unknown) => void;
    beginGesture?: (label: string) => void;
    endGesture?: () => void;
}
/**
 * The fields for a kind. Dimensions and transform scale are DELIBERATELY
 * separate: a 2 m box scaled ×3 and a 6 m box collide identically but mean
 * different things to an author, and conflating them is how a resize ends up
 * changing a shared prefab.
 */
export declare function fieldsFor(kind: EditorObjectKind, object: EditorObject | null): FieldSpec[];
/** Fields shared by every selected object, in the first one's order. */
export declare function commonFields(doc: EditorDocument, ids: readonly string[]): {
    fields: FieldSpec[];
    kinds: EditorObjectKind[];
};
export declare const readPath: (object: unknown, path: string) => unknown;
/**
 * What a field should show for a selection: the shared value, or null when
 * they disagree. `null` renders as an em dash.
 */
export declare function displayValue(doc: EditorDocument, ids: readonly string[], field: FieldSpec, component?: number): string | number | boolean | null;
export interface InspectorState {
    ids: readonly string[];
    /** Set while another user holds the lock: readable, not editable. */
    lockedBy: string | null;
}
export declare class Inspector {
    private readonly root;
    private readonly doc;
    private readonly callbacks;
    /** Texture options for `select` fields; supplied by the asset registry. */
    private readonly textureOptions;
    private state;
    constructor(root: HTMLElement, doc: EditorDocument, callbacks: InspectorCallbacks, 
    /** Texture options for `select` fields; supplied by the asset registry. */
    textureOptions?: () => {
        value: string;
        label: string;
    }[]);
    setState(next: InspectorState): void;
    /** Values only — what a gizmo drag or an undo needs. */
    refreshValues(): void;
    private specs;
    private specFor;
    private render;
    private renderField;
    private renderInput;
    private commitInput;
    private commit;
}
//# sourceMappingURL=inspector.d.ts.map