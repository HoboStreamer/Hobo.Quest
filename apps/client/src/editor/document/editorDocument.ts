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
import {
  SPAWN_OBJECT_ID,
  emptyMapV2,
  type MapFileV2,
  type MapModelV2,
  type MapTextureEntry,
  type MapLightV2,
  type MapNodeV2,
  type MapPropV2,
  type MapZoneV2,
  type StaticObjectV2,
  type TerrainObjectV2,
} from '@hobo/content'

/**
 * The spawn point is stored top-level on the wire (`spawn` / `spawnYaw`) and
 * changing that would break every existing v2 artifact for no gain. The editor
 * still needs it to BE an object — selectable, undoable, lockable, listed in
 * the Outliner — so the document exposes it as a synthetic one under the
 * reserved id `spawn`, and folds it back into the wire on serialize.
 */
export interface SpawnObjectV2 {
  id: typeof SPAWN_OBJECT_ID
  pos: [number, number, number]
  yaw: number
}

export interface EditorObjectByKind {
  terrain: TerrainObjectV2
  static: StaticObjectV2
  node: MapNodeV2
  prop: MapPropV2
  light: MapLightV2
  zone: MapZoneV2
  spawn: SpawnObjectV2
}

export type EditorObjectKind = keyof EditorObjectByKind
export type EditorObject = EditorObjectByKind[EditorObjectKind]

/** Wire arrays, in Outliner order. `spawn` is synthetic and not listed here. */
const ARRAY_KINDS = [
  ['terrain', 'terrains'],
  ['static', 'statics'],
  ['node', 'nodes'],
  ['prop', 'props'],
  ['light', 'lights'],
  ['zone', 'zones'],
] as const satisfies readonly (readonly [EditorObjectKind, keyof MapFileV2])[]

export const EDITOR_OBJECT_KINDS: readonly EditorObjectKind[] = [
  ...ARRAY_KINDS.map(([k]) => k),
  'spawn',
]

/** kind → wire array name, so resolving one is not a scan. */
const ARRAY_OF_KIND = new Map<EditorObjectKind, keyof MapFileV2>(ARRAY_KINDS)

/**
 * What changed, by stable id, with enough detail for a view to update
 * incrementally instead of rebuilding the world.
 *
 * `updated` and `replaced` both carry the top-level keys that differ, so a
 * view can skip an expensive rebuild for a change it does not care about —
 * repainting a tint must not rebuild collision. `replaced` used to carry
 * none, so every Inspector edit (which replaces the whole object, to make one
 * clean undo step) looked like "everything changed" and rebuilt the mesh —
 * re-instantiating an imported model to alter its tint.
 */
export type DocumentChange =
  | { type: 'added'; id: string; kind: EditorObjectKind }
  | { type: 'removed'; id: string; kind: EditorObjectKind }
  | { type: 'updated'; id: string; kind: EditorObjectKind; keys: readonly string[] }
  | { type: 'replaced'; id: string; kind: EditorObjectKind; keys: readonly string[] }
  /** Model/texture metadata changed (imported, renamed, removed). */
  | { type: 'assetsChanged' }
  | { type: 'documentReplaced' }

export type DocumentListener = (changes: readonly DocumentChange[], revision: number) => void

const clone = <T>(v: T): T => structuredClone(v)

/** Top-level keys whose values differ. Enough for view invalidation. */
function changedKeys(before: object, after: object): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  const out: string[] = []
  for (const k of keys) {
    const a = (before as Record<string, unknown>)[k]
    const b = (after as Record<string, unknown>)[k]
    if (a === b) continue
    if (JSON.stringify(a) !== JSON.stringify(b)) out.push(k)
  }
  return out
}

export class EditorDocument {
  /** Bumps on every committed mutation. Views compare it to skip work. */
  private rev = 0
  private map: MapFileV2
  /** id → kind. The one place identity is resolved. */
  private index = new Map<string, EditorObjectKind>()
  /**
   * id → the live object. `get` used to scan the wire array, and `get` is the
   * hottest read in the editor — hover picking, every view update, the
   * Outliner and the Inspector all go through it — so on a large map every
   * mouse move walked hundreds of entries. Writes keep this in step; `update`
   * mutates in place, so only add/replace/remove/reindex touch it.
   */
  private byId = new Map<string, EditorObject>()
  private spawn: SpawnObjectV2 | null = null
  private readonly listeners = new Set<DocumentListener>()
  /** Non-null while a transaction is open; changes batch into it. */
  private pending: DocumentChange[] | null = null

  constructor(map: MapFileV2 = emptyMapV2()) {
    this.map = clone(map)
    this.reindex()
  }

  get revision(): number {
    return this.rev
  }

  // ── Reads ───────────────────────────────────────────────────────────

  has(id: string): boolean {
    return this.index.has(id)
  }

  typeOf(id: string): EditorObjectKind | null {
    return this.index.get(id) ?? null
  }

  /**
   * The live object for `id`, or null. Callers MUST NOT mutate it: go through
   * `update`/`replace` so the change is announced and the revision moves. The
   * return is live rather than a copy because reads (hover, rendering, the
   * Outliner) vastly outnumber writes; `snapshot` is the copying read.
   */
  get(id: string): EditorObject | null
  get<K extends EditorObjectKind>(id: string, kind: K): EditorObjectByKind[K] | null
  get(id: string, kind?: EditorObjectKind): EditorObject | null {
    const actual = this.index.get(id)
    if (actual === undefined || (kind !== undefined && actual !== kind)) return null
    return this.byId.get(id) ?? null
  }

  /** Every object, in Outliner order (terrain, static, node, prop, light, zone, spawn). */
  list(): EditorObject[] {
    const out: EditorObject[] = []
    for (const [kind] of ARRAY_KINDS) out.push(...this.arrayFor(kind))
    if (this.spawn) out.push(this.spawn)
    return out
  }

  listByKind<K extends EditorObjectKind>(kind: K): EditorObjectByKind[K][] {
    if (kind === 'spawn')
      return (this.spawn ? [this.spawn] : []) as unknown as EditorObjectByKind[K][]
    return this.arrayFor(kind) as EditorObjectByKind[K][]
  }

  ids(): string[] {
    return [...this.index.keys()]
  }

  /** A detached copy — what history stores as its before/after value. */
  snapshot(id: string): EditorObject | null {
    const o = this.get(id)
    return o ? clone(o) : null
  }

  snapshotMany(ids: readonly string[]): Map<string, EditorObject> {
    const out = new Map<string, EditorObject>()
    for (const id of ids) {
      const o = this.snapshot(id)
      if (o) out.set(id, o)
    }
    return out
  }

  // ── Writes ──────────────────────────────────────────────────────────

  /**
   * Insert an object. The kind decides which wire array it joins; ids are
   * global, so a duplicate is a programming error rather than a silent
   * overwrite of whatever happened to share the name.
   */
  add<K extends EditorObjectKind>(kind: K, object: EditorObjectByKind[K]): void {
    if (this.index.has(object.id))
      throw new Error(`EditorDocument.add: id "${object.id}" already exists`)
    const copy = clone(object) as EditorObject
    if (kind === 'spawn') {
      this.spawn = copy as SpawnObjectV2
    } else {
      ;(this.arrayFor(kind) as EditorObject[]).push(copy)
    }
    this.index.set(object.id, kind)
    this.byId.set(object.id, copy)
    this.emit({ type: 'added', id: object.id, kind })
  }

  /** Shallow-merge a patch. Absent keys are untouched; `undefined` deletes. */
  update<K extends EditorObjectKind>(id: string, patch: Partial<EditorObjectByKind[K]>): void {
    const kind = this.index.get(id)
    if (kind === undefined) throw new Error(`EditorDocument.update: no object "${id}"`)
    if ('id' in patch && patch.id !== undefined && patch.id !== id)
      throw new Error(`EditorDocument.update: cannot change the id of "${id}"`)
    const target = this.mutableFor(id, kind)
    const before = clone(target)
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'id') continue
      if (v === undefined) delete (target as Record<string, unknown>)[k]
      else (target as Record<string, unknown>)[k] = clone(v)
    }
    const keys = changedKeys(before, target)
    if (keys.length === 0) return
    this.emit({ type: 'updated', id, kind, keys })
  }

  /** Swap the whole value — what undo of a property edit restores. */
  replace<K extends EditorObjectKind>(id: string, value: EditorObjectByKind[K]): void {
    const kind = this.index.get(id)
    if (kind === undefined) throw new Error(`EditorDocument.replace: no object "${id}"`)
    if (value.id !== id)
      throw new Error(`EditorDocument.replace: value id "${value.id}" is not "${id}"`)
    const copy = clone(value) as EditorObject
    const before = this.byId.get(id)
    if (kind === 'spawn') {
      this.spawn = copy as SpawnObjectV2
    } else {
      const arr = this.arrayFor(kind) as EditorObject[]
      arr[arr.findIndex((o) => o.id === id)] = copy
    }
    this.byId.set(id, copy)
    this.emit({
      type: 'replaced',
      id,
      kind,
      keys: before ? changedKeys(before, copy) : Object.keys(copy),
    })
  }

  remove(id: string): void {
    const kind = this.index.get(id)
    if (kind === undefined) return
    if (kind === 'spawn') {
      this.spawn = null
    } else {
      const arr = this.arrayFor(kind) as EditorObject[]
      arr.splice(
        arr.findIndex((o) => o.id === id),
        1,
      )
    }
    this.index.delete(id)
    this.byId.delete(id)
    this.emit({ type: 'removed', id, kind })
  }

  /**
   * Run `body` as one change batch: listeners see a single notification with
   * every change in it. One user gesture is one notification, so a multi-
   * object drag does not make the Outliner rebuild once per object.
   *
   * Nesting joins the outer batch rather than opening a second one.
   */
  transact<T>(body: () => T): T {
    if (this.pending) return body()
    const batch: DocumentChange[] = []
    this.pending = batch
    try {
      const result = body()
      this.pending = null
      if (batch.length > 0) this.notify(batch)
      return result
    } catch (err) {
      this.pending = null
      // The batch is abandoned undelivered; the caller is expected to roll
      // back through history rather than the document replaying anything.
      throw err
    }
  }

  // ── Asset metadata ──────────────────────────────────────────────────
  //
  // Models and textures are map DATA, so the document owns them, exactly
  // like every other part of the wire. They were held in two mutable arrays
  // beside the document and re-injected at serialize time, which is the same
  // two-authorities bug this class exists to remove — just for the fields
  // nobody had got round to yet.
  //
  // They are not selectable objects (there is nothing in the viewport to
  // click), so they are not `EditorObject`s; they are addressed by their own
  // ids and announced with `assetsChanged`.

  models(): readonly MapModelV2[] {
    return this.map.models
  }

  textures(): readonly MapTextureEntry[] {
    return this.map.textures as MapTextureEntry[]
  }

  modelById(id: string): MapModelV2 | null {
    return this.map.models.find((m) => m.id === id) ?? null
  }

  textureByName(name: string): MapTextureEntry | null {
    return (this.map.textures as MapTextureEntry[]).find((t) => t.name === name) ?? null
  }

  addModelAsset(model: MapModelV2): void {
    if (this.modelById(model.id)) throw new Error(`model "${model.id}" already exists`)
    this.map.models.push(clone(model))
    this.emit({ type: 'assetsChanged' })
  }

  removeModelAsset(id: string): void {
    const i = this.map.models.findIndex((m) => m.id === id)
    if (i < 0) return
    this.map.models.splice(i, 1)
    this.emit({ type: 'assetsChanged' })
  }

  addTextureAsset(texture: MapTextureEntry): void {
    if (this.textureByName(texture.name))
      throw new Error(`texture "${texture.name}" already exists`)
    ;(this.map.textures as MapTextureEntry[]).push(clone(texture))
    this.emit({ type: 'assetsChanged' })
  }

  removeTextureAsset(name: string): void {
    const list = this.map.textures as MapTextureEntry[]
    const i = list.findIndex((t) => t.name === name)
    if (i < 0) return
    list.splice(i, 1)
    this.emit({ type: 'assetsChanged' })
  }

  /**
   * Rename a texture. Callers are responsible for the REFERENCES —
   * `custom:<name>` appears in terrain and static surfaces — which is why
   * the Asset Browser does this inside one history transaction rather than
   * calling it directly.
   */
  renameTextureAsset(from: string, to: string): void {
    if (from === to) return
    if (this.textureByName(to)) throw new Error(`texture "${to}" already exists`)
    const entry = (this.map.textures as MapTextureEntry[]).find((t) => t.name === from)
    if (!entry) return
    entry.name = to
    this.emit({ type: 'assetsChanged' })
  }

  /** Replace the whole asset metadata set (undo of a rename, import). */
  replaceAssets(models: readonly MapModelV2[], textures: readonly MapTextureEntry[]): void {
    this.map.models = clone([...models]) as MapFileV2['models']
    this.map.textures = clone([...textures]) as MapFileV2['textures']
    this.emit({ type: 'assetsChanged' })
  }

  // ── Whole-document ──────────────────────────────────────────────────

  /** The canonical wire form, spawn folded back to top level. */
  serialize(): MapFileV2 {
    const out = clone(this.map)
    delete out.spawn
    delete out.spawnYaw
    if (this.spawn) {
      out.spawn = [...this.spawn.pos]
      out.spawnYaw = this.spawn.yaw
    }
    return out
  }

  /**
   * Adopt a document fetched from the server. One `documentReplaced` change:
   * views rebuild, but ids that still exist keep their identity, so selection
   * and locks survive a remote save that did not touch what you had selected.
   */
  replaceFromRemote(next: MapFileV2): void {
    this.map = clone(next)
    this.reindex()
    this.emit({ type: 'documentReplaced' })
  }

  subscribe(listener: DocumentListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  // ── Internals ───────────────────────────────────────────────────────

  private arrayFor(kind: EditorObjectKind): EditorObject[] {
    const key = ARRAY_OF_KIND.get(kind)
    if (!key) return []
    return this.map[key] as unknown as EditorObject[]
  }

  private mutableFor(id: string, kind: EditorObjectKind): EditorObject {
    if (kind === 'spawn') {
      if (!this.spawn) throw new Error('EditorDocument: spawn is not set')
      return this.spawn
    }
    const found = this.byId.get(id)
    if (!found) throw new Error(`EditorDocument: "${id}" indexed as ${kind} but not in that array`)
    return found
  }

  private reindex(): void {
    this.index = new Map()
    this.byId = new Map()
    for (const [kind] of ARRAY_KINDS)
      for (const o of this.arrayFor(kind)) {
        this.index.set(o.id, kind)
        this.byId.set(o.id, o)
      }
    this.spawn = this.map.spawn
      ? { id: SPAWN_OBJECT_ID, pos: [...this.map.spawn], yaw: this.map.spawnYaw ?? 0 }
      : null
    if (this.spawn) {
      this.index.set(SPAWN_OBJECT_ID, 'spawn')
      this.byId.set(SPAWN_OBJECT_ID, this.spawn)
    }
  }

  private emit(change: DocumentChange): void {
    this.rev++
    if (this.pending) {
      this.pending.push(change)
      return
    }
    this.notify([change])
  }

  private notify(changes: readonly DocumentChange[]): void {
    for (const l of [...this.listeners]) l(changes, this.rev)
  }
}
