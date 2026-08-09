# ADR-0004: Interim identity = client-generated persistent token

**Status:** accepted (explicitly temporary) · **Date:** 2026-08-09

## Decision

Clients generate a random token once, store it in localStorage, and present
it in `hello`. The server maps token → player row; one live session per
token. This is the identity boundary — all persistence keys off the server's
player id, never the token's semantics.

## Why

Real auth (accounts, or hobo.tools SSO) is orthogonal to proving the
gameplay/persistence loop and would have blocked the slice. The token flows
through the exact seam where a session credential will later be validated, so
replacing it touches `handleHello` and the client connect call only.

## Consequences

- Tokens are bearer credentials with no recovery; acceptable for a dev/test
  world, unacceptable for launch. Replace before any real economy exists.
