# Roadmap

Status legend: **done** = playable and tested, **partial** = real but
incomplete, **next** = current development target, **future** = not started.
A system is never "done" because a schema exists — it must have at least one
real playable vertical implementation.

See `docs/GAMEPLAY_DEVELOPMENT_STATUS.md` for the detailed per-system audit.

## Phase 0 — Vertical slice ✅ done

Proved every major system cooperates end-to-end (verified by
`apps/server/scripts/sliceTest.ts` on every change): authoritative server,
Babylon client (WebGPU/WebGL), Source-style predicted movement, interest-
managed replication, Havok props with sleep-aware snapshotting, gathering,
inventory, data-driven crafting, physgun building, persistence across
restart, zone rules, logs//metrics//healthz.

## Phase 0.5 — City, skills, tools, protection ✅ done

Hoboville safe city (map-authored, zone-enforced), tool capability system,
gathering professions with respawning typed nodes, 6 skills with XP/levels/
recipe gates, building content, prop protection with persistent trust,
weld constraint foundation (engine + persistence — no player-facing tool).

## Phase 0.75 — Survival & sandbox life ✅ done (was undocumented)

Shipped after 0.5, ahead of the old roadmap: hunger/thirst/stamina/health
vitals with eating/drinking, food items + campfire cooking, fall damage,
death/respawn; melee PvP with weapon capability, knockback, zone gating;
container props (storage box) with trusted access; hinged doors; planter
farming prototype (berry seeds, timestamp growth); merchant trades (bottle
caps); supply-drop crates (hardcoded event v1); day/night clock; guest IP
identity + hobo.tools SSO ranks; map editor as a mature authoring subsystem
with live world reconciliation.

## Phase 1 — Sandbox depth ✅ done (Stage 2)

- Player-facing constraint toolset on a clean ConstraintDefinition/Record/
  Service architecture: weld, rope, hinge, slider, spring, axis, motor
- Constraint visuals (endpoints, ropes), two-click tool UX, unweld/cut
- Constraint islands: settled structures sleep as units; island metrics
- Placement ghost preview + optional surface/grid snapping (free placement
  stays; modifier for precise unrestricted placement)
- Physgun precision polish (snap angles, translation snap)
- Prop health/damage/repair capability (melee + impact; zone-gated
  destruction; repair materials; destroy loot)
- Hostile-input tests for every new message

## Phase 2 — Item, container & survival depth ✅ done (Stage 3)

- Container domain module shared by boxes/machines/vehicles/merchants;
  quick transfer, split, sort; container-to-container
- Equipment slots + stack metadata (durability, instances) where gameplay
  needs it — no speculative fields
- Temperature (environment/wetness/shelter/clothing/heat sources) with
  understandable rules; generic timed status-effect framework
- Server-authoritative environment state: time of day, weather
  (clear/cloudy/rain/storm/fog), temperature — client renders, gameplay
  consumes

## Phase 3 — Farming, utilities & production ✅ done (Stage 4)

- Data-driven crop definitions (several materially different crops:
  stages, water/fertility needs, temperature ranges, regrow) — timestamp
  progression, never per-tick
- Irrigation/fertilizer/farm props via logical utility connections
- Generic utility networks: power (producer/consumer/storage), fuel
  (items), water (tanks/pipes/pumps) — cheap when sleeping
- Machine production chains: inputs → machine + time (+power/fuel/water/
  skill) → outputs; crop processing feeds the same crafting economy

## Phase 4 — Combat foundation ✅ done (Stage 5; hitscan pistol, armor, medical)

- Generic damage pipeline (source/target/type/amount/position/impulse);
  blunt/cutting/projectile/explosive/environment/fall types; zone gating
- Server-authoritative ranged weapons (fire intent → validate equipped/
  ammo/cadence/direction → server raycast); small test weapon set
- Armor/clothing damage reduction; bandage/medical consumables

## Phase 5 — Spatial world foundation ✅ done (Stage 6)

- Uniform spatial hash replacing the linear interest scan and prop
  proximity scans (workstations, shops); one index, many consumers
- Region/cell activation concept (players, active NPCs, awake physics per
  region) — the seam for simulation LOD and later streaming

## Phase 6 — NPCs ✅ done (Stage 7; straight-line nav v1)

- Server-authoritative NPC domain: composition capabilities (npc, health,
  inventory, faction, perception, combat, merchant, job) — no subclass
  towers
- Archetypes: civilian, city guard, merchant, bandit/scavenger, wildlife
  (content-defined loadout/behavior/loot/importance)
- NavigationService boundary (request path/waypoints/repath/invalidation)
- Modular perception: vision (distance/FOV/LOS), hearing (bounded sound
  events from gameplay), threat
- Behavior state modules (idle/wander/patrol/investigate/trade/guard/
  chase/attack/retreat/return) — deterministic/testable
- Simulation LOD tiers: full / simplified / abstract (no engine objects
  far from players); persistence of abstract state

## Phase 7 — Factions, reputation, economy ✅ done (Stage 8)

- Data-driven factions + relations; persistent player reputation with
  thresholds (stock, prices, jobs, access)
- Markets generalizing the fixed trade sheet (stock, restock, pricing,
  reputation requirements) behind a transactional economy API
- Production chains as player businesses, legal and underground, on the
  same machinery; player specialization emerges from skills/machines/
  geography — never class locks

## Phase 8 — World events & extraction ✅ done (Stage 9)

- Generic server-owned event engine (scheduled/announced/active/
  completed/cleanup); supply drops migrated onto it as proof
- Extraction events: countdown, capacity, in-zone validation, contest
  rules; explicit at-risk vs secured loot semantics owned by the server
- High-risk regions via zone/event rules (better loot, hostile NPCs,
  hazards)

## Phase 9 — Progression & jobs ✅ done (Stage 10)

- Skills unlock capabilities (constraint tools, machines, crops,
  components), not just recipes
- Blueprint/discovery: persistent unlock state fed by skill, merchants,
  jobs, found blueprints, dangerous regions, extraction, reputation
- Job/contract foundation (deliver/gather/transport/kill/repair/escort)
  with data-driven objectives and rewards

## Phase 10 — Vehicles ✅ done (Stage 11; scrap cart prototype)

- Modular vehicle prototype from the SAME item + physics + constraint
  architecture: chassis/wheels/suspension/engine/seat/storage/lights
- Assembly recognition + activation; server-authoritative driving; fuel;
  cargo containers; damage/repair; persistence + replication

## Phase 11 — Scale 🔜 next (Stage 12)

- Region persistence/streaming when the authored world justifies it
- Network measurement first (bytes/client, snapshot sizes, entity counts);
  binary snapshot codec only when measurements demand it
- Synthetic load tests: hundreds of sessions/props/constraints/NPCs —
  hunting algorithmic scaling problems, not benchmark vanity

## Phase 12 — Content & hardening (Stage 13)

- Interconnected content web (forest→sawmill→lumber; mine→forge→
  components; farm→processing→trade), geography with economic meaning
- Cross-system acceptance scenario (farm → process → haul → job → combat
  → extraction → sell → blueprint → restart-verified persistence)
- Hostile-client test sweep across every network action

## Standing engineering rules

- The slice test must stay green; new systems extend it
- Content changes never require engine changes
- No system may read another's internals — protocol/events/repositories only
- The map editor is load-bearing infrastructure: run `pnpm audit:editor`
  and `pnpm test:editor` when map/content schemas change
- Plants, machines and networks progress by timestamp/state transition,
  never per-tick simulation
- Every new network action ships with hostile-input tests
