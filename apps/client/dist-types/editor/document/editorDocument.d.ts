/**
 * EditorDocument — the ONE authority for map data in the editor.
 *
 * Before this, the editor held the map in six mutable arrays (`placedStatics`,
 * `placedNodes`, `placedProps`, `patches`, `mapLightsArr`, `mapZones`) plus a
 * copy of each object's transform on its Babylon mesh, plus another copy in
 * every undo entry. Nothing said which was true. A remote merge updated some;
 * a gizmo drag updated others; an undo restored a third set. Bugs of the form
 * "the inspector says 4 but the saved file says 2" are not fixable while that
 * is the shape of the code.
 *
 * So: the document owns map data, addressed by stable id. Babylon meshes are a
 * PROJECTION of it (see `viewport/editorViewRegistry.ts`), history stores
 * before/after document values (never mesh references or array indexes), and
 * selection stores ids. Destroying and rebuilding a mesh cannot invalidate
 * identity, history, locks, or selection, because none of them point at it.
 *
 * The document deliberately does NOT know about Babylon, the DOM, or the
 * server. It is a validated `MapFileV2` with an index and a change feed.
 */
import { SPAWN_OBJECT_ID, type MapFileV2, type MapLightV2, type MapNodeV2, type MapPropV2, type MapZoneV2, type StaticObjectV2, type TerrainObjectV2 } from '@hobo/content';
/**
 * The spawn point is stored top-level on the wire (`spawn` / `spawnYaw`) and
 * changing that would break every existing v2 artifact for no gain. The editor
 * still needs it to BE an object — selectable, undoable, lockable, listed in
 * the Outliner — so the document exposes it as a synthetic one under the
 * reserved id `spawn`, and folds it back into the wire on serialize.
 */
export interface SpawnObjectV2 {
    id: typeof SPAWN_OBJECT_ID;
    pos: [number, number, number];
    yaw: number;
}
export interface EditorObjectByKind {
    terrain: TerrainObjectV2;
    static: StaticObjectV2;
    node: MapNodeV2;
    prop: MapPropV2;
    light: MapLightV2;
    zone: MapZoneV2;
    spawn: SpawnObjectV2;
}
export type EditorObjectKind = keyof EditorObjectByKind;
export type EditorObject = EditorObjectByKind[EditorObjectKind];
export declare const EDITOR_OBJECT_KINDS: readonly EditorObjectKind[];
/**
 * What changed, by stable id, with enough detail for a view to update
 * incrementally instead of rebuilding the world.
 *
 * `updated` carries the top-level keys that differ, so a view can skip an
 * expensive rebuild for a change it does not care about — repainting a tint
 * must not rebuild collision.
 */
export type DocumentChange = {
    type: 'added';
    id: string;
    kind: EditorObjectKind;
} | {
    type: 'removed';
    id: string;
    kind: EditorObjectKind;
} | {
    type: 'updated';
    id: string;
    kind: EditorObjectKind;
    keys: readonly string[];
} | {
    type: 'replaced';
    id: string;
    kind: EditorObjectKind;
} | {
    type: 'documentReplaced';
};
export type DocumentListener = (changes: readonly DocumentChange[], revision: number) => void;
export declare class EditorDocument {
    /** Bumps on every committed mutation. Views compare it to skip work. */
    private rev;
    private map;
    /** id → kind. The one place identity is resolved. */
    private index;
    private spawn;
    private readonly listeners;
    /** Non-null while a transaction is open; changes batch into it. */
    private pending;
    constructor(map?: MapFileV2);
    get revision(): number;
    has(id: string): boolean;
    typeOf(id: string): EditorObjectKind | null;
    /**
     * The live object for `id`, or null. Callers MUST NOT mutate it: go through
     * `update`/`replace` so the change is announced and the revision moves. The
     * return is live rather than a copy because reads (hover, rendering, the
     * Outliner) vastly outnumber writes; `snapshot` is the copying read.
     */
    get(id: string): EditorObject | null;
    get<K extends EditorObjectKind>(id: string, kind: K): EditorObjectByKind[K] | null;
    /** Every object, in Outliner order (terrain, static, node, prop, light, zone, spawn). */
    list(): EditorObject[];
    listByKind<K extends EditorObjectKind>(kind: K): EditorObjectByKind[K][];
    ids(): string[];
    /** A detached copy — what history stores as its before/after value. */
    snapshot(id: string): EditorObject | null;
    snapshotMany(ids: readonly string[]): Map<string, EditorObject>;
    /**
     * Insert an object. The kind decides which wire array it joins; ids are
     * global, so a duplicate is a programming error rather than a silent
     * overwrite of whatever happened to share the name.
     */
    add<K extends EditorObjectKind>(kind: K, object: EditorObjectByKind[K]): void;
    /** Shallow-merge a patch. Absent keys are untouched; `undefined` deletes. */
    update<K extends EditorObjectKind>(id: string, patch: Partial<EditorObjectByKind[K]>): void;
    /** Swap the whole value — what undo of a property edit restores. */
    replace<K extends EditorObjectKind>(id: string, value: EditorObjectByKind[K]): void;
    remove(id: string): void;
    /**
     * Run `body` as one change batch: listeners see a single notification with
     * every change in it. One user gesture is one notification, so a multi-
     * object drag does not make the Outliner rebuild once per object.
     *
     * Nesting joins the outer batch rather than opening a second one.
     */
    transact<T>(body: () => T): T;
    /** The canonical wire form, spawn folded back to top level. */
    serialize(): MapFileV2;
    /**
     * Adopt a document fetched from the server. One `documentReplaced` change:
     * views rebuild, but ids that still exist keep their identity, so selection
     * and locks survive a remote save that did not touch what you had selected.
     */
    replaceFromRemote(next: MapFileV2): void;
    subscribe(listener: DocumentListener): () => void;
    private arrayFor;
    private mutableFor;
    private reindex;
    private emit;
    private notify;
}
//# sourceMappingURL=editorDocument.d.ts.map