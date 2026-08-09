# Roadmap

## Phase 0 — Vertical slice ✅ (current)

Proves every major system cooperates end-to-end (verified by
`apps/server/scripts/sliceTest.ts` on every change):

- [x] Browser client connects to a dedicated authoritative server
- [x] Babylon rendering (WebGPU/WebGL) of a test world from shared content defs
- [x] Source-style kinematic movement (accel/air-strafe/friction/step-up),
      fixed timestep, client prediction + server reconciliation
- [x] Multiple clients see each other (interest-managed replication)
- [x] Havok props with sleep-aware snapshotting
- [x] Gathering from resource nodes (range-validated)
- [x] Inventory (stacks, moves, splits) + hotbar, server-authoritative
- [x] Data-driven crafting with craft time + workstation gating
- [x] Crafted placeable props: inventory item → validated placement → physics entity
- [x] Physgun: grab / drag / rotate / push-pull / freeze / unfreeze
- [x] Persistence: world entities + players survive server restart
- [x] Zone rule system (safe-pad test zone)
- [x] Structured logs, /metrics, /healthz

## Phase 1 — Sandbox depth

- Constraint system: weld, rope, hinge, slider as data-described constraints
  between physgun-compatible entities (protocol + persistence for constraint
  graphs; physics islands sleep as units)
- Container entities (crate inventory), item dropping/world pickup
- Placement ghost preview + surface snapping improvements
- Prop health/damage; harvesting tools with efficiency
- Binary snapshot codec + delta compression once bandwidth measurements demand

## Phase 2 — World & survival

- Larger streamed world: server-side region partitioning behind the existing
  interest-query seam; client chunk streaming; per-region persistence loading
- Survival stats (hunger/thirst/temperature) as components + status effects
- Farming: planters, growth via timestamp state transitions (no per-tick sim)
- Day/night + environment
- Safe city zone content: shops, storage, social hub (zone rules already exist)

## Phase 3 — Economy & NPCs

- NPC framework: perception, behavior modules, simulation LOD (nearby = full
  AI, distant = abstract state)
- Merchants/dealers, reputation, underground production chains (generic
  production/market systems — no hardcoded product)
- Currency + trading, transactional inventory operations

## Phase 4 — Extraction & progression

- Extraction events as reusable world events (window, capacity, contest, risk)
- Skills: XP from gameplay, levels unlocking recipes/interactions
- High-value dangerous regions, loot tables

## Phase 5 — Scale

- Real auth (replace localStorage token; hobo.tools SSO is a candidate)
- Workers for pathfinding/persistence batching; multi-region sharding options
- Vehicles built from components on the constraint system

## Standing engineering rules

- The slice test must stay green; new systems extend it
- Content changes never require engine changes
- No system may read another's internals — protocol/events/repositories only
