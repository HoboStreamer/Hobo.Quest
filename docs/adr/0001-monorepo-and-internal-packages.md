# ADR-0001: pnpm monorepo with source-exporting internal packages

**Status:** accepted · **Date:** 2026-08-09

## Decision

One pnpm workspace. Internal packages export TypeScript source directly
(`"exports": "./src/index.ts"`); consumers (vite, tsx, vitest) compile on the
fly. `tsc --build` with project references provides the strict typecheck gate;
the client bundles through vite, the server runs tsx (bundle-able via esbuild).

## Why

Dual-build packages (emit dist + watch) add a build-orchestration layer that
slows iteration and drifts. Source exports keep stack traces, go-to-def, and
hot reload exact, while `pnpm typecheck` keeps the same strictness a compiled
setup would. If we ever publish packages externally, adding a build step to a
package is local and mechanical.

## Consequences

- Every consumer must handle TS (all ours do).
- Server production deploys either run tsx (accepted for now) or use the
  esbuild `bundle` script.
