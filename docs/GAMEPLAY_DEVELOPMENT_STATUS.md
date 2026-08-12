# Gameplay Development Status

Truthful gap analysis of the ACTUAL implementation, maintained as durable
state across development sessions. Updated at every milestone.

**Program start:** 2026-08-12, branch `gameplay-next` from `main` @ `2bcd139`.

## Session state (update at every milestone)

```
Current HEAD:    (Stage 2 milestone — see git log on gameplay-next)
Completed:       Stage 1 audit + baseline; Stage 2 sandbox depth:
                 - physics constraint set (weld/rope/hinge+limits+friction+
                   motor/slider+limits+motor/spring) in @hobo/physics with
                   pose-preserving joint frames; setConstraintMotor retune
                 - gameplay constraint domain: types, param validation
                   (CONSTRAINT_LIMITS hostile caps), skill gates, material
                   costs, ConstraintIslands union-find
                 - GameWorld ConstraintRecord (generalizes welds), islands,
                   restore/prune, dirty persistence; ConstraintDto.params;
                   sqlite migration v8 (params column)
                 - protocol v15: constraint/constraint_remove (world-space
                   click points -> server-computed local anchors), attack,
                   place; constraint_state broadcasts (+ on interest enter)
                 - rigging_tool item + recipe; salvaged_motor item + recipe
                   (workbench, construction 4); constraint costs (rope item,
                   scrap for springs, motor item)
                 - client: rigging weapon module (type/params panel),
                   two-click tool with selection outline + prompts, rope/
                   spring tube visuals with sag (constraintLines.ts)
                 - prop health capability (max/resistance/repair/destroyLoot
                   on 8 structures), attack pipeline (zone build-rule gated,
                   stamina economics), E-repair with materials, damaged
                   props refuse pickup, destruction scatters salvage +
                   container contents
                 - placement ghost preview (green/red zone validity, wheel
                   rotate, Shift grid snap) + server-validated place message
                   (spawns DYNAMIC, physics resolves overlap lies)
                 - metrics: constraints + constraintIslands; constraint
                   stress smoke (200 props/370 welds settle, sleeping steps
                   ~1.6ms, impact wakes 15, re-settles)
Tests:           649 unit tests pass (was 634; +15 constraint domain;
                 persistence tests extended in place); constraintSmoke.ts
                 (physics) OK; sliceTest extended with rigging + prop-
                 health phases + constraint restart persistence + hostile
                 inputs — all green; audit:editor green
Remaining:       Stages 3-13 (see ROADMAP.md)
Next exact step: Stage 3 — container domain module (shared by boxes/
                 machines/vehicles/merchants), equipment metadata,
                 temperature + status effects, server environment state
                 (time/weather)
```

## Architecture facts (verified, load-bearing)

- Server: fixed 30 Hz tick (`config.tickRate`, hardcoded), snapshots every
  2nd tick. One `GameServer.step()` drives movement → physgun → physics →
  sync/settle → crafting → survival (1 Hz) → replication → flush.
- `@hobo/gameplay` is engine-free (inventory, crafting, skills, movement,
  survival, zones, entity store). Verified: no Babylon/DOM/network imports.
- Physics: `PhysicsWorld` facade (`@hobo/physics`), Havok adapter via
  Babylon Physics V2, headless NullEngine on server. Constraint support
  today: `{type:'weld'}` only → Havok `LOCK` (havokWorld.ts:230).
  Settle detection is velocity-threshold based (`isSettled`), NOT engine
  sleep state; settled bodies drop out of snapshots and flush once.
- Persistence: better-sqlite3 WAL, SCHEMA_VERSION 7, forward-only
  migrations keyed on `meta.schema_version`. Tables: world_entities,
  players, constraints, guest_ips, meta. World map itself is a JSON file
  (MAP_PATH) + map-assets dir, authored by the editor; the world def
  `hoboville_v2` ships empty (everything map-authored).
- Protocol: JSON, zod-validated inbound, versioned. Wire rate limits:
  4 KB/message, 120 msgs/s per connection.
- Entities: `GameEntity` records with optional components (prop, resource,
  owner, mapSourceId); kinds player/prop/resource in `EntityStore` with
  kind indexes. No spatial index — interest = O(entities) radius scan per
  session (replication.ts:82).
- Interest management: per-session known-sets, spawn/despawn diffs,
  snapshots carry only awake relevant bodies. Sleep networking works.
- Client: prediction + reconciliation for movement; entity interpolation
  (~130 ms buffer); HUD tabs inventory/crafting/equipment/skills/players;
  container + merchant panels; contextual E-prompts computed in
  main.ts `promptFor()`. Weapon modules registry exists but only physgun.

## System-by-system audit

### Physics sandbox (physgun, props)

- **Implemented.** Grab/drag/rotate (view-relative, GMod-feel)/snap/grid/
  freeze/unfreeze/throw-cap; server-authoritative velocity drive; prop
  protection (owner + trust, offline TTL cache); zone gating.
- Files: `apps/server/src/game/physgun.ts`, `gameServer.ts` (handlePhysgun),
  client `weapons/physgunModule.ts`, `game/interactionController.ts`.
- Gaps: no precision translation snap while held beyond grid-lock; no
  player-facing constraint tools (see Constraints).

### Constraints

- **Implemented (Stage 2).** Player-facing rigging tool: weld, rope
  (anchored max-distance tether, consumes rope item), hinge (limits +
  friction), axis (free bearing), slider (travel limits), spring
  (stiffness/damping, consumes scrap), motor (driven hinge, consumes
  salvaged_motor; construction 5). Two-click UX with selection outline,
  equipment-panel settings, rope/spring tube visuals with sag; RMB cuts.
- Server validation: tool, ownership/trust, reach, anchor plausibility
  (clamped local anchors from world click points), gap, zone build rule,
  per-entity cap (12), same-type dedup, skill gates, material costs, param
  space (CONSTRAINT_LIMITS). XP on create.
- Persistence: ConstraintDto {type, params JSON} (migration v8), restore
  with unknown-type/dangling pruning, verified across restart in sliceTest.
- Islands: ConstraintIslands union-find (metrics constraints/
  constraintIslands; group semantics for later machine/vehicle assembly).
  Havok sleeps settled structures: 200-prop/370-weld wall settles, idle
  steps ~1.6 ms, impact wakes ~15 bodies, re-settles (constraintSmoke.ts).
- Remaining: motor retune UI (setConstraintMotor exists for machines/
  vehicles later); per-constraint break force.

### Building

- **Implemented (physical philosophy).** Craft -> drop (drop IS placement,
  clearance raycast) OR ghost placement: translucent preview with zone
  validity tint, wheel rotation, Shift snapStep grid; `place` message
  spawns DYNAMIC at pose (server validates slot/capability/range/zone/
  bounds; physics resolves overlap lies). Physgun position + freeze as
  before.
- Free placement always available (drop/toss unchanged).

### Items

- **Implemented, unified ItemDef with capability blocks:** world, food,
  seed, planter, shop, door, container, weapon (melee), health (max/
  resistance/repair/destroyLoot — Stage 2), placeable, workstation, tool
  (physgun/axe/pickaxe/rigging enum). 30 items.
- Missing capabilities (add with their gameplay): durability, armor, ammo,
  rangedWeapon, fuel, power*, fluidContainer, machine, processor,
  growable/harvestable (crop model richer than `seed`), vehiclePart,
  blueprint, valuable. `ItemStack.meta` exists (merge rules respect it)
  but nothing writes meta yet.

### Inventory

- **Implemented.** 24 slots (6 hotbar), stacks, move/split/merge/swap,
  atomic consume, canFit, DTO round-trip. Holster toggle. Server-
  authoritative with full-inventory resends on change.
- Missing: equipment slots (armor/clothing), durability/unique-instance
  metadata use, quick-transfer/sort UX.

### Containers

- **Implemented (basic).** `container` capability (storage box 12, supply
  crate 6); open/move in/out with range (4.5 m) + trust validation; live
  push to all viewers; persistence in entity state JSON; stocked containers
  refuse pickup.
- Missing: container-to-container transfer, quick transfer, split/sort/
  filter in container UI, containers as machine/vehicle interfaces. The
  container operations bypass the Inventory class (ad-hoc array code in
  gameServer.ts containerAdd) — should be unified into a domain module.

### Crafting / workstations

- **Implemented.** 19 recipes, categories, craft-time queue (4 jobs),
  workstation gating (workbench, campfire), skill gating, output-space
  aware, XP on completion. Nearby-workstation scan is O(props) per craft.

### Gathering

- **Implemented.** 6 node types, tool gating with bare-hand fallback,
  yield/power, respawn timers, felled-tree physical trunk spawn, XP.

### Survival

- **Implemented (foundation).** Health/hunger/thirst/stamina, 1 Hz tick,
  starvation/regen, sprint stamina, eat/drink (world water + food items),
  fall damage, death → city respawn (keeps inventory!), void rescue.
- Missing: temperature/wetness/shelter, status effects framework, rest,
  death inventory-drop semantics (currently nothing drops — relevant to
  extraction risk design later).

### Farming

- **Prototype.** `seed` + `planter` capabilities; plant via E, timestamp
  growth (240 s berries), harvest yields, farming XP, persistence of
  `plant` state, client growth visual scaling. ONE crop (berries).
- Missing: crop definitions as first-class content (stages, water,
  fertility, temperature, regrow), multiple crops, irrigation/water,
  fertilizer, greenhouse, farming props beyond planter_box.

### Combat

- **Melee PvP only.** Any held item swings; weapon capability overrides
  damage/range; stamina cost; knockback; zone PvP rules both-ends; swing
  cooldown (6 ticks); hurt/death FX; fall damage. No damage types, no
  damage to props/NPCs (no NPCs), no ranged, no armor, no medical items.

### Skills

- **Implemented.** 6 skills, XP-total persistence with derived levels,
  recipe level gates, level-up toasts, skills UI. No capability unlocks
  beyond recipes, no blueprint/discovery system.

### Economy

- **Bootstrap.** 9 fixed TRADES at merchant stall (bottle-cap `coin`),
  proximity check O(props), atomic-ish validation (consume then add — add
  is checked by canFit first). No markets/stock/restock/pricing, no
  economy API, no player shops.

### NPCs / Factions / Reputation

- **Missing entirely.** No NPC entity kind, no AI, no navigation, no
  factions, no reputation. The "merchant" is a static shop prop.

### Events / Extraction

- **Supply drops only, hardcoded.** One crate at a time, random site from
  content DROP_SITES, announce, loot via container, expiry. Lives directly
  in gameServer.ts (tickSupplyDrops). No generic event framework, no
  extraction mechanics, no secured-loot semantics.

### Loot

- DROP_LOOT fixed table for crates. No loot-table content schema.

### Vehicles / Power / Fuel / Water

- **Missing entirely.**

### World regions / simulation LOD

- **Missing.** Single active world; interest radius per session is the
  only spatial concept. Zones are AABB rule volumes (pvp/build/physgun),
  linear scan.

### Networking scale

- JSON protocol; per-session snapshot build is O(known entities); interest
  scan O(total entities × sessions) at 15 Hz. Metrics: bytesOut,
  messagesOut, snapshotBytes (not in /metrics snapshot output). Fine at
  current scale; spatial index is the first lever when populations grow.

### Persistence

- **Implemented** for players (token+slot identity, inventory, skills,
  friends, appearance, stats), world entities (props with container/door/
  plant state, resources), constraints (welds), guests, meta. Migrations
  v1-7 forward-only. Slice test verifies restart integrity end-to-end.
- Missing: per-feature DTOs as systems land (NPC abstract state, events,
  reputation, blueprints, vehicles, utility networks).

### World clock / environment

- **Partial.** 20-min day cycle anchored to server uptime (dayFraction),
  broadcast every 10 s; client renders sun/moon/sky/lamps. NOT persisted,
  no weather, no gameplay effect (light only).

### UI

- HUD: crosshair/prompt/toasts/vitals/hotbar/announce/death; Tab menu
  (inventory/crafting/equipment/skills/players); container + shop panels.
  Contextual prompts via promptFor() in main.ts. No map, no jobs/rep tabs.

### Observability

- /metrics JSON + periodic log summary: tick/physics EMA, sessions,
  entities, awake/settled bodies, bytes/messages out, map layer counts,
  RSS. Missing: constraint/island counts, NPC LOD tiers, region counts,
  per-client bandwidth, event/market counters.

### Security posture

- Inbound zod validation, size/rate caps, per-action range/zone/ownership
  checks, one live session per character, guest IP binding. Slice test
  covers protection/trust. No dedicated hostile-input test suite per
  action (added per-stage from Stage 2 on).

### Map editor (do not break)

- Mature subsystem: collaborative editing, locks, terrain sculpt/paint,
  statics, zones, lights, nodes/props with provenance-based live
  reconciliation into the running game. Gates: `pnpm audit:editor`
  (vitest arch audit), `pnpm test:editor` (browser E2E, sequential).

## Baseline quality gates (2026-08-12, start of program)

| Gate                       | Result                                                 |
| -------------------------- | ------------------------------------------------------ |
| pnpm typecheck             | clean                                                  |
| pnpm lint                  | clean                                                  |
| pnpm test                  | 47 files, 634 tests, all pass                          |
| pnpm build                 | clean (client bundle 285 kB main + 2 MB babylon chunk) |
| pnpm format:check          | clean                                                  |
| sliceTest.ts               | pass (all phases incl. restart persistence)            |
| audit:editor / test:editor | run at editor-touching changes                         |

## Dependency notes for upcoming stages

- Constraint tool (Stage 2) touches: physics ConstraintDesc union, GameWorld
  weld records → generalize to ConstraintRecord, ConstraintDto.type,
  protocol weld messages → constraint messages, client tool-mode seam
  (weapons registry currently panel-only; InteractionController hardcodes
  physgun branches — needs delegation hooks), prompt seam in main.ts.
- Prop health (Stage 2) is prerequisite for ranged combat vs structures
  (Stage 5) and NPC melee targets (Stage 7).
- Container domain module (Stage 3) is prerequisite for machines
  (Stage 4), vehicle trunks (Stage 11), merchant stock (Stage 8).
- Environment state (Stage 3) feeds farming moisture (Stage 4), NPC
  perception modifiers (Stage 7), solar power (later).
- Spatial hash (Stage 6) must replace interest scan AND workstation/shop
  proximity scans; NPC perception (Stage 7) queries it.
- Supply-drop migration (Stage 9) depends on the event engine; extraction
  secured-loot semantics interact with death/inventory rules (define
  at-risk vs secured explicitly there).
