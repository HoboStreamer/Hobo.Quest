# Map editor completion — tracked status

**Branch:** `editor-completion` · **Last commit:** `67997be`

This is the live checklist for the editor-completion program, updated after
every milestone. **The authoritative machine-checked version is
`pnpm audit:editor`** (`apps/client/src/editor/architectureAudit.audit.ts`),
which fails while any legacy construct is still active runtime code.

Do not mark an item done here without the audit or a test proving it.

---

## Gate status (verified, not assumed)

| Gate                   | Command                                              | Status                      |
| ---------------------- | ---------------------------------------------------- | --------------------------- |
| Types                  | `pnpm typecheck`                                     | green                       |
| Unit                   | `pnpm test`                                          | green — 502 tests, 39 files |
| Lint                   | `pnpm lint`                                          | green                       |
| Format                 | `pnpm format:check`                                  | green                       |
| Build                  | `pnpm build`                                         | green                       |
| Editor E2E             | `pnpm test:editor`                                   | green — 76/76               |
| Server slice           | `node --import tsx apps/server/scripts/sliceTest.ts` | green                       |
| **Architecture audit** | `pnpm audit:editor`                                  | **RED — 5 of 8 green**      |

`apps/client/src/editor/main.ts` is **171 KB** (target ≤ 25 KB).
`apps/client/editor.html` is **12 KB**, inline `<style>` gone.

Slice-test notes: the `walkTo` step is timing-flaky under load and logs
"walkTo stuck?" before succeeding. The `node state persisted (N)` count varies
between runs — that is the diagnostic value, not the assertion; the resource
pile legitimately respawns on a 120 s timer and the assertion compares
pre/post-restart state.

---

## Audit detail

| Audit check                                      | State         |
| ------------------------------------------------ | ------------- |
| scans a meaningful number of files               | PASS          |
| no reverse v2 → v1 runtime projection            | PASS          |
| no special "main terrain" concept                | PASS          |
| no Babylon TerrainMaterial for authored surfaces | PASS          |
| editor.html has no giant inline `<style>`        | PASS          |
| no parallel multi-selection arrays               | FAIL          |
| no UndoOp/applyOp history mechanism              | FAIL          |
| main.ts is boot/wiring (< 25 KB)                 | FAIL — 171 KB |

**All three remaining failures are ONE task** — see "The swap" below.

---

## Completed

### Correctness — paint tint schema loss (`3ba1343`)

`PaintLayerSchemaV2` had no `color`, so Zod stripped the tint on every parse
of the canonical wire. One shared `HexColorSchema` now serves every schema
carrying a colour. Six regression tests; five fail on the previous schema.

### Milestone 1 — schema completion (`6aab3c8`)

Stable ids on every editable object (`normalizeMapIds`, deterministic,
pre-validation); typed lights (`MapLightSchema` is the ONE definition, was
`z.record(unknown)` beside a hand-written interface); zones in v2 reusing
`ZoneDefSchema`, augmenting base content zones through a replaceable
`ZoneIndex` map layer so repeated saves cannot stack volumes.

### Milestone 2 — the special main terrain is gone (`487053c`)

`terrain:main`, `mainSelected`, `mainGone`, `mainconvert`,
`selectMainTerrain`, `convertMainToPatch`, the -6 m heights buffer, the MIX
splat canvas, the `paint` undo variant and `TerrainMaterial` all deleted.
**The invisible ground went with it**: `buildTerrainGrid(world)` samples
through the map override, so both trimesh colliders and the client mesh were
resampling the map's own terrains onto a world grid — a second floor at every
authored height, and a flat y = 0 sheet for a terrain-less map. Built only
when there is no map at all now.

### Editor CSS extracted (`600ba80`)

### Live reconciliation for statics and zones (`9a552d8`)

`content.world.statics.push(...)` at boot was permanent, so a live save added
collision it could never move or remove, and re-applying a map appended a
second copy. Map statics live in an id-keyed layer on both sides now;
`diffMapFileV2` (+ `affectsCollision`, `describeDiff`) added to
`@hobo/content`; `/metrics` publishes the live counts.

### Content-addressed map assets (`2629038`)

`POST /api/map-assets`: sha256 of the received bytes, type sniffed from those
bytes, async temp+rename, dedupe. Textures, models and paint masks all use
it; legacy embedded assets still load.

### Draft recovery, conflict UI, import/export (`dec7593`)

IndexedDB drafts (debounced, never auto-published, refused when the base
revision is gone but offered for download); conflict panel with a real diff
summary that does not claim to merge; the array-length change signature
replaced with `diffMapFileV2`; import migrates + validates before replacing.

### The new architecture — modules and tests (`8b14f73`, `3aa99ce`, `8c0b69a`, `3174178`)

Fourteen modules, ~4,500 lines, each tested standalone. **None of them is
wired into `main.ts` yet.**

| Module                               | What it replaces                                                        |
| ------------------------------------ | ----------------------------------------------------------------------- |
| `document/editorDocument.ts`         | six mutable arrays with no stated authority                             |
| `document/editorObject.ts`           | per-kind pose handling scattered through the gizmo path                 |
| `viewport/editorViewRegistry.ts`     | five parallel `Map<Mesh, T>` + `terrainTargets`                         |
| `viewport/views/index.ts`            | `renderStatic`/`renderNode`/`renderProp`/`renderLight`/`buildPatchMesh` |
| `history/commands.ts`                | the `UndoOp` union and its 400-line `applyOp` switch                    |
| `viewport/gizmoController.ts`        | inline `GizmoManager` wiring                                            |
| `viewport/editorCameraController.ts` | inline camera handlers                                                  |
| `viewport/editorPreferences.ts`      | (new) World/Local, snap, grid                                           |
| `selection/selectionVisuals.ts`      | `refreshSelectionVisuals` + `selected*`/`multi*`                        |
| `tools/toolManager.ts`               | `let tool: Tool` with no null state                                     |
| `tools/placementTool.ts`             | `ensureGhost`/`computePlacePose`/`placeAt`                              |
| `tools/terrainTool.ts`               | `sculpt()`                                                              |
| `materials/paintableSurface.ts`      | (new) paint past terrain                                                |
| `input/actionRouter.ts`              | inline `runAction` + `keydown`                                          |
| `ui/workspace.ts`                    | the 270 px sidebar that hid its own expand button                       |
| `ui/outliner.ts`                     | (new)                                                                   |
| `ui/inspector.ts`                    | the floating all-kinds props popover                                    |
| `ui/panels.ts`                       | (new) Assets, History, Status, Scene                                    |
| `ui/numberField.ts`                  | `makeScrubbable`/`scrubAllNumbers`                                      |
| `collaboration/lockController.ts`    | inline lock state in `boot()`                                           |
| `recovery/draftStore.ts`             | (new)                                                                   |

---

## The swap — the ONE remaining task

`main.ts` still contains the whole editor. Everything it needs to become a
boot layer now exists and is tested; what is left is connecting them and
deleting the old body. This is a single large change, not a series of small
ones, because the legacy arrays, `multi*` and `UndoOp` are mutually
entangled — which is why it has NOT been started in a half state.

### Order

1. **`ui/editorShell.ts`** — build the workspace DOM (toolbar / outliner /
   viewport / inspector / dock / status). `editor.html` becomes a shell with
   `#game`, `#workspace` and the dialogs. Keep these ids, which the E2E
   harness and probe use: `game`, `save`, `key`, `status`, `conflict*`,
   `map-export`, `map-import`, `settings-btn`, `peers`.
2. **`editorApp.ts`** — the composition root. Boot engine/scene/Environment;
   `parseMapFile` → `EditorDocument`; `EditorViewRegistry` with
   `createViewFactory`; `SelectionManager` + `SelectionVisuals`;
   `CommandHistory` + `commands.ts`; `TransformSession` +
   `GizmoController`; `ToolManager` + tools; `ActionRouter`; workspace
   panels; save/draft/conflict; `LockController` over the existing WS.
3. **`interaction/viewportInteraction.ts`** — the canvas pointer handlers
   (select / place / sculpt / paint), driving `InteractionController`.
4. **`main.ts`** — `import './editor.css'; void bootEditor()`. Under 1 KB.
5. Delete `document/editorTypes.ts`'s `UndoOp` union.
6. `pnpm test:editor` and fix until 76/76 again, then extend the suite with
   the scenarios the new architecture makes assertable (Outliner selection
   sync, Inspector mixed values, no-tool state, World/Local, snapping,
   zone create/resize/rules, primitive and model painting).
7. Fold the audit into `pnpm test` (delete the exclude in `vitest.config.ts`).

### The probe API the E2E depends on

`selectionIds primaryId interactionState gizmoState gizmoHandleScreenPos
cameraSnapshot history terrainWires faceSelKeys pickIdAt surfaceMaterialOf
setPaintTexture setPaintColor setInspectorTexture terrainIds transformOf
worldToScreen setToolByName selectByIds undo redo setCameraPose objectCounts
terrainMeshCount sceneMeshNames dirty groupMove faceOverlayCount paintSurface
hasSky tool` — keep every one, and keep `terrainIds()` returning the
`terrain:`-prefixed form until the harness is updated in the same commit.

---

## Remaining after the swap

- [ ] paint on primitives and imported models — the abstraction
      (`paintableSurface.ts`) and its projections are done and tested; the
      brush still only routes to terrain
- [ ] terrain/light/spawn live reconciliation (statics + zones done)
- [ ] node/prop reconciliation distinguishing map seeds from player-created
      entities
- [ ] typed collaboration protocol (the client half, `LockController`, is done)
- [ ] performance pass (pick caching, incremental Outliner updates)
- [ ] `docs/MAP_EDITOR.md` rewritten to describe the final implementation

---

## Rules for whoever continues

- Never let both architectures run at once for longer than one commit. The
  swap above is deliberately one commit for exactly this reason.
- `pnpm test:editor` after every milestone; it catches interaction
  regressions unit tests cannot.
- The E2E harness verifies its own aim (`pickIdAt`) and waits for a stable
  gizmo handle. If a check goes flaky, suspect harness timing against
  software GL before suspecting the editor — but confirm, do not assume.
- Do not update `docs/MAP_EDITOR.md` to describe architecture that does not
  exist yet.
