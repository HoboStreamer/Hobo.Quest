# Gameplay Development Status

Truthful gap analysis of the ACTUAL implementation, maintained as durable
state across development sessions. Updated at every milestone.

**Program start:** 2026-08-12, branch `gameplay-next` from `main` @ `2bcd139`.

## Session state (update at every milestone)

```
Current HEAD:    2bcd139 (branch gameplay-next, program start)
Completed:       Stage 1 audit (this document), baseline gates
Tests baseline:  47 files / 634 tests pass; typecheck, lint, build,
                 format:check all clean; sliceTest: see below
Remaining:       Stages 2-13 (see ROADMAP.md)
Next exact step: Stage 2 — constraint architecture (ConstraintDefinition/
                 Record/Service), rope/hinge/slider/spring/axis/motor in
                 @hobo/physics + gameWorld, player-facing constraint tool
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
- **Partial (engine + persistence foundation only).** Weld = Havok LOCK;
  `GameWorld` weld records with dirty/deleted tracking; `constraints` table;
  restore with dangling-record pruning; protocol `weld`/`unweld` messages
  gated on a `hammer` tool **that has no item def** — the client never
  sends weld/unweld and renders no weld visuals. Effectively unreachable
  by players.
- Files: `gameWorld.ts:352-413`, `interactions.ts:handleWeld`,
  `physics/types.ts` (ConstraintDesc), `havokWorld.ts:addConstraint`.
- Missing: rope/hinge/slider/spring/axis/motor variants; constraint tool UX
  (two-click select, visuals); constraint islands (welded structures never
  group-sleep intelligently — settle is per-body velocity); constraint
  metrics; break/removal by tool; anchor points (welds lock current pose,
  no local anchors on the wire or in persistence).

### Building
- **Implemented (physical philosophy).** Craft → drop (drop IS placement,
  with clearance raycast) → physgun position → freeze. `placeable`
  capability has maxRange/snapStep but snapStep is only used as physgun
  grid default, no placement ghost.
- Missing: ghost/preview before drop, surface/socket snapping, placement
  validity display. Server-side placement validation of the final pose
  happens implicitly via drop+freeze (zone checks on freeze/physgun).

### Items
- **Implemented, unified ItemDef with capability blocks:** world, food,
  seed, planter, shop, door, container, weapon (melee), placeable,
  workstation, tool (physgun/axe/pickaxe/hammer enum). 28 items.
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

| Gate | Result |
| --- | --- |
| pnpm typecheck | clean |
| pnpm lint | clean |
| pnpm test | 47 files, 634 tests, all pass |
| pnpm build | clean (client bundle 285 kB main + 2 MB babylon chunk) |
| pnpm format:check | clean |
| sliceTest.ts | pass (all phases incl. restart persistence) |
| audit:editor / test:editor | run at editor-touching changes |

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
