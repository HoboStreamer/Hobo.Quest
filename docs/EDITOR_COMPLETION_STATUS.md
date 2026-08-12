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

## Not done

Honest list, in rough priority order.

1. **Painting past terrain.** `materials/paintableSurface.ts` defines the
   stable surface ids and every projection (face, cylindrical, spherical,
   UV0, box fallback) and they are tested — but the brush still routes only
   to `TerrainView`. Box faces, cylinders, spheres and imported models are
   not paintable yet, and per-instance model isolation is not implemented.
2. **Terrain, light and spawn live reconciliation.** Statics and zones
   reconcile by stable id; terrain still rebuilds wholesale on save, and
   lights and spawn do not reconcile incrementally. `diffMapFileV2` and
   `affectsCollision` exist for this.
3. **Node/prop reconciliation** still uses a proximity heuristic
   (`reconcileMapNodes`/`reconcileMapProps`) rather than distinguishing
   map-authored seeds from player-created persistent entities by id.
4. **Zone authoring UI.** Zones are in the schema, the runtime, the document,
   the view registry (translucent volume + wireframe), the Outliner and the
   Inspector — but there is no Zone tool to create one in the viewport.
5. **Typed collaboration protocol.** `LockController` (client) is done and
   tested; the wire messages are still ad-hoc strings.
6. **Asset Browser actions.** Listing, usage counts and delete-refusal work;
   rename and delete do not yet write back to the document.
7. **Performance pass.** Hover picking is throttled to every sixth frame and
   the Outliner patches rather than rebuilds on selection changes, but nothing
   has been profiled.

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
