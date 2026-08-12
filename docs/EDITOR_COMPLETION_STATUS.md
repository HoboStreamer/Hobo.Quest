# Map editor completion — tracked status

**Branch:** `editor-completion` · **Last commit:** `dec7593`

This is the live checklist for the editor-completion program, updated after
every milestone. **The authoritative machine-checked version is
`pnpm audit:editor`** (`apps/client/src/editor/architectureAudit.audit.ts`),
which fails while any legacy construct is still active runtime code.

Do not mark an item done here without the audit or a test proving it.

---

## Gate status (verified this session, not assumed)

| Gate                   | Command                                              | Status                      |
| ---------------------- | ---------------------------------------------------- | --------------------------- |
| Types                  | `pnpm typecheck`                                     | green                       |
| Unit                   | `pnpm test`                                          | green — 302 tests, 27 files |
| Lint                   | `pnpm lint`                                          | green                       |
| Format                 | `pnpm format:check`                                  | green                       |
| Build                  | `pnpm build`                                         | green                       |
| Editor E2E             | `pnpm test:editor`                                   | green — 76/76               |
| Server slice           | `node --import tsx apps/server/scripts/sliceTest.ts` | green                       |
| **Architecture audit** | `pnpm audit:editor`                                  | **RED — 5 of 8 green**      |

Sizes: `apps/client/src/editor/main.ts` **171 KB** (target ≤ 25 KB),
`apps/client/editor.html` **12 KB**, inline `<style>` **gone**.

The slice test's `walkTo` step is timing-flaky under load and occasionally
logs "walkTo stuck?" before succeeding; reruns are clean. It is not related to
editor work but is worth fixing.

The audit runs as its own gate (`*.audit.ts` is excluded from `pnpm test`).
**When it goes green, fold it into `pnpm test`** by deleting the exclude line
in `vitest.config.ts`.

---

## Audit detail

| Audit check                                      | State              |
| ------------------------------------------------ | ------------------ |
| scans a meaningful number of files               | PASS               |
| no reverse v2 → v1 runtime projection            | PASS               |
| no special "main terrain" concept                | PASS (milestone 2) |
| no Babylon TerrainMaterial for authored surfaces | PASS (milestone 2) |
| editor.html has no giant inline `<style>`        | PASS (`600ba80`)   |
| no parallel multi-selection arrays               | FAIL               |
| no UndoOp/applyOp history mechanism              | FAIL               |
| main.ts is boot/wiring (< 25 KB)                 | FAIL — 171 KB      |

All three remaining failures are the SAME piece of work: `main.ts` still
contains the whole editor, including `multi*` and `UndoOp`/`applyOp`. They go
green together when EditorDocument is integrated and the file is decomposed.

---

## Completed

### Correctness — paint tint schema loss (`3ba1343`)

`PaintLayerSchemaV2` had no `color`, so Zod stripped the tint on every parse
of the canonical wire: "red brick tinted blue" saved as untinted brick, and a
plain-colour layer lost the only property that made it visible. One shared
`HexColorSchema` (#rrggbb lower-case) is used by every schema carrying a
colour. Six regression tests; five fail on the previous schema.

### Milestone 1 — schema completion (`6aab3c8`)

- **Stable ids.** `normalizeMapIds()` assigns deterministic ids before
  validation, so the schema requires them on terrains/statics/nodes/props/
  lights/zones. Persisted on the next save, stable forever after. Duplicate
  ids across kinds rejected; `spawn` reserved for the synthetic spawn object.
- **Typed lights.** `MapLightSchema` in `schema/world.ts` is the ONE
  definition (the interface re-exports from it). Was `z.record(unknown)` on
  the wire beside a hand-written interface of the same name.
- **Zones.** `MapFileV2.zones[]` reusing `ZoneDefSchema`, plus finiteness /
  min≤max / world-bounds checks. Map zones AUGMENT base content zones:
  `ZoneIndex` holds the layers separately and `setMapZones` REPLACES the map
  layer, so repeated saves cannot stack volumes and a map can add a
  restriction but never lift one the world def declared.
- `StaticObjectSchemaV2` composes `StaticBodySchema` with the surface
  authoring the paint work needs.

### Milestone 2 — the special main terrain is gone (`487053c`)

- Deleted: `terrain:main`, `mainSelected`, `mainGone`, `mainconvert`,
  `selectMainTerrain`, `convertMainToPatch`, the fake -6 m heights buffer, the
  MIX splat canvas + DynamicTexture, the `paint` undo variant, `TerrainMaterial`.
- **The invisible ground is gone.** `buildTerrainGrid(world)` samples through
  the map override, so with a map loaded the client mesh AND both trimesh
  colliders were resampling the map's own terrains onto a world-sized grid —
  a second floor at every authored height, and for a terrain-less map a flat
  sheet at y = 0 that rendered as nothing and collided as a floor. That grid
  is now built only when there is no map at all.
- The base world's procedural terrain renders through `LayeredSurfaceMaterial`.
- E2E fixture is native v2 (`terrain-floor`); a separate v1 smoke proves
  migration.

### Milestone 3a — EditorDocument (`d9d6d42`) — **module only, NOT integrated**

`apps/client/src/editor/document/editorDocument.ts`: a validated `MapFileV2`
with an id index and a typed change feed (`added|removed|updated|replaced|
documentReplaced`), `transact()` batching, spawn as a synthetic object under a
reserved id, and `updated` changes carrying the keys that differ. 22 tests.

**It is not wired into `main.ts` yet** — the six parallel arrays are still the
live authority. This is the single largest remaining item.

### Editor CSS extracted (`600ba80`)

11 KB inline `<style>` → `apps/client/src/editor/editor.css`.

### Live reconciliation for statics and zones (`9a552d8`)

The Save button claimed "live". For statics it was not true at all: both sides
did `content.world.statics.push(...map.statics)` once at boot and never
touched them again, so a static added in the editor got no collision until the
server restarted, moving one changed nothing, and re-applying a map appended a
second copy. Zones were never applied at any point.

Map statics now live in an id-keyed layer on both sides (`MapStaticLayer` on
the server, a replaceable body list in client prediction, a `mapstatic:` mesh
layer in the renderer), separate from base content, which is never mutated.
Adds `diffMapFileV2` (+`affectsCollision`, `describeDiff`) in `@hobo/content`.
`/metrics` publishes mapStatics/mapTerrains/mapZones so the claim is checkable
from outside the process.

### Content-addressed map assets (`2629038`)

`POST /api/map-assets` names files by sha256 of the received bytes and sniffs
the type from those bytes (PNG/JPEG/WebP/GLB) rather than believing a query
parameter. Async temp+rename writes. `/api/texture` is the same handler under
its old name. Textures, imported models and paint masks all upload; masks stay
canvases in memory while editing and hash identically when unchanged, so a
re-save uploads nothing. Legacy embedded `dataUrl` / `data:` glb still load.

### Draft recovery, conflict UI, import/export (`dec7593`)

`DraftStore` (IndexedDB, injected storage, debounced, never auto-published,
keyed by origin+map, refuses a draft whose base revision is gone but offers it
for download). Conflict panel shows a real diff summary and is explicit that
nothing merges. The remote-change check was a signature of ARRAY LENGTHS —
now `diffMapFileV2`. Import migrates + validates + reports issues before
replacing anything; export downloads the source document including unsaved
edits.

---

## Remaining

### The big one — EditorDocument integration and main.ts decomposition

Everything below the first bullet is blocked on or much easier after it.

- [ ] wire `EditorDocument` into `main.ts` and delete `placedStatics` /
      `placedNodes` / `placedProps` / `patches` / `mapLightsArr` / `mapZones`
- [ ] `EditorViewRegistry` — object id ↔ Babylon projection
- [ ] SelectionManager sole authority — delete `selected*` / `multi*` (audit)
- [ ] CommandHistory sole authority — delete `UndoOp`/`applyOp`/`pushUndo`
      and replace with stable-id document commands (audit)
- [ ] decompose `main.ts` to a boot/wiring layer (audit)

### Interaction

- [ ] `EditorCameraController` extraction; MMB pointer capture; cursor-centric
      wheel zoom
- [ ] real no-tool state; active tool/hotkey toggles off
- [ ] World/Local transform modes (math, not just the label)
- [ ] snapping UI (translation/rotation/scale, bypass modifier, persisted)
- [ ] `GizmoController` with explicit pointer ownership, and a browser test
      that reproduces the ORIGINAL click-through mechanism rather than
      asserting the current one behaves

### Workspace

- [ ] resizable/collapsible persistent workspace shell
- [ ] Outliner, type-specific Inspector, Asset Browser, Scene/Environment
      panel, History panel, status bar
- [ ] reusable number/vector field (scrub, step, fine/coarse, one command per
      gesture)
- [ ] zones in the EDITOR (schema + runtime done; no tool/inspector/outliner)

### Painting

- [ ] `PaintableSurface` abstraction
- [ ] box/panel faces, cylinder, sphere
- [ ] imported models, per-instance isolation, no-UV projection fallback
- [ ] paint layer manager UI (budget, visibility, clear, erase)

### Runtime and collaboration

- [ ] terrain/light/spawn stable-id reconciliation (statics + zones done)
- [ ] node/prop reconciliation that distinguishes map seeds from
      player-created persistent entities
- [ ] collaboration migrated onto the document/selection model; typed protocol
- [ ] performance pass (pick caching, incremental view updates, DOM rebuilds)

### Docs

- [ ] `docs/MAP_EDITOR.md` rewritten to describe the final implementation

---

## Exact next implementation step

**Wire `EditorDocument` into `apps/client/src/editor/main.ts`.**

1. `const doc = new EditorDocument(bootDoc)` next to `bootDoc`.
2. Point `transformAccessor` at `doc` (get → `doc.get(id)`, set →
   `doc.update(id, …)`), so transforms have ONE source before anything else
   moves.
3. Replace the arrays one at a time, running `pnpm test:editor` after each:
   `mapZones` → `mapLightsArr` → `placedProps` → `placedNodes` →
   `placedStatics` → `patches` (last: `PatchState` holds decoded
   `Float32Array` heights, which is view state, so terrain needs the view
   registry at the same time).
4. `buildFile()` becomes `doc.serialize()`.

Then EditorViewRegistry, then selection-only, then history-only, then the
file split.

---

## Rules for whoever continues

- Never let both architectures run at once for longer than one commit.
- `pnpm test:editor` after every milestone; it catches interaction
  regressions unit tests cannot.
- The E2E harness verifies its own aim (`pickIdAt`) and waits for a stable
  gizmo handle. If a check goes flaky, suspect harness timing against
  software GL before suspecting the editor — but confirm, do not assume.
- Do not update `docs/MAP_EDITOR.md` to describe architecture that does not
  exist yet.
