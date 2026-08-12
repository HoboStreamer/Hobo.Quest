# Map editor completion — tracked status

**Branch:** `editor-completion` · **Last commit:** `487053c`

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
| Unit                   | `pnpm test`                                          | green — 233 tests, 21 files |
| Lint                   | `pnpm lint`                                          | green                       |
| Format                 | `pnpm format:check`                                  | green                       |
| Build                  | `pnpm build`                                         | green                       |
| Editor E2E             | `pnpm test:editor`                                   | green — 55/55               |
| Server slice           | `node --import tsx apps/server/scripts/sliceTest.ts` | green (walk step is timing-flaky; reruns clean) |
| **Architecture audit** | `pnpm audit:editor`                                  | **RED — 4 of 8 green**      |

Sizes: `apps/client/src/editor/main.ts` **163 KB** (target ≤ 25 KB),
`apps/client/editor.html` **23 KB** with an 11 KB inline `<style>` block
(target < 2 KB).

The audit runs as its own gate (`*.audit.ts` is excluded from `pnpm test`).
**When it goes green, fold it into `pnpm test`** by deleting the exclude line
in `vitest.config.ts`.

---

## Audit detail

| Audit check                                      | State                    |
| ------------------------------------------------ | ------------------------ |
| scans a meaningful number of files               | PASS                     |
| no reverse v2 → v1 runtime projection            | PASS                     |
| no special "main terrain" concept                | **PASS** (milestone 2)   |
| no Babylon TerrainMaterial for authored surfaces | **PASS** (milestone 2)   |
| no parallel multi-selection arrays               | FAIL                     |
| no UndoOp/applyOp history mechanism              | FAIL                     |
| main.ts is boot/wiring (< 25 KB)                 | FAIL — 163 KB            |
| editor.html has no giant inline `<style>`        | FAIL — 11 KB block       |

---

## Completed

### Correctness fix — paint tint schema loss (`3ba1343`)

`PaintLayerSchemaV2` had no `color`, so Zod stripped the tint on every parse
of the canonical wire: "red brick tinted blue" saved as untinted brick, and a
plain-colour layer lost the only property that made it visible. One shared
`HexColorSchema` (#rrggbb lower-case) is now used by every schema carrying a
colour. Six regression tests; five fail on the previous schema.

### Milestone 1 — schema completion (`6aab3c8`)

- **Stable ids.** `normalizeMapIds()` assigns deterministic ids before
  validation, so the schema can require them on terrains/statics/nodes/props/
  lights/zones. Persisted on the next save, stable forever after. Duplicate
  ids across kinds rejected; `spawn` reserved for the synthetic spawn object.
- **Typed lights.** `MapLightSchema` in `schema/world.ts` is now the ONE
  definition (the interface re-exports from it). Was `z.record(unknown)` on
  the wire beside a hand-written interface of the same name.
- **Zones.** `MapFileV2.zones[]` reusing `ZoneDefSchema`, plus finiteness /
  min≤max / world-bounds checks. Map zones AUGMENT base content zones:
  `ZoneIndex` holds the layers separately and `setMapZones` REPLACES the map
  layer, so repeated saves cannot stack volumes and a map can add a
  restriction but never lift one the world def declared.
- `StaticObjectSchemaV2` composes `StaticBodySchema` with the surface
  authoring the paint work needs, keeping `surface.ts` out of the runtime
  physics schema.

### Milestone 2 — the special main terrain is gone (`487053c`)

- Deleted from the editor: `terrain:main`, `mainSelected`, `mainGone`,
  `mainconvert`, `selectMainTerrain`, `convertMainToPatch`, the fake -6 m
  heights buffer, the MIX splat canvas + DynamicTexture, the `paint` undo
  variant, and `TerrainMaterial`.
- **The invisible ground is gone.** `buildTerrainGrid(world)` samples through
  the map override, so with a map loaded the client mesh AND both trimesh
  colliders were resampling the map's own terrains onto a world-sized grid —
  a second floor at every authored height, and for a terrain-less map a flat
  sheet at y = 0 that rendered as nothing and collided as a floor. That grid
  is now built only when there is no map at all.
- The base world's procedural terrain renders through
  `LayeredSurfaceMaterial`, so the three hard-wired diffuse slots are gone.
- E2E fixture is native v2 (`terrain-floor`); a separate v1 smoke proves
  migration. New sections M (blank map: no terrain object, no terrain mesh,
  no stray `terrain`/`wire` mesh) and N (v1 migration). 47 → 55 checks.

---

## Remaining

- [ ] **EditorDocument** — not written; the editor still holds
      `placedStatics` / `placedNodes` / `placedProps` / `patches` /
      `mapLightsArr` / `mapZones` as parallel authorities
- [ ] **EditorViewRegistry** — not written
- [ ] **SelectionManager sole authority** — `selected*` / `multi*` remain as a
      projection layer (audit FAIL)
- [ ] **CommandHistory sole authority** — `UndoOp`/`applyOp`/`pushUndo` still
      bridge into it (audit FAIL)
- [ ] gizmo click-through proven against the ORIGINAL mechanism
- [ ] camera controller extraction; MMB pointer capture; cursor-centric wheel
- [ ] real no-tool state; tool toggle-off
- [ ] World/Local transform modes; snapping UI
- [ ] `main.ts` decomposition (audit FAIL); `editor.css` extraction (audit FAIL)
- [ ] workspace shell, Outliner, type-specific Inspector, Asset Browser,
      Scene/Environment panel, History panel, status bar
- [ ] number/vector field component
- [ ] zones in the EDITOR (schema + runtime done; no tool/inspector/outliner yet)
- [ ] paint on primitives (box faces, cylinder, sphere) and imported models
- [ ] `PaintableSurface` abstraction; no-UV projection fallback
- [ ] content-addressed asset store (`/api/map-assets`); textures, models and
      paint masks as asset references
- [ ] `diffMapFileV2`; live reconciliation by stable id (terrain, statics,
      lights, zones, spawn); node/prop reconciliation that respects
      player-created state
- [ ] collaboration on the final document/selection model
- [ ] revision-conflict UI; IndexedDB draft recovery; import/export
- [ ] performance pass
- [ ] docs describing the final implementation

---

## Exact next implementation step

**Write `apps/client/src/editor/document/editorDocument.ts`** (milestone 3).

`MapFileV2` wrapper with `get/has/typeOf/list/listByKind/add/update/replace/
remove/snapshot/serialize/replaceFromRemote/subscribe`, emitting typed
`added|removed|updated|replaced|documentReplaced` changes keyed by stable id.
Then point `transformAccessor` at it and delete the parallel arrays ONE AT A
TIME — `placedStatics`, `placedNodes`, `placedProps`, `patches`,
`mapLightsArr`, `mapZones` — running `pnpm test:editor` after each.

Order after that: EditorViewRegistry (4) → SelectionManager-only (5) →
CommandHistory-only (6) → transform/gizmo/camera/tool (7) → main.ts split +
CSS (8) → workspace/Outliner/Inspector (9) …

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
