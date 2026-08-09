# Architecture

## Principles

1. **The server is the game.** Clients render, predict, and express intent;
   every gameplay-relevant decision (movement, inventory, crafting, placement,
   physgun, damage, economy) is validated or simulated server-side. No client
   field is ever trusted.
2. **Domain logic is engine-free.** `@hobo/gameplay` has no Babylon, Havok,
   DOM, or network imports; it runs identically in vitest, on the server, and
   inside client prediction. Engines live behind adapters.
3. **Data-driven content.** Items, recipes, and worlds are declarative
   definitions validated at startup (`@hobo/content`). Adding content never
   requires engine changes. Stable ids everywhere; display names are cosmetic.
4. **Persistent state is explicit.** DTOs in `@hobo/persistence` are the disk
   format. Runtime objects (meshes, bodies, live inventories) are transient
   projections rebuilt from them.
5. **Sleep is a first-class citizen.** Settled physics objects cost nothing on
   the wire (excluded from snapshots) and nothing per-tick; they exist as
   pinned state until something wakes them.

## Package dependency graph

```
          shared
         /  |   \
  protocol content physics ──(havok adapter: @babylonjs/core + havok wasm)
         \  |  /
        gameplay
            |
       persistence (DTOs; sqlite impl behind repository interfaces)
            |
   apps/server        apps/client
   (authoritative)    (Babylon render + prediction + HUD)
```

Only `apps/*` and `packages/physics`'s adapter know Babylon exists. Only
`apps/server` and `packages/persistence` know SQLite exists. `packages/*`
never import browser-only APIs (the physics adapter's NullEngine path is
Node-safe; the client hands it a rendered scene instead).

## Simulation model

- Fixed 30 Hz tick on the server (`FixedTimestep` also drives client
  prediction). Snapshots at 15 Hz. Rendering is decoupled and interpolated.
- **Movement** is a kinematic Source/Quake controller (`gameplay/movement`):
  explicit velocity + capsule sweeps + clip-plane sliding + step-up, with
  friction / ground-accelerate / air-accelerate (air-strafing works). The
  player is _not_ a dynamic rigid body; a kinematic Havok capsule mirrors the
  player so props collide with them. The controller consumes a
  `CollisionQueries` interface — the Havok adapter provides it on both sides,
  the tests provide analytic worlds.
- **Client prediction:** every input command (seq-stamped) is sent and applied
  locally; snapshots carry the last processed seq; the client rewinds to the
  authoritative state and replays unacked inputs. Remote entities render from
  ~130 ms interpolation buffers.
- **Physics:** Havok via Babylon Physics V2 behind `PhysicsWorld`
  (`@hobo/physics`). Stepping is always manual (`executeStep`) from the fixed
  loop — never coupled to render frames. Collision layers: Static / Prop /
  Player, filtered at the shape level for rays and sweeps.

## Networking

- Explicit protocol package with a version constant; inbound messages are
  zod-validated (range-clamped axes, size caps) and malformed traffic
  disconnects. JSON encoding today behind an encode/decode boundary sized for
  a binary codec swap.
- **Interest management:** per-session known-entity sets built from a radius
  query (the query is one function — the future spatial region index replaces
  its internals, not its callers). Spawn/despawn diffs flow from interest
  changes; snapshots contain only relevant players + _awake_ relevant bodies.
- **Sleep networking:** when a prop settles, one final `entity` pin is
  broadcast and it drops out of snapshots; on wake it re-enters. Settled
  props also mark themselves dirty exactly once for the persistence flush.
- Wire-level rate limiting (messages/sec, payload bytes) plus a bounded input
  queue per session (max 2 catch-up sims/tick) prevent client-driven speedup.

## Server systems (per tick)

1. Drain input queues → movement simulation per session (never client
   positions; silent clients coast to a stop after 3 bridged ticks)
2. Physgun drive: held bodies pulled toward the holder's view ray via
   velocity control (never teleported) with proportional angular control
3. `physics.step(dt)`
4. Sync awake prop transforms into entity records; settle/wake transitions
5. Crafting queues (tick-based completion, output-space aware)
6. Replication (every 2nd tick): interest diff + snapshot per session
7. Periodic batched persistence flush (dirty entities + dirty players)

## Persistence

SQLite (WAL) behind `PersistenceStore` repositories: `world_entities`
(props/resources with motion + kind-specific state JSON), `players` (token,
transform, inventory JSON), `meta` (schema version, world-seeded flag).
Dirty tracking batches writes; flush on interval, on settle, and on shutdown.
First boot seeds from the world definition; afterwards the DB is the world's
source of truth.

## Zones

Declarative rule volumes (`pvp`, `build`, `physgun`) resolved by position;
systems ask `rulesAt(pos)` — the protected city is future _content_, not code.

## Entities

`GameEntity` is a small record with optional capability components (prop,
resource, owner, …) in an `EntityStore` with kind indexes. Deliberately not a
full archetype ECS yet: systems only touch query methods, so storage can be
migrated if profiling demands it. The same composition philosophy governs item
definitions (`world`, `placeable`, `workstation` capability blocks).

## Observability

`ServerMetrics` sampled by the tick loop (tick/physics ms EMA, awake/settled
bodies, sessions, bytes out, snapshot size, RSS), exposed at `/metrics`,
summarized to structured JSON logs periodically. Logs carry system/player/
entity context fields and never spam per-tick.

## Security posture

Assume hostile clients: protocol validation at the edge, range checks on every
interaction (gather, place, physgun grab/unfreeze), zone rules, ownership
recorded on placement, inventory ops validated against authoritative state,
one live session per identity token. Client-side rays exist purely for UX.
