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
                 STAGE 3 (item/container/survival depth):
                 - container domain module in @hobo/gameplay (add/take/
                   move/split/sort/canFit/transfer on the shared slot-array
                   shape) — gameServer refactored onto it; container_move
                   gains count (split), new container_sort; client Sort
                   button + right-click-half in the storage panel
                 - server-authoritative environment (@hobo/gameplay
                   environment): 20-min day clock + markov weather
                   (clear/cloudy/rain/storm/fog) + ambient temperature
                   curve; persisted in meta (env_time/env_weather);
                   time message now carries weather; broadcast on change
                 - survival v2: bodyTemp (drift bands from EFFECTIVE temp =
                   ambient + campfire heat − wetness), timed status-effect
                   framework (wet/cold/freezing/overheated/well_fed/
                   bleeding) with structural consequences (stamina regen,
                   thirst rate, hp drain, regen boost); eat() big meals
                   apply well_fed; normalizeStats migrates old saves
                 - stats message carries temp + statuses; HUD shows temp +
                   status chips; weather renders as light dim + fog haze +
                   cloud thickening (underwater fog still wins)
                 - physics fix: rope/spring collision flag; a rigid joint
                   on the same pair turns soft-joint collision off
                   (mixed flags on overlapped bodies exploded on cut)
Tests:           669 unit tests pass (+8 containers, +4 environment, +8
                 survival); constraintSmoke OK; sliceTest extended:
                 temp/status/weather replication, container sort + split,
                 rigging explosion regression — all green; audit:editor OK
Remaining:       Stages 4-13 (see ROADMAP.md)
Next exact step: Stage 4 — data-driven crops (several, stages/water/
                 regrow), farming props + logical water, machine
                 production (inputs→time→outputs), power/fuel foundations
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
  kind indexes, plus ONE shared SpatialHash (16 m) for all proximity
  queries and a RegionTracker (32 m) for activation.
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

- **Implemented (Stage 3).** Shared container domain in @hobo/gameplay
  (containerAdd/Take/Move/Sort/CanFit/Count/Transfer on the slot-array
  shape) used by storage boxes, supply crates and — coming — machine
  inputs/outputs, vehicle trunks, merchant stock. Server ops: open/move
  (with split count)/sort, range + trust validated, live-pushed to every
  viewer. Client: click to move, right-click for half, Sort button.
- container-to-container transfer exists in the domain (containerTransfer)
  and gets its first server consumer with machines (Stage 4).

### Crafting / workstations

- **Implemented.** 19 recipes, categories, craft-time queue (4 jobs),
  workstation gating (workbench, campfire), skill gating, output-space
  aware, XP on completion. Nearby-workstation scan is O(props) per craft.

### Gathering

- **Implemented.** 6 node types, tool gating with bare-hand fallback,
  yield/power, respawn timers, felled-tree physical trunk spawn, XP.

### Survival

- **Implemented (Stage 3 depth).** Health/hunger/thirst/stamina + body
  temperature with legible bands: EFFECTIVE temp = ambient (day curve +
  weather) + campfire warmth − wetness; below 2°C effective the body
  chills → cold (half stamina regen) → freezing (hp drain); above 32°C it
  overheats (thirst ×2.5). Timed status framework (wet/cold/freezing/
  overheated/well_fed/bleeding) with per-status dps + structural rules;
  big meals apply well_fed (regen boost). Old saves normalized.
- Death → city respawn keeping inventory (extraction stage will formalize
  at-risk vs secured semantics). No rest mechanic yet; no clothing
  insulation yet (armor/equipment arrives Stage 5).

### Farming

- **Implemented (Stage 4).** Data-driven CropDefs (5 materially different
  crops: regrowing berries, drought-proof mudroot, thirsty mill-bound
  ration wheat, fiber wirevine for rope, warmth-hungry high-value ember
  pepper) with growSeconds/stages/waterUse/temperature band/yield/regrow/
  farming-level gates. PlantState is timestamp-lazy (progress/water/boost/
  updatedAt advanced in closed form on touch + a 15 s sweep) — plants
  never tick. Rain waters everything; watering cans (fluidContainer meta)
  fill from world water or tanks; fertilizer boosts once per growth;
  sprinklers water planters from nearby tanks; tanks catch rain.
  Legacy {seedId, plantedAt} plants migrate on restore.
- Wire: plant {crop, t, water}; client renders stage scale + crop color +
  thirsty tint; prompts cover water/fertilize/harvest/thirsty.

### Machines / utilities

- **Implemented (Stage 4).** Machine item capability (kind, input/output
  zones, needsPower) over the shared container; machine recipes
  (recipe.machine) auto-process unattended with timestamp jobs (park when
  output is full — never destroy). Sawmill (powered, logs→lumber) and
  hand grain mill (wheat→flour→campfire flatbread). Power: scrap
  generator burns fuel items (wood) from its hopper and powers a radius;
  proximity IS the connection (explicit cables can come with vehicles).
  Water: tanks + sprinklers as above. Machines/tanks with content refuse
  pickup. All persisted (machine job, burnUntil, waterAmount).
- Not yet: machine job progress UI; conveyors; power storage.

### Combat

- **Implemented (Stage 5 foundation).** Generic damage pipeline: typed
  DamageEvents (blunt/cutting/projectile/explosive/environment/fall) flow
  through one damagePlayer sink — armor mitigation with durability wear,
  bleeding on big cutting/projectile wounds (status framework), death
  handling, hit feedback. Melee (any held item; axes cut) and ranged fire
  both converge there; props take typed damage via applyPropDamage.
- Ranged: rangedWeapon capability (damage/range/cadence/spread/ammo/
  magazine/reload); scrap_pistol + pistol_round content. Client sends pure
  fire INTENT; the server shoots from the authoritative eye along the
  authoritative view + server-rolled spread, validates magazine/cadence/
  reload state (stack meta) and shooter zone; victims are zone-checked
  too. Tracers broadcast for visuals; R reloads from inventory ammo.
- Armor: one worn slot (padded_jacket), equip/unequip messages, durability
  in stack meta, breaks at zero. Medical: bandage (heals + cures
  bleeding) via the consume path. Both persisted (players.armor, v9).
- Not yet: projectile ballistics (hitscan only), headshot zones, more
  weapons, explosive damage sources. Slice covers denial paths + bandage;
  live pistol fire is unit-tested (fire control) — a full e2e shot needs
  a cheaper weapon source in the fixture (noted).

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

- **NPCs implemented (Stage 7).** Data-driven archetypes (rustjaw_thug,
  city_warden, townsfolk, dust_hare) composed from profile fields —
  faction, vitals, perception (view/FOV/hearing), behavior (aggression/
  flees/wanders/leash/attack), loot, respawn. Pure gameplay domain:
  perceive() (distance+FOV+injected LOS+hearing) and stepBehavior()
  (idle/wander/chase/attack/flee/return, deterministic, unit-tested).
- Server NpcManager with explicit LOD: FULL (active region — perception at
  5 Hz staggered, terrain-following kinematic movement every tick, physics
  capsule, normal replication) vs ABSTRACT (a record: pos/health/respawn;
  zero per-tick cost). Materialization follows RegionTracker activation;
  the abstract record IS the persisted state (world_entities kind 'npc').
- NavigationService boundary (StraightLineNavigation v1; invalidation
  seam documented for player construction).
- Combat integration: NPC melee flows through damagePlayer; player melee/
  bullets damage NPCs; deaths scatter loot-table rolls as physical props;
  gunshots are heard (sound events). Aggro: damaging any NPC marks the
  player hostile to DEFENSIVE archetypes (wardens) for 45 s. Factions are
  content (playerStance) — bandit hostility is data, not code.
- Client: placeholder tinted body+head visuals, aim/attack targeting,
  prompts with faction warning, snapshot-interpolated movement.
- Missing: faction↔faction relations + reputation shifting stances
  (Stage 8), merchant/job NPCs (Stage 8/10), real navmesh.

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

- **Foundation implemented (Stage 6).** One shared `SpatialHash` (16 m
  cells) over every entity, maintained by GameWorld (props/resources) and
  the server (players): replication interest, workstation/shop lookups
  and sprinkler coupling all query it — no consumer walks all entities by
  distance anymore. `RegionTracker` (32 m regions) recomputes activation
  (player ±1 ring) at 1 Hz with metrics (activeRegions/occupiedRegions);
  `regions.isActive(x, z)` is the seam NPC LOD and event relevance hang
  off in Stage 7/9. Deactivation unloads nothing (persistence-safe).

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

- **Implemented (Stage 3).** Server-authoritative EnvironmentState:
  20-min day cycle + weighted-transition weather spells (clear/cloudy/
  rain/storm/fog), ambient temperature curve consumed by survival (and by
  farming moisture in Stage 4). Persisted in meta; time message carries
  weather; client renders light dim, fog haze, cloud thickening.

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
