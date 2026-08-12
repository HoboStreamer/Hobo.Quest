# The map editor

`/editor` authors the map artifact the game runs on. This describes what is
there, not what is planned; anything aspirational belongs in `ROADMAP.md`.

---

## The one rule

**The document owns map data. Everything else is a projection of it.**

```
                    EditorDocument  (validated MapFileV2 + id index + change feed)
                          │
        ┌─────────────────┼──────────────────┬───────────────┐
        │                 │                  │               │
  EditorViewRegistry  CommandHistory   SelectionManager   the panels
   (Babylon meshes)   (before/after     (stable ids)     (Outliner,
                       document values)                   Inspector, …)
```

Meshes are rebuilt constantly — a material change, an undo, a remote save —
so nothing durable may point at one. Selection, history, collaboration locks,
the Outliner and the Issues panel all hold **stable ids**, and
`EditorViewRegistry` is the only thing that maps between an id and a Babylon
object. Destroying and rebuilding a mesh therefore cannot invalidate any of
them.

Before this the editor held the map in six mutable arrays plus a copy of each
transform on its mesh plus another in every undo entry, and nothing said which
was true.

---

## Where things live

| Concern                   | Module                                                                       |
| ------------------------- | ---------------------------------------------------------------------------- |
| Map data                  | `document/editorDocument.ts`                                                 |
| Per-kind pose + labels    | `document/editorObject.ts`                                                   |
| Babylon projection        | `viewport/editorViewRegistry.ts`, `viewport/views/`                          |
| Undo/redo                 | `history/commandHistory.ts`, `history/commands.ts`                           |
| Selection                 | `selection/selectionManager.ts`, `selection/selectionVisuals.ts`             |
| Faces                     | `selection/faceSelection.ts`                                                 |
| Transform gesture         | `viewport/transformSession.ts`, `viewport/transformMath.ts`                  |
| Gizmo                     | `viewport/gizmoController.ts`                                                |
| Camera                    | `viewport/editorCameraController.ts`                                         |
| Snap / World-Local / grid | `viewport/editorPreferences.ts`                                              |
| Tools                     | `tools/toolManager.ts`, `tools/placementTool.ts`, `tools/terrainTool.ts`     |
|                           | `tools/lightTool.ts`, `tools/zoneTool.ts`                                    |
| Painting                  | `materials/paintController.ts`, `materials/paintSurfaceRegistry.ts`          |
|                           | `materials/paintMask.ts`, `materials/paintableSurface.ts`                    |
| Projections (shared)      | `render/surfaceProjection.ts`, `render/paintedStatic.ts`                     |
| Assets                    | `assets/assetController.ts` (the document owns the entries)                  |
| Performance counters      | `perf/editorProfiler.ts`                                                     |
| Pointer routing           | `interaction/viewportInteraction.ts`, `interaction/interactionController.ts` |
| Keyboard                  | `bindings.ts`, `input/actionRouter.ts`                                       |
| Workspace + panels        | `ui/`                                                                        |
| Save / conflict / draft   | `net/saveController.ts`, `recovery/draftStore.ts`                            |
| Collaboration             | `collaboration/`                                                             |
| Composition               | `editorApp.ts` (`main.ts` is boot only)                                      |

---

## The wire

`MapFile v2` (`packages/content/src/mapFileV2.ts`) is canonical. v1 is
accepted as **migration input only** — `parseMapFile` migrates it — and there
is no reverse projection. `compileMapFileV2` is the single boundary between
authoring and runtime.

Every editable object has a stable id. `normalizeMapIds` assigns
deterministic ids to anything that predates the rule, before validation, so
the schema can require them; the next save persists them and they never
change again. Array position is not identity.

`spawn` is stored top-level on the wire and exposed as a synthetic document
object under the reserved id `spawn`, so it is selectable, undoable, lockable
and listed like anything else.

---

## Document changes

`add` / `update` / `replace` / `remove` emit typed changes carrying the stable
id and, for updates, **the keys that differ**. A view can then be cheap about
it: repainting a tint does not rebuild a heightfield. A view that cannot apply
a change incrementally returns `false` and the registry rebuilds it — identity
is unaffected, because it is keyed by id.

`transact()` batches one user gesture into one notification, so a multi-object
drag does not rebuild the Outliner once per object.

---

## History

Commands capture **stable ids and plain values** — never a mesh, never a live
reference, never an array index — so undo is an exact inverse by construction.

One user gesture is one entry: a gizmo drag, a numeric scrub, a multi-delete,
a duplicate, a terrain stroke, a paint stroke.

Terrain and paint strokes store the **changed rectangle**, not the field: a
512² heightfield is a megabyte of `Float32` per snapshot and a brush dab
touches a handful of samples.

Dirty state compares against the saved checkpoint by command identity, so:
save → edit → dirty → undo → clean → redo → dirty.

---

## Input

Every keyboard behaviour goes through `bindings.ts`, which means all of them
are remappable and all of them appear in the settings panel with conflict
detection. There are no shortcuts wired directly to a `keydown` elsewhere.

Typing is not shortcuts: while focus is in a text field, a number field or a
keybind capture, no action runs and no key registers as held.

**Pointer ownership.** Babylon's `UtilityLayerRenderer` only suppresses its
own `scene.onPointerObservable` when a gizmo is hit, and this editor listens
on raw DOM events — so a press on a handle also ran scene selection behind it.
The fix is ordering, not a hover flag: `new Scene(engine)` attaches Babylon's
input manager during construction, before any editor listener exists, so the
gizmo's drag-start has already claimed the gesture by the time the canvas
handler runs.

The gizmo is attached only for Select and no-tool. Left attached while
painting it puts a grabbable handle over the point the brush is aimed at.

**Coordinates.** The canvas fills the viewport grid cell, not the window, so
its space starts at the cell's top-left. `worldToScreen` returns **page**
coordinates and `toCanvasSpace` is its inverse; a projection correct in canvas
space and used as a page position is silently off by the width of a panel.

**Camera.** Babylon's own camera inputs are cleared. MMB uses pointer capture
so a drag survives leaving the canvas and autoscroll never fires; the wheel
dollies toward the point under the cursor with a distance-scaled step, unless
a placement tool has claimed it to rotate the preview.

---

## Tools

`Tool | null`. Clicking or hotkeying the active tool puts it away. With no
tool active, selection and navigation still work and nothing places, sculpts
or paints.

---

## Painting

A surface is a **base** (never touched by painting) plus up to four paint
layers blended through the RGBA channels of one mask. A layer is identified by
its texture _and_ its tint, so red brick and blue brick are two paints. At the
layer budget the editor says so rather than silently swapping a texture out.

`materials/paintableSurface.ts` defines stable surface ids (`surface`,
`face:0`…`face:5`, `mesh:<path>/material:<slot>`). The projections themselves
live in `render/surfaceProjection.ts`, because the game needs the same ones to
DISPLAY what was painted and must never import editor code — if the two
disagreed by a sign, paint would appear in one place in the editor and another
in the game.

One projection per shape: planar for terrain, per-face for boxes, cylindrical,
spherical, UV0 where a model has one, and box projection where it does not —
because Paint silently doing nothing is the worst outcome, since the user
cannot tell whether they missed, the texture failed, or it is unsupported.
All-zero UVs count as unusable (`hasUsableUV0`): that is what an un-unwrapped
export writes, and painting into it puts every stamp on one texel.

`PaintController.hitTest` dispatches on the document KIND, not on a view type:
terrain → planar; box → the face the normal points at, so painting one wall
leaves the other five alone; cylinder/sphere → a single wrapped surface;
imported model → the picked CHILD mesh, whose slot id is derived from its
position in the hierarchy and is therefore the same after every reload.

**Imported models keep their own material.** Paint is a transparent OVERLAY
clone sitting a hair proud of the original, whose alpha IS the mask coverage:
where coverage is zero the glTF material shows through unchanged. Replacing
the material instead would mean "painting a model" turned it grey everywhere
the brush had not been, which is retexturing, not painting. The overlay
belongs to the INSTANCE — painting one placement of a model cannot alter the
cached `AssetContainer` template or any other placement of it.

A model with no usable UVs gets the box projection, and the overlay clone has
those same UVs baked into it (`bakeBoxProjectedUVs`), in the owning static's
local space. Without that the stroke was recorded and then displayed nowhere.
The projection is approximate on faces oblique to the dominant axis, so the
Inspector says which projection a surface is using.

---

## Assets

`POST /api/map-assets` names a file after the **sha256 of the bytes it
received** and decides the extension by sniffing those bytes (PNG / JPEG /
WebP / GLB), never from a caller-supplied type. Writes are async and
temp+rename. Identical content collapses to one file and one URL.

That dedupe is what makes paint masks affordable: they stay canvases in
memory while editing and upload on save, so an unchanged mask hashes the same
and the second save uploads nothing. Textures and imported models take the
same path. Legacy embedded `dataUrl` textures and `data:` model glbs still
load.

Content-addressed names are served `immutable`; legacy `tex-<timestamp>` names
get five minutes, because such a name never promised anything about its bytes.

---

## Save, conflicts, recovery

Save is: upload masks → serialise → `If-Match` the revision last loaded →
interpret the status. A stale revision is a 409, never an overwrite.

A remote save is adopted only when the local copy is **clean**. When it is
dirty the conflict panel opens with a real diff summary (`describeDiff`) and
three choices: take theirs, keep mine, export mine. **Nothing here merges**,
and the UI says so — "keep mine" only dismisses the panel.

Drafts go to IndexedDB, debounced, and are **never** published: a crash
recovering itself into everyone else's world would be worse than losing the
work. They are keyed by origin + map path, and a draft whose base revision no
longer exists is not offered for restore — its parent is gone, so applying it
would silently revert whatever happened in between — but it is offered for
download.

---

## Collaboration

The wire is `packages/protocol/src/editor.ts` — typed messages plus decoders,
shared by both ends. The decoders are hand-written rather than Zod because the
server decodes every camera frame; they return `null` for anything
unrecognised, so a malformed message is rejected whole and can never
half-apply. Ids that are unusable are dropped rather than failing the whole
frame. Limits (`EDITOR_MAX_MESSAGE_BYTES`, `EDITOR_MAX_IDS`,
`EDITOR_CAMERA_HZ`, `EDITOR_HEARTBEAT_MS`) are shared constants, so the two
sides cannot disagree about them.

**The credential is never in the URL.** A query string is logged by proxies
and lives in browser history; the key goes in the first `hello` frame, after
the socket is open. Nothing is accepted before `hello`. The server assigns the
peer id and the colour — a client-supplied one is a client that can
impersonate a peer — and owns the lock table.

Hovering never acquires a lock; selecting is intent to edit and does.
Selection requests the COMPLETE selected set atomically, so a group edit is
all-or-nothing: a transform that could only move half its members is worse
than one that does not start. Every mutation path goes through one gate
(`withLock` in `editorApp.ts`); when there is no session there is nobody to
arbitrate with, so it grants. Read-only selection of a locked object is
allowed; mutation is refused. Leases are 45 s with an explicit heartbeat, and
a lease lost mid-gesture is detected from the server's own table and rolls the
gesture back.

`pnpm test:collab` drives two real browser contexts against one server.

---

## Live runtime

Map-authored terrain, statics, lights and zones live in their own id-keyed
layers on both sides, separate from base world content, which is never
mutated. Reconciling by stable id means an unchanged object keeps its exact
body, so an identical repeated save touches nothing. `/metrics` publishes
`mapStatics`, `mapTerrains` and `mapZones` so the "applies live" claim is
checkable from outside the process.

One `diffMapFileV2` is computed per reload and each layer is handed only its
own category. `affectsCollision` separates an appearance edit from a
structural one: retinting a terrain rebuilds no trimesh at all, on either
side, because rendering and physics are separate costs and only one of them
moved. `terrainCollisionSignature` deliberately excludes `surface`.

**Node and prop provenance.** Entities a map object authored carry that
object's stable id (`GameEntity.mapSourceId`, persisted inside the existing
`state` blob, so no migration). `planMapProvenance` decides what to do with
each one, and it is the only rule:

- no provenance → player-created, never touched. Player constructions are
  never deleted because a map seed disappeared.
- source gone → despawn exactly that entity.
- type changed → replace, resetting its state deliberately rather than by
  accident.
- moved → move it and KEEP its gameplay state, so a depleted node stays
  depleted.
- unchanged → left completely alone.

The old rule was spatial ("a node of this type within a metre"). Proximity is
not identity: two authored objects standing together collapsed into one, a
player's crate beside an authored one suppressed it, and moving a seed past
the radius spawned a duplicate and abandoned the original.

---

## Performance

`perf/editorProfiler.ts` holds counters and timers, off by default so an
unobserved counter costs nothing, and reachable from the acceptance suite. The
point is that performance claims can be CHECKED rather than asserted: section
V of `pnpm test:editor` profiles a 400-object map and fails if editing one
object stops costing one object's work.

Everything asserted there is about scaling, not wall-clock — a "under 16 ms"
assertion would only measure the machine's software renderer.

What the profiler found, and what was done:

| Symptom (counter)                                     | Cause                                                                                                 | Fix                                                                          |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `views.rebuildFromUpdate` on a colour edit             | Inspector edits `replace` the whole object for one clean undo step, and `replaced` carried no key list, so every view read it as "everything changed" — including `shape`, which forces a rebuild. Retinting an imported model re-instantiated its glTF. | `replaced` now carries `changedKeys`, exactly like `updated`.                 |
| Whole owner table scanned per removal                  | `destroy`/`reindex` walked every mesh in the scene looking for one object's. Deleting 50 objects on a 600-object map walked it 50 times.                                                                | A reverse index (`ownedMeshes`), so removal touches only its own meshes.       |
| Scene-sized array allocated several times a second     | `allMeshes()` rebuilt from every view on each hover pick.                                              | Cached, invalidated whenever the mesh set actually changes.                    |
| Linear scan per document read                          | `get(id)` scanned the wire array. `get` is the hottest read there is — hover, every view update, the Outliner, the Inspector — so every mouse move walked hundreds of entries. | `byId` index maintained by add/replace/remove/reindex; `update` mutates in place. |

Already in place before that pass: hover picking is throttled to every sixth
frame, the Outliner patches rather than rebuilds on selection changes, mask
uploads are content-addressed so an unchanged mask re-uploads nothing, and the
model cache parses each glTF once per page.

---

## Adding things

**An object kind**: add it to the v2 schema, to `EditorObjectByKind` and
`KIND_INFO`, to `transformOf`/`setTransform`, write a view and register it in
`createViewFactory`, and add its fields to `fieldsFor`. Selection, history,
locks, the Outliner and the Issues panel need no changes — they are generic
over kinds.

**A tool**: add it to `Tool`, to `TOOLS` in `editorShell.ts`, and to the
`tool.*` bindings; handle it in `ViewportInteraction.onDown`.

**A surface type**: pick or add a projection in `render/surfaceProjection.ts`
(shared with the game), give it a stable surface id in `paintableSurface.ts`,
and add the branch to `PaintController.hitTest` plus the matching branch in
`render/paintedStatic.ts` so the game displays it the same way.

**A keyboard action**: add it to `ACTIONS` and handle it in `runAction`. It
appears in the settings panel automatically, and the conflict test will tell
you if the default chord is taken.

---

## Gates

```
pnpm typecheck    pnpm test        # 510 tests, includes the architecture audit
pnpm lint         pnpm build
pnpm format:check pnpm test:editor # 76 browser checks
node --import tsx apps/server/scripts/sliceTest.ts
```

`apps/client/src/editor/architectureAudit.audit.ts` fails if a legacy
construct returns to active runtime code. It runs as part of `pnpm test`.
