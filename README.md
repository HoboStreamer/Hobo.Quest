# Hobo.Quest

A persistent multiplayer physics sandbox for the browser: Source-style movement,
physgun-driven building from crafted physical objects, gathering, crafting, and
extraction risk — running against an authoritative dedicated server.

**Stack:** TypeScript everywhere · Babylon.js (WebGPU with WebGL fallback) ·
Havok physics (Babylon Physics V2, headless on the server via NullEngine) ·
WebSocket protocol · SQLite persistence · pnpm monorepo.

## Repository layout

```
apps/
  client/        Browser client: rendering, prediction, input, HUD
  server/        Dedicated authoritative server: simulation, networking, persistence
packages/
  shared/        Math, ids, events, logging facade, fixed-timestep primitives
  protocol/      Versioned wire messages + codec (zod-validated inbound)
  content/       Data-driven item/recipe/world definitions + validation registry
  gameplay/      Pure domain logic: inventory, crafting, movement sim, zones, entities
  physics/       PhysicsWorld abstraction + Havok adapter (@hobo/physics/havok)
  persistence/   DTOs, repository interfaces, SQLite implementation
docs/adr/        Architecture decision records
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for boundaries and data flow,
[ROADMAP.md](ROADMAP.md) for what exists and what is planned.

## Prerequisites

- Node.js >= 22
- pnpm 10 (`corepack enable`)

## Development

```bash
pnpm install

# Terminal 1 — authoritative server on :8000 (tsx watch)
pnpm dev:server

# Terminal 2 — client with hot reload on :5173 (proxies /ws to :8000)
pnpm dev:client
```

Open http://localhost:5173 in two browser windows to see multiplayer.

**Controls:** WASD move · Space jump (hold to bunnyhop) · Shift sprint ·
1-6 hotbar · Tab menu (inventory / crafting / skills / players) · G drop
held item · E gather / pick up props.
**Physgun (GMod-style):** hold LMB grab (grabbing a frozen prop unfreezes
it) · release to let go · RMB freeze · wheel push/pull · hold E rotate
like a globe (Shift+E snaps) · hold Shift for grid-lock.
**Building:** craft pieces → drop them (G or drag out of the inventory) →
position with the physgun → freeze. Dropping IS placement; E picks any
prop back up into your inventory.

**The loop:** spawn in Hoboville (safe city — no PvP, no building, no
physgun), gather branches/stones/scrap outside the gates, craft tools,
harvest the forest (axe/woodcutting) and quarry (pickaxe/mining), craft
building pieces, place them in the wilds, position with the physgun and
freeze. Props are protected: only you and players you trust can move them.

## Commands

| Command                                 | Purpose                                                                                                      |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `pnpm dev`                              | Server + client dev processes in parallel                                                                    |
| `pnpm test`                             | All unit tests (vitest)                                                                                      |
| `pnpm typecheck`                        | Strict TypeScript across every package                                                                       |
| `pnpm lint`                             | ESLint (typescript-eslint, no-explicit-any)                                                                  |
| `pnpm format`                           | Prettier write                                                                                               |
| `pnpm build`                            | Production build of all packages + client bundle                                                             |
| `tsx apps/server/scripts/sliceTest.ts`  | End-to-end vertical-slice test (boots a real server, drives protocol clients, restarts, asserts persistence) |
| `tsx packages/physics/scripts/smoke.ts` | Headless Havok smoke test                                                                                    |

## Production

```bash
pnpm build
STATIC_DIR=apps/client/dist PORT=8000 DB_PATH=data/world.db pnpm --filter @hobo/server start
```

The server serves the built client, `/healthz`, `/metrics`, and the game
WebSocket on one port. Environment: `PORT`, `HOST`, `DB_PATH`, `STATIC_DIR`,
`MAX_PLAYERS`, `LOG_LEVEL`.

Deployed at https://hobo.quest (nginx TLS termination → server on :8000,
systemd unit `hoboquest.service`).
