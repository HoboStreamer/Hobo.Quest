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
LMB hold physgun grab · mouse wheel push/pull · R+mouse rotate held ·
F freeze · Q unfreeze · E gather · X place selected item · 1-6 hotbar ·
Tab inventory · C crafting.

## Commands

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Server + client dev processes in parallel |
| `pnpm test` | All unit tests (vitest) |
| `pnpm typecheck` | Strict TypeScript across every package |
| `pnpm lint` | ESLint (typescript-eslint, no-explicit-any) |
| `pnpm format` | Prettier write |
| `pnpm build` | Production build of all packages + client bundle |
| `tsx apps/server/scripts/sliceTest.ts` | End-to-end vertical-slice test (boots a real server, drives protocol clients, restarts, asserts persistence) |
| `tsx packages/physics/scripts/smoke.ts` | Headless Havok smoke test |

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
