# Map editor completion — tracked status

**Branch:** `editor-completion`

The transitional editor is gone. `pnpm audit:editor` is green and now runs as
part of `pnpm test`, so architectural correctness is no longer a separate,
skippable gate.

For how the editor is put together, read `docs/MAP_EDITOR.md` — it describes
what exists. This file is the record of the program and what is left.

---

## Gates (verified)

| Gate               | Command                                              | Status                      |
| ------------------ | ---------------------------------------------------- | --------------------------- |
| Types              | `pnpm typecheck`                                     | green                       |
| Unit + audit       | `pnpm test`                                          | green — 510 tests, 40 files |
| Architecture audit | `pnpm audit:editor`                                  | **green — 8 of 8**          |
| Lint               | `pnpm lint`                                          | green                       |
| Format             | `pnpm format:check`                                  | green                       |
| Build              | `pnpm build`                                         | green                       |
| Editor E2E         | `pnpm test:editor`                                   | green — 76/76               |
| Server slice       | `node --import tsx apps/server/scripts/sliceTest.ts` | green                       |

`apps/client/src/editor/main.ts` **531 bytes** (was 171 KB).
`apps/client/editor.html` **2.1 KB** (was 23 KB, 11 KB of it inline CSS).

Slice-test note: the `walkTo` step is timing-flaky under load and logs
"walkTo stuck?" before succeeding. The `node state persisted (N)` count varies
run to run — that is the diagnostic value, not the assertion; the resource
pile respawns on a 120 s timer and the assertion compares pre/post-restart.

---

## Done

### Correctness fixes that were real bugs

- **Paint tint stripped by the schema.** `PaintLayerSchemaV2` had no `color`,
  so Zod discarded the tint on every parse of the canonical wire. Reachable in
  the editor, destroyed on reload.
- **Invisible ground.** `buildTerrainGrid(world)` samples through the map
  override, so with a map loaded both trimesh colliders and the client mesh
  resampled the map's own terrains onto a world grid — a second floor at every
  authored height, and a flat y = 0 sheet you could stand on for a
  terrain-less map.
- **"Save applies live" was false for statics.** Merged into
  `content.world.statics` once at boot and never touched again: a new static
  got no collision until restart, moving one did nothing, and re-applying a
  map appended a second copy. Zones were never applied at all.
- **Remote-change detection compared array lengths.** Moving every object in
  the map registered as "no change".
- **The gizmo swallowed the first brush stroke.** Left attached during Paint
  and Face, its handle sat over the point the brush was aimed at.
- **Drafts missed drags.** A gesture mutates the document first and records
  its command on release, so watching only the document meant the history was
  not yet dirty and nothing was drafted.

### Architecture

`EditorDocument` is the only map-data authority; `EditorViewRegistry` the only
Babylon projection; `SelectionManager` the only selection authority;
`CommandHistory` the only history. The six parallel arrays, the `multi*`
projections and the `UndoOp`/`applyOp` union are deleted, along with the
special main terrain, `TerrainMaterial` and `projectV2ToV1`.

### Schema and runtime

Stable ids on every editable object; typed lights; map-authored zones that
augment base content zones through a replaceable layer; `diffMapFileV2`;
content-addressed assets; live static and zone reconciliation by stable id.

### UI

Resizable, collapsible, persistent workspace; Outliner; per-kind Inspector;
Assets, Issues, History and Scene panels; status bar; scrubbable number
fields; World/Local; snapping; a real no-tool state.

### Save and recovery

Canonical SHA revisions with `If-Match`; a conflict panel that shows a real
diff and does not claim to merge; IndexedDB drafts that are never
auto-published; import with migration and validation; export of the source
document including unsaved edits.

---

## Remaining required items

**None.** Every item this program set out to finish is implemented, tested and
gated. What follows is the record of the last milestones; ideas that were
never in scope are in `ROADMAP.md`, not here.

### Collaboration

`packages/protocol/src/editor.ts` is the shared wire: typed messages plus
hand-written decoders (no Zod — the server decodes every camera frame) that
return `null` for anything unrecognised, so a malformed frame is rejected
whole. The credential is sent in the first `hello` frame, never in the URL.
The server assigns peer id and colour. Locks are 45 s leases with an explicit
heartbeat, requested for the COMPLETE selected set atomically, and every
mutation path goes through one gate. `pnpm test:collab` drives two real
browser contexts against one server.

### Assets

`EditorDocument` is the only asset authority — `models()`, `textures()`,
`addModelAsset`, `renameTextureAsset`, `replaceAssets` — so an import cannot
be visible in the browser and absent from the saved map. Rename rewrites the
entry and every `custom:<name>` reference in one history transaction; deletion
of a referenced asset is refused, and server blobs are NEVER garbage-collected
automatically, because a content-addressed blob may be shared by other maps.

### Painting, generalised

The brush dispatches on document kind: terrain, box faces, cylinder, sphere,
and imported-model slots. Imported models keep their own glTF material and get
a transparent per-INSTANCE overlay, so painting one placement cannot touch the
cached template or another placement. A model with no usable UVs falls back to
a box projection, baked into the overlay so the stroke is displayed where it
was applied. The game renders all of it through the same
`render/paintedStatic.ts`.

### Live reconciliation

Terrain, statics, lights and zones reconcile by stable id on both sides from
one `diffMapFileV2` per reload. `affectsCollision` and
`terrainCollisionSignature` mean an appearance edit rebuilds no collision at
all, and an identical repeated save touches nothing.

### Node/prop provenance

Map-authored entities carry the authoring object's stable id. The proximity
heuristic is gone; `planMapProvenance` is the only rule, and player
constructions — which have no provenance — are never touched.

### Performance

`perf/editorProfiler.ts` plus section V of the acceptance suite, which fails
if editing one object stops costing one object's work on a 400-object map.
Four scaling defects were found and fixed; the table in
`docs/MAP_EDITOR.md#performance` records each one.

---

## Rules for whoever continues

- The audit runs in `pnpm test` now. If it goes red, a legacy construct came
  back — fix the code, not the audit.
- `pnpm test:editor` after every change to interaction; it catches things unit
  tests cannot.
- The E2E harness verifies its own aim (`pickIdAt`) and waits for a stable
  gizmo handle. If a check goes flaky, suspect harness timing against software
  GL before suspecting the editor — but confirm, do not assume.
- `docs/MAP_EDITOR.md` describes what exists. Keep it that way.
