# ADR-0002: Kinematic sweep-based player movement, not a dynamic body

**Status:** accepted · **Date:** 2026-08-09

## Decision

Player locomotion is an explicit Quake/Source-style simulation
(`@hobo/gameplay/movement`): integrate velocity, capsule-sweep the world,
clip velocity against contact planes, slide, step up. It consumes a
`CollisionQueries` interface; Havok only answers shape casts. A separate
kinematic (ANIMATED) Havok capsule mirrors the player so dynamic props react
to them.

## Why

- Game feel: friction/accelerate/air-control constants produce the intended
  movement identity; a dynamic capsule + forces never feels like Source.
- Determinism: pure function of (state, input, world) — mandatory for client
  prediction/reconciliation to work bit-identically on both sides.
- Testability: movement math is unit-tested against analytic worlds without
  wasm.

## Consequences

- Two representations of the player (move state + kinematic body) must be
  kept in sync (one line per tick).
- Player-vs-player collision is currently off (movement sweeps exclude the
  Player layer); revisit when it matters gameplay-wise.
