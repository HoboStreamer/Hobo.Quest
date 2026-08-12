# Map editor completion — tracked status

**Branch:** `editor-completion` · **Last commit:** `630a880`

This is the live checklist for the editor-completion program. It is updated at
the end of every working session. **The authoritative machine-checked version
is `pnpm audit:editor`** (`apps/client/src/editor/architectureAudit.audit.ts`),
which fails while any legacy construct is still active runtime code.

Do not mark an item done here without the audit or a test proving it.

---

## Gate status (verified, not assumed)

| Gate                   | Command                                              | Status                      |
| ---------------------- | ---------------------------------------------------- | --------------------------- |
| Types                  | `pnpm typecheck`                                     | green                       |
| Unit                   | `pnpm test`                                          | green — 204 tests, 21 files |
| Lint                   | `pnpm lint`                                          | green                       |
| Format                 | `pnpm format:check`                                  | green                       |
| Build                  | `pnpm build`                                         | green                       |
| Editor E2E             | `pnpm test:editor`                                   | green — 47/47               |
| Server slice           | `node --import tsx apps/server/scripts/sliceTest.ts` | green                       |
| **Architecture audit** | `pnpm audit:editor`                                  | **RED — 6 of 8**            |

The audit is intentionally red and runs as its own gate (`*.audit.ts` is
excluded from `pnpm test`). **When it goes green, fold it into `pnpm test`**
by deleting the exclude line in `vitest.config.ts`.

---

## Audit detail — what is still failing

| Audit check                                      | State                    |
| ------------------------------------------------ | ------------------------ |
| scans a meaningful number of files               | PASS                     |
| no reverse v2 → v1 runtime projection            | **PASS**                 |
| no special "main terrain" concept                | FAIL                     |
| no parallel multi-selection arrays               | FAIL                     |
| no UndoOp/applyOp history mechanism              | FAIL                     |
| no Babylon TerrainMaterial for authored surfaces | FAIL                     |
| main.ts is boot/wiring (< 25 KB)                 | FAIL — currently ~168 KB |
| editor.html has no giant inline `<style>`        | FAIL — 11 KB block       |

---

## Definition of Done

### Done and verified

- [x] `/map.json` is native v2 (canonical document + ETag revision)
- [x] game client consumes v2 (`parseMapFile` → `compileMapFileV2`)
- [x] editor consumes v2 (boot, save and remote merge)
- [x] server runtime consumes v2 (boot + `onMapSaved(next, revision)`)
- [x] no reverse v2 → v1 runtime projection — `projectV2ToV1` deleted
- [x] first geometry bootstrap at 0,0,0
- [x] `TransformSession` drives single and group transform
- [x] camera proven stationary during gizmo transforms (E2E)
- [x] terrain wireframes persistent (E2E, id-derived)
- [x] face overlays show exact selected faces
- [x] Face Auto Apply works cleanly (one command per scrub)
- [x] pos/rot/scale for statics, terrain and models
- [x] primitive dimensions distinct from transform scale (`effectiveShape`)
- [x] paint works on all terrain
- [x] any registered stock/custom texture can be paint
- [x] texture tint / plain-colour paint
- [x] paint never destroys base material (E2E)
- [x] model assets cached (`ModelCache` + `AssetContainer`)
- [x] Issues panel exists and is document-driven
- [x] runtime DB artifacts untracked; `apps/*/data/*.db{,-*}` ignored
- [x] editor E2E tracked at `apps/client/e2e/editorCheck.ts` (`pnpm test:editor`)

### Not done

- [ ] **no starter/main/sunken terrain** — the runtime no longer has one, but
      `editor/main.ts` still builds a legacy `terrain` mesh + `wire` and keeps
      `terrain:main` selection/lock strings
- [ ] **blank map has zero terrain** — true for data; the editor still creates
      the legacy mesh object
- [ ] **EditorDocument is authoritative** — not written; the editor still holds
      `placedStatics` / `placedNodes` / `placedProps` / `patches` /
      `mapLightsArr` as parallel authorities
- [ ] **EditorViewRegistry** — not written
- [ ] **SelectionManager is the only selection authority** — it is the source of
      truth, but `selected*` / `multi*` still exist as a projection layer
- [ ] **legacy multi\* arrays gone**
- [ ] **CommandHistory is the only history authority** — it is the only stack,
      but `UndoOp`/`applyOp`/`pushUndo` still bridge into it
- [ ] **UndoOp/applyOp bridge gone**
- [ ] **gizmo click-through proven fixed in browser** — the mechanism is
      replaced and E2E scenarios A/A2 pass, but the ORIGINAL bug was never
      reproduced, so "proven fixed" is not yet honest
- [ ] paint on primitives (box faces, cylinder, sphere, panel)
- [ ] paint on imported models (+ documented projection fallback)
- [ ] paint masks content-addressed; unchanged masks deduplicate
- [ ] live reconciliation by stable id (save still rebuilds terrain wholesale)
- [ ] collaboration migrated onto the final selection/document model
- [ ] Outliner
- [ ] type-specific Inspector
- [ ] Asset Browser
- [ ] Scene/Environment panel
- [ ] resizable persistent workspace
- [ ] local/world transform mode
- [ ] snap settings UI
- [ ] `editor.html` free of inline CSS
- [ ] `main.ts` a small boot/wiring layer
- [ ] docs describe reality (`docs/MAP_EDITOR.md` still describes the wire as
      v1-projected, which is now wrong — **fix this early next session**)

---

## Exact next implementation step

**Retire the legacy main-terrain mesh in `apps/client/src/editor/main.ts`.**
This is the smallest change that turns an audit check green, and it unblocks
EditorDocument (Phase C) by removing the last object that is not an ordinary
terrain.

1. In `boot()`, delete the `terrain` `Mesh` and its `wire` overlay (search
   `const terrain = new Mesh('terrain', scene)`), the `heights` buffer, the
   `mixTex`/`mixCtx` splat canvas and the `MIX` constant. They no longer feed
   anything: the boot document has no top-level heightfield.
2. Delete `terrainTargets`' `'main'` entry (`terrainTargets.push({ id: 'main',
… })`) so every entry has a real terrain id, and drop the `t.id === 'main'`
   branches in `refreshTarget` and `applySculpt`/`applyPaint`.
3. Delete `selectMainTerrain`, `convertMainToPatch`, `mainGone`,
   `mainSelected`, and the `'terrain:main'` cases in `probeSelectionIds`,
   `ownerOf`, `meshById`, `objectExists` and `rebuildSelectionViewsInner`.
4. Delete the `paint` and `mainconvert` `UndoOp` variants and their `applyOp`
   branches (they only ever targeted the main terrain).
5. Remove the `TerrainMaterial` import — that also turns the
   "no Babylon TerrainMaterial" audit check green.
6. Run `pnpm typecheck && pnpm lint && pnpm test && pnpm test:editor` and then
   `pnpm audit:editor`; expect "no special main terrain concept" and
   "no Babylon TerrainMaterial" to flip to PASS.

After that, Phase C (EditorDocument) in this order: write
`editor/document/editorDocument.ts` wrapping `MapFileV2` with
`get/has/list/add/update/remove/snapshot/serialize/replaceFromRemote`; point
`transformAccessor` at it; then delete `placedStatics`/`placedNodes`/
`placedProps`/`patches`/`mapLightsArr` one array at a time, running the E2E
suite after each.

---

## Rules for whoever continues

- Never let both architectures run at once for longer than one commit.
- `pnpm test:editor` after every milestone; it catches interaction regressions
  that unit tests cannot.
- The E2E harness verifies its own aim (`pickIdAt`) and waits for a stable
  gizmo handle. If a check goes flaky, suspect harness timing against software
  GL before suspecting the editor — but confirm, do not assume.
- Do not update `docs/MAP_EDITOR.md` to describe architecture that does not
  exist yet.
