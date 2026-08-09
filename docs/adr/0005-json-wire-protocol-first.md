# ADR-0005: JSON wire encoding first, behind a codec boundary

**Status:** accepted · **Date:** 2026-08-09

## Decision

The protocol layer defines typed, versioned messages; encoding is JSON via
`encode*/decode*` functions. Inbound (client→server) messages are
zod-validated with range clamps; outbound are trusted by the client.

## Why

Snapshot payloads at slice scale are ~1 KB at 15 Hz per client — bandwidth is
not the current bottleneck, debuggability is. The message *model* (ids,
snapshots, deltas, acks) is the hard part and is already
transport-format-agnostic; a binary codec (flatbuffer-style or hand-rolled)
slots into the same two functions when measurements justify it.

## Consequences

- Bandwidth ceiling is lower than a binary protocol's; interest management
  and sleep-aware snapshots carry the scaling load until the codec swap.
- Never derive wire shapes from runtime classes; `wire.ts` DTOs are the only
  wire vocabulary.
