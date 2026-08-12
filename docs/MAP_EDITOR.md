# Map editor architecture

The editor at `/editor` authors the world the server runs. **The server is the
game** — the editor never serializes a Babylon scene as truth. It produces an
explicit data artifact (`map.json`), and the server validates, versions and
applies it.

This document describes the architecture after the correctness pass. Where a
design choice exists to fix a specific historical failure, that failure is
named: the reason is the useful part.

---

## Authority: document, views, selection

| Concern            | Owner                                  | Never                  |
| ------------------ | -------------------------------------- | ---------------------- |
| What exists        | the map artifact (`MapFileV2`)         | a Babylon mesh         |
| What is selected   | `SelectionManager`, a set of **ids**   | mesh references        |
| Where things are   | canonical `EditorTransform` per object | mesh transforms        |
| What the user sees | Babylon meshes, rebuilt freely         | anything authoritative |

Meshes are **projections**. Undo, a remote merge, a material change and a
texture rename all dispose and recreate them. Anything holding a mesh
reference across those events goes stale, which is why selection, face
selection and selection visuals are all keyed by stable id.

### Stable ids

Every authored object carries one: `s-…` statics, `n-…` nodes, `pr-…` props,
`terrain:<id>` terrain, `spawn`, light ids. Ids are the vocabulary for
selection, collaboration locks, history commands and the view registry.

---

## Interaction: one gesture, one action

`editor/interaction/interactionController.ts`

A pointer gesture is **claimed** on pointer-down and owned until pointer-up.
States: `idle`, `selection-click-candidate`, `camera-orbit`, `camera-pan`,
`camera-freelook`, `gizmo-drag`, `placement`, `terrain-sculpt`,
`surface-paint`, `face-edit`.

- `canStartGesture()` — only `idle` (or a bare click candidate) may claim.
- `pickingAllowed()` — false during any exclusive gesture.
- `cameraMayMove()` / `flightAllowed()` — the camera asks before moving.
- `end()` returns **true only for a click**: a click candidate whose pointer
  travel stayed under the slop. A drag is never a selection.

### Why gizmo click-through happened

Babylon's `UtilityLayerRenderer` hooks `originalScene.onPrePointerObservable`
at top priority and sets `skipOnPointerObservable` when a gizmo is hit. That
flag only suppresses Babylon's **own** `scene.onPointerObservable` — and the
editor listened on the raw DOM instead, entirely outside that mechanism. It
compensated with `gizmoDragging || gizmo.isHovered || setTimeout(…, 50)`:
three racing signals with no ordering guarantee.

The fix is ordering, not timing. `new Scene(engine)` attaches Babylon's input
manager during construction, long before any editor listener exists. So a
gizmo's `onDragStartObservable` has already run — synchronously, inside the
same DOM `pointerdown` — by the time the editor's handler executes. The
gesture is claimed, `canStartGesture()` is false, and nothing behind the
gizmo can be picked. There is no timeout anywhere.

### Camera isolation

MMB orbit/pan claim `camera-orbit` / `camera-pan`. Wheel zoom and WASD flight
check `flightAllowed()`. During `gizmo-drag` every one of them is refused, so
a transform can never be polluted by camera motion.

---

## Picking

`editor/interaction/editorPicker.ts` — **one** pick per selection gesture,
returning one front-most eligible hit.

Replaces "pick meshes, then separately multiPick terrain, then prefer the
smallest patch within 1.5 m", which could resolve one click to several objects
and made stacked terrain unpredictable.

- `resolveOwner` walks the parent chain, so imported-model child meshes
  resolve to their owning object. Helpers (sky, clouds, brush, ghosts, wires,
  face overlays, peer avatars) are owned by nothing and are never returned.
- `resolveFrontMost` breaks coincident-surface ties **by object id**, so the
  result does not depend on scene traversal order.
- The predicate re-tests `isPickable` / `isVisible` / `isEnabled`.

> **Babylon trap.** `scene.pick(x, y, predicate)` SKIPS the built-in
> pickability checks whenever a predicate is supplied. Forgetting this once
> left a deleted (disabled) island invisibly selectable. `EditorPicker` bakes
> the re-test in so no caller can forget it again.

---

## Selection semantics

`editor/selection/selectionManager.ts`

| Gesture                         | Result                                             |
| ------------------------------- | -------------------------------------------------- |
| click object                    | replace                                            |
| **Ctrl**+click object           | add (idempotent — already-selected stays selected) |
| **Alt**+click _selected_ object | remove only that one                               |
| **Alt**+click unselected object | nothing                                            |
| **Ctrl**/**Alt**+click empty    | preserve the selection                             |
| click empty                     | clear                                              |

Shift is **not** an object multi-select. Alt remains snap-bypass in a gizmo
context and the eyedropper in Face context; contexts do not collide because
the modifier is interpreted per interaction state.

Selection **freezes** for the duration of a transform. `retain(predicate)`
drops only ids whose object disappeared, which is what lets undo/redo keep a
selection alive instead of deselecting everything.

---

## Transforms

`editor/viewport/transformMath.ts` — position, **quaternion**, scale. Euler is
a display format only; accumulating rotations through Euler triples is what
produced drifting angles.

Group edits are one delta applied to every member's **immutable start**
snapshot:

```
newWorld = delta × startWorld      delta = pivotNow × pivotStart⁻¹
```

Two properties are asserted in tests and are the reason the model works:

- **Idempotent** — re-applying the same pivot pair does not compound, so a
  per-frame drag is safe.
- **Exactly invertible** — cancel restores the start transforms.

### TransformSession

`editor/viewport/transformSession.ts` owns a gesture from grab to commit:

1. snapshot ids + start transforms, compute the pivot, verify locks for the
   **whole** set atomically, open a history transaction;
2. `update(pivotNow)` recomputes every member from its start snapshot;
3. `commit()` records **one** command, or nothing if nothing changed;
4. `cancel()` restores exact start snapshots and records nothing.

The gizmo always rides a dedicated pivot node — single selection included.
Nothing is ever reparented. This replaces `bakeMulti()`, which parented
heterogeneous meshes to a pivot, read the already-transformed mesh pose back
out as its source, and had a separate bake branch per object kind.

### Scale vs dimensions

They are **separate**, and both are real.

- `StaticBody.scale` is canonical. `effectiveShape(body)` is the ONE place
  dimensions and scale combine, used by client rendering, client prediction
  physics and server physics — so a scaled object cannot render at one size
  and collide at another.
- Primitive dimensions (width/height/depth, radius) are their own Geometry
  fields.
- Scale defaults to `1,1,1` and is never displayed as `0`.

### Terrain transforms

Terrain is a local heightfield plus a world transform, and supports position,
rotation **and scale**:

- render: `mesh.scaling`
- collision: `scalePatchPositions()` scales the trimesh vertices on both the
  server and client-prediction sides — Babylon and Havok both apply
  scale → rotate → translate, so the two agree
- ground queries: `sampleOverride()` divides by X/Z and multiplies height by Y

Mixed terrain + static groups transform together through the same session.

---

## History

`editor/history/commandHistory.ts`

An `EditorCommand` owns its own `execute`/`undo`, so the history knows nothing
about what is changing. This replaces a 23-variant `UndoOp` union and one
giant `applyOp` switch that reached into editor closures — every feature added
a variant and a branch, and every branch had to remember to rebuild meshes and
fix up selection.

- **One interaction = one entry.** `beginTransaction` / `commitTransaction`
  collapse a 40-frame drag or numeric scrub into a single command;
  `cancelTransaction` rolls back and records nothing.
- **Dirty** compares command _identity_, not stack depth: undoing back to the
  saved point clears it, while "undo, then do something else" stays dirty.
- Memory and entry budgets are enforced; paint commands report their real
  retained size.
- **Undo does not deselect.** It re-derives the view and calls
  `selection.retain(...)`.

Legacy `UndoOp`s are bridged in as commands, so old mutations and new sessions
share one stack, one undo/redo path and one dirty flag.

---

## Selection visuals

Derived from **state**, never from event side effects.

Terrain wire visibility is computed each frame from the selection **set of
ids** — `selectedTerrains.has('terrain:' + patch.id)` — not from mesh
identity. Keying on the mesh meant any rebuild made a selected terrain's wire
vanish; the regression test samples twelve consecutive frames.

Authored materials are never mutated to show selection.

---

## Face selection

`editor/selection/faceSelection.ts`

Identity is `objectId:face` (`face` = box face 0..5, or `all`), which survives
mesh rebuilds. `parseFaceKey` splits on the **last** colon so terrain ids
containing colons round-trip.

`FaceOverlayManager` draws one translucent overlay per selected face, built
from that face's own two triangles (`indices[face*6 … face*6+6)`), parented to
the source so it tracks moves and scales, `zOffset -2` and
`renderingGroupId 1` to avoid z-fighting, never pickable. Primary is stronger
than secondary; hover is separate. Previously "highlighting a face" added the
whole mesh to the HighlightLayer, lighting up all six sides of a box.

Cylinders, spheres and terrain highlight their whole surface — honest until
sub-surface semantics exist for them.

**Auto Apply** (opt-in, persisted locally): style edits preview live on every
selected face, but a continuous scrub opens one transaction on pointer-down
and commits a single entry on release. Escape rolls it back.

---

## Surfaces and painting

`packages/content/surface.ts` (data) + `render/layeredSurface.ts` (renderer) +
`editor/materials/paintMask.ts` (brush).

A surface is a **base style** plus up to four **paint layers**. The base is
never touched by painting — it shows wherever no layer covers it. Each layer
references any registered texture and owns one RGBA channel of a single
coverage mask, so a surface costs 1 base + 4 layer + 1 mask = 6 samplers no
matter how many textures the project has.

This replaces Babylon's `TerrainMaterial`, whose three diffuse slots were
hard-wired to grass/rock/mud: choosing the Paint tool _replaced_ whatever
texture a surface had with that palette, and nothing else could be painted.

- `allocateLayer()` reuses the layer for a texture, un-hides a hidden one, and
  returns `null` at the budget so the caller opens the layer manager. A base
  texture is never swapped out to make room.
- The renderer is a `CustomMaterial` injecting the blend at
  `CUSTOM_FRAGMENT_UPDATE_DIFFUSE`, so lighting, shadows, fog and the
  day/night rig keep working. The **same class runs in the editor and in
  play**, so painting is WYSIWYG.
- A 1×1 white texture backs plain-colour bases so `vDiffuseUV` always exists;
  `hoboEnabled` gates unused samplers to zero.
- Channels are stamped independently: painting layer B cannot erase layer A or
  the base. Erase subtracts from the active channel rather than painting a
  fake base colour.
- Paint undo stores the changed **rectangle**, not a whole-canvas snapshot.

Legacy maps migrate: `migrateLegacyMix` maps the old R/G/B splat onto layers
grass/rock/mud on channels r/g/b, leaving alpha free.

---

## Map format

`packages/content/mapFileV2.ts`

v1 carried a **mandatory** top-level heightfield. That one privileged object
leaked everywhere: `terrain:main` as a special selection id, `mainSelected`,
`mainconvert`, a `heights.fill(-6)` that faked deletion, and an invisible
collider that never went away.

v2 has **no main terrain**. `terrains[]` holds ordinary objects, each with a
stable id, canonical transform, heightfield and surface. `emptyMapV2()` is
genuinely empty.

- `parseMapFile(raw)` accepts v1 or v2 and always yields v2.
- `migrateV1ToV2` is deterministic (same input → same ids). The old main
  heightfield becomes ONE ordinary terrain; a v1 main that was "deleted" by
  sinking below the waterline is **dropped**, not carried over.
- `validateMapFile` checks height count vs resolution, duplicate ids across
  kinds, dangling texture/model/paint refs, non-finite transforms, zero scale
  and paint-layer budget.
- `canonicalizeMapFile` is key-order independent and drops `undefined`, so the
  revision hash is stable.

### Blank world

A new map has no geometry, so a placement ray hits nothing. When the authored
count is **zero**, the first mesh/terrain/model commits at exactly the origin
wherever the user clicks. Sky, water, grid and helpers do not count.

---

## Save pipeline and revisions

`apps/server/net/mapStore.ts`

`authenticate → size-limit → parse → migrate → validate → revision check →
canonicalise → atomic write → apply live → broadcast`.

- The revision is a SHA-256 of the canonical form, served as an **ETag**. The
  editor sends it back as **If-Match**; a stale save is a **409** rather than
  a silent overwrite. The old "revision" was a string of array lengths.
- Structured errors: 400 invalid JSON, 403 unauthorised, 409 stale, 413 too
  large, 422 invalid map (with issues).
- All fs is async; writes are temp + `rename`, so a crash cannot leave a
  half-written map.
- An unchanged map is a no-op **only if the artifact already exists** — the
  first save of an empty map must still create the file.

A poll that finds an unchanged revision does nothing. Rebuilding the world
every tick was dropping selections and flickering terrain wires.

---

## Extending the editor

**A new object kind:** give it a stable id; teach `ownerOf` (picking) and the
`TransformAccessor` (`get`/`set`) about it; add a branch to
`rebuildSelectionViews`; add its inspector section. Transforms, group edits,
history and locks then work for free.

**A new inspector section:** read from the document by id, write through the
accessor or a command. Never write a mesh directly — the mesh is a projection.

**A new paintable surface:** give it UVs and a `SurfaceMaterialData`, build a
`LayeredSurfaceMaterial` for it, and point its mask sampler at a `PaintMask`.

---

## Tests

- Unit (`vitest`): selection, interaction, picker, transform maths, transform
  session, command history, face identity, surface layers, MapFile v2, save
  pipeline.
- Browser (`node --import tsx scratch/editorRepro.mts`): drives the editor
  only through `window.__editor` and interacts with **real gizmo handle
  geometry** found by ray-testing the utility layer. Scenarios A (click-
  through), A2 (rapid click), B (group gizmo), F (Ctrl/Alt semantics),
  G (terrain wire), H (scale), I (base survives paint), K (face overlays),
  L (environment).
- The harness verifies its aim through the editor's own picker rather than
  trusting render timing.
