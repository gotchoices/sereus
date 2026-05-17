---
description: End-to-end integration tests covering SeedBootstrapService.authorizePeer/removePeer round-trip and the full TrustCircleService issue → redeem → list → remove cycle against a real CadreNode.
files: packages/cadre-core/test/seed-bootstrap.spec.ts, packages/cadre-host/src/auth/__tests__/trust-circle-integration.test.ts, packages/cadre-host/src/auth/trust-circle.ts, packages/cadre-core/src/seed-bootstrap.ts
---

## What landed

Two integration tests running against real `CadreNode` + Quereus control DB:

1. **`packages/cadre-core/test/seed-bootstrap.spec.ts`** —
   `describe('authorizePeer / removePeer — round-trip against a real control DB')`
   alongside the existing guard-rail-only `removePeer` tests. Boots a
   `CadreNode`, inserts the authority key, calls `node.authorizePeer(...)`,
   reads back via `inner.eval(...)`, calls `node.removePeer(...)`, asserts the
   row is gone. Validates the Quereus `delete from … with context` syntax
   against the `AuthorizedInsert` constraint, which signs over
   `digest(coalesce(new.PeerId, old.PeerId), 'sha256', 'utf8')`.

2. **`packages/cadre-host/src/auth/__tests__/trust-circle-integration.test.ts`** —
   one real host `CadreNode` wired into `TrustCircleService` + a `TrustCircleStore`
   on a `tmpdir`. Exercises `issueInvite → redeemInvite → list → removeMember`.
   The phone peerId is derived from a fresh Ed25519 key (no second libp2p node).
   Replaces the mock `CadreNodeLike` for the v1 surface; the mock-based tests in
   `trust-circle.test.ts` stay (they exercise atomic-claim and concurrent-redeem
   semantics far more cheaply than real node bring-up).

## Review findings

### What was checked
- Read the implement-stage diff (`a419c9c`, +205 LOC of tests) cold against
  `trust-circle.ts`, `seed-bootstrap.ts`, `trust-circle-store.ts`, and the
  CadreNode wrappers (`authorizePeer`, `removePeer`, `acceptPhone`,
  `createInvite`, `getControlDatabase`, `initializeSeedBootstrap`,
  `peerId` getter).
- Cross-checked the two new helpers (`readCadrePeer` in cadre-core,
  `isInCadrePeer` in cadre-host) for shape parity with
  `TrustCircleService.isMember` / `list()`.
- Confirmed the test's assertion that the host's own peerId does NOT appear
  in `CadrePeer` (no self-registration on `start()` — only `authorizePeer`
  inserts).
- Re-checked `acceptPhone`'s validation against the sparse reconstructed
  invite (`partyId: ''`, `authorityAddrs: []`) — cadre-core only cross-checks
  `token` and `expiresAt`, so the sparse shape is accepted today.
- Confirmed docs (`docs/cadre-host.md`, `docs/architecture.md`) already
  describe the invite/redeem/remove flow accurately; nothing required
  updating.
- Ran `yarn test` in both packages and `tsc -p tsconfig.build.json --noEmit`
  in both packages.

### What was found

**Minor (fixed inline)** — the trust-circle integration test brought up a
*second* full `CadreNode` ("phone") only to harvest a peerId, while the
sibling new test in `seed-bootstrap.spec.ts` already used the lightweight
`generateKeyPair('Ed25519')` + `peerIdFromPrivateKey` pattern. The
constraint only validates a signature over `digest(PeerId,…)` — peerId
*liveness* doesn't matter for the host-side CRUD path under test. Swapped
the integration test to the cheap pattern:
- Removed `phone` `CadreNode` construction, `await phone.start()`, and the
  `phone.stop()` teardown leg.
- Pulled `phonePeerId` from a fresh Ed25519 key inside the test.
- Brought the two new integration tests stylistically in line.
- Trust-circle integration test went from ~360 ms → ~288 ms and dropped a
  needless second libp2p stack (one fewer port-allocation race in CI).

**No major findings** — no new fix/plan tickets spawned.

**SPP / DRY / modularity / scalability / performance / resource cleanup /
error handling / type safety:** clean. The two `*CadrePeer` query helpers
duplicate ~5 LOC across package boundaries; not worth a shared test util
since they're at different layers (cadre-core has no dep on cadre-host,
and pulling either into runtime code would expand surface area for a test
concern).

**Coverage:** happy path covered end-to-end. Error paths
(`already_redeemed`, expired token, concurrent redeem of same token,
re-redeem) remain on the mock-based `trust-circle.test.ts` — appropriate;
those don't benefit from real-node bring-up and the implementer's gap
acknowledgment is honest about it. Re-authorize-then-delete is not
exercised in integration, but the `AuthorizedInsert` constraint accepting
re-insert is unchanged by this ticket and covered by mock-DB unit tests.

**Docs:** `docs/cadre-host.md:88` already describes the redeem-via-
`acceptPhone` flow that the integration test now validates. Architecture
doc reference is also current. No doc edits needed.

### Validation

- `packages/cadre-core` — `yarn test`: **133/133 passed**. New
  round-trip test runs at ~262 ms.
- `packages/cadre-host` — `yarn test`: **150 passed / 2 skipped / 152
  total**. Integration test runs at ~288 ms after the simplification.
- `packages/cadre-core` — `tsc -p tsconfig.build.json --noEmit`: clean.
- `packages/cadre-host` — `tsc -p tsconfig.build.json --noEmit`: clean.
