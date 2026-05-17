---
description: Review the two new end-to-end integration tests covering SeedBootstrapService.authorizePeer/removePeer round-trip and the full TrustCircleService issue → redeem → list → remove cycle against a real CadreNode.
files: packages/cadre-core/test/seed-bootstrap.spec.ts, packages/cadre-host/src/auth/__tests__/trust-circle-integration.test.ts, packages/cadre-host/src/auth/trust-circle.ts, packages/cadre-core/src/seed-bootstrap.ts
---

## What landed

Two integration tests, both running against real `CadreNode` instances with a live Quereus control DB:

1. **`packages/cadre-core/test/seed-bootstrap.spec.ts`** — new
   `describe('authorizePeer / removePeer — round-trip against a real control DB', …)`
   block at lines 593–643, alongside the existing guard-rail-only `removePeer`
   tests. Boots a `CadreNode`, inserts the authority key, calls
   `node.authorizePeer(...)`, reads `CadreControl.CadrePeer` directly via
   `inner.eval(...)`, calls `node.removePeer(...)`, and asserts the row is
   gone.

   Purpose: end-to-end validation that the Quereus DELETE-with-context syntax
   in `SeedBootstrapService.removePeer` actually works against the
   `AuthorizedInsert` constraint, which signs over
   `digest(coalesce(new.PeerId, old.PeerId), 'sha256', 'utf8')`.

2. **`packages/cadre-host/src/auth/__tests__/trust-circle-integration.test.ts`** —
   new file (130 LOC). Spins up two real `CadreNode`s (host + phone) with
   disjoint partyIds and no bootstrap nodes, wires the host into
   `TrustCircleService` with a `TrustCircleStore` on a `tmpdir`, then runs:
     - `issueInvite({ label: "Mom's phone" })`
     - `redeemInvite({ token, peerId: phonePeerId })`
     - direct `CadrePeer` read via `db.eval` to confirm the row
     - `service.list()` returns one labelled member, zero pending
     - `service.removeMember(phonePeerId)` removes the `CadrePeer` row and
       the local label
     - `list()` reflects the removal.

   This replaces the mock `CadreNodeLike` for the v1 surface. The mocked
   tests in `trust-circle.test.ts` stay — they exercise atomic-claim and
   concurrent-redeem semantics far more cheaply than real node bring-up.

## Use cases / things to spot-check

- **Sparse invite reconstruction.** `TrustCircleService.redeemInvite` rebuilds
  a sparse `CadreInvite` (`partyId: ''`, `authorityAddrs: []`) before passing
  it to `CadreNode.acceptPhone`. The integration test confirms cadre-core
  accepts this shape today (`acceptPhone` does not cross-check `partyId` or
  `authorityAddrs` against the invite — only token+expiry). If a reviewer
  thinks cadre-core *should* validate `partyId` against the host's party at
  redemption, that would be a separate fix ticket (the test would still pass
  today; it would only start failing once cadre-core enforces it).

- **DELETE-with-context signature pattern.** The constraint signs over
  `digest(coalesce(new.PeerId, old.PeerId), 'sha256', 'utf8')`, so the
  signature payload for delete is the same string as for insert. Worth a
  second look at `packages/cadre-core/src/seed-bootstrap.ts` (the
  `removePeer` implementation) to confirm that's actually what the code
  passes — the round-trip test only proves the constraint accepts whatever
  the code happens to compute, not that it's signing the right thing in
  general (e.g. if PeerId were ever passed empty, the round-trip would still
  pass).

- **No cross-node libp2p.** Each test brings up its nodes with empty
  `bootstrapNodes` and disjoint partyIds; the phone node is used only for
  its peerId. Cross-node dial/connection is out of scope for the redemption
  cycle (that's `cadre-host-over-P2P`). Reviewer should confirm this matches
  the parent fix ticket's intent.

- **Cleanup discipline.** `afterEach` swallows `stop()` errors with
  `try/catch — /* ignore */`. That's appropriate for teardown of two
  independently-startable nodes, but worth confirming the rest of the suite
  follows the same pattern (it does — see existing `cadre-node.spec.ts`).

## Known gaps / honest flags

- The integration test asserts `list()` returns one member with the expected
  label, but does not exercise multiple members, mixed pending/active, or
  re-redeem of the same token. Those paths are still covered by the mocked
  `trust-circle.test.ts` and `trust-circle-store.test.ts`. If the reviewer
  feels real-node coverage of those branches is worth the ~250 ms each, that
  would be a follow-up ticket rather than a blocker.

- The `seed-bootstrap.spec.ts` round-trip uses a single peerId / single
  multiaddr. The constraint signs over PeerId only (not the multiaddr list),
  so this is sufficient to validate the delete signature path; multi-addr
  inserts are already covered by the mock-DB unit tests above.

- I did not exercise re-authorize of an already-authorized peer in the
  integration tests (insert→insert→delete), only insert→delete. The
  `AuthorizedInsert` constraint accepting a re-insert is not changed by
  this ticket, but if there's any doubt the reviewer can add a second
  `authorizePeer` call between the two existing calls and assert the row
  Multiaddr updates accordingly.

## Validation run

- `packages/cadre-core` — `yarn test`: **133/133 passed**; new
  `seed-bootstrap.spec.ts` describe runs at ~262 ms total for the 35 tests.
- `packages/cadre-host` — `yarn test`: **150 passed / 2 skipped / 152
  total**; new `trust-circle-integration.test.ts` runs at ~252 ms.
- `packages/cadre-core` — `yarn build` (`tsc -p tsconfig.build.json`):
  clean.
- `packages/cadre-host` — `yarn build` (`tsc -p tsconfig.build.json`):
  clean.

## End
