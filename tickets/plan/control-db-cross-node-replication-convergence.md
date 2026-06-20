description: Cross-node control-DB reads do not converge in practice — a `CadrePeer`/membership row written (authority-signed) on one cadre node is never observed by another node, even over a live control-network connection. Multiple parts of the design assume the `CadreControl` tables are a *replicated* store (peer-record resolution calls `CadrePeer` "replicated"; push-wake authorization relies on the receiver reading the shared control DB to know the sender is a member). Pin down whether control-DB replication is *meant* to work P2P over the control network, and if so, what is missing.
prereq:
files: packages/cadre-core/src/control-database.ts, packages/cadre-core/src/cadre-node.ts (registerSelf/listMembers/isMember/resolvePeerAddrs), packages/cadre-core/src/seed-bootstrap.ts, packages/integration-tests/src/harness/test-network.ts (waitForControlSync — documents the "authority-only convergence" caveat), packages/integration-tests/src/scenarios/strand-formation-e2e.integration.ts (header: "control-network cohort discovery is TODO"), packages/integration-tests/src/scenarios/push-wake-e2e.integration.ts (works around this with local seeding)
difficulty: hard
----

## Problem

The `CadreControl` control DB uses a *network* transactor (`control-database.ts`), and
several layers of the design treat it as a **replicated, eventually-consistent store**
shared by all of a party's cadre nodes:

- `peer-record-resolution-layer` (and `fret-backed-peer-record-liveness`) describe
  `CadrePeer` as "durable, authority-signed, and **replicated**", with FRET framed as an
  *optional* freshness layer "without waiting on control-DB convergence" — i.e. control-DB
  convergence is the assumed baseline.
- **Push-wake authorization** (`StrandWakeService.processWakeRequest` →
  `CadreNode.isMember` → `listMembers` → `queryCadrePeers`) gates an inbound wake on the
  receiver finding the *sender's* `CadrePeer` row in the receiver's control DB. In
  production this row is written on the authority/sender node and must replicate to the
  receiver for the gate to pass.

**But cross-node control reads do not converge in the integration harness.** A diagnostic
during `push-wake-two-node-integration-test` (two control nodes, a live control connection)
showed the receiver never observed the server's `CadrePeer` row even after 24s. This is
consistent with:

- the `strand-formation-e2e.integration.ts` header note that "control-network cohort
  discovery is intentionally not exercised … each node keeps an independent local transactor
  that never replicates", and
- the `waitForControlSync` "authority-only convergence scope" caveat documented in
  `integration-tests-real-control-sync-and-scenario-honesty` (the honest-scenarios pass
  scoped every control assertion to the *authority's own* DB precisely because cross-node
  convergence isn't proven).

Because of this, `push-wake-e2e.integration.ts` had to make **each node its own control
authority** and **seed the membership facts locally** (the dialer seeds the target's
self-signed record so `resolvePeerAddrs` passes; the receiver `authorizePeer()`s the sender
so `isMember` is true). That keeps the wake *wire path* fully under test, but it means the
three scenarios **do not prove control-DB replication** — the production path where the
receiver learns the sender is a member by reading the shared control DB is unexercised.

## Why this matters (the design question to settle)

If cross-node control replication is **supposed** to work P2P over the control network, then
this is a **latent correctness gap in production push-wake authorization** (and in any other
feature that reads a sibling-written control row): a genuinely-NAT'd/hibernating receiver
that only ever connected to the control network may never replicate the authority's
`CadrePeer`/membership rows, and would then reject legitimate wakes (or, conversely, the
whole `isMember` gate would be a no-op against an empty local table).

If instead control-DB convergence is expected to require real bootstrap/relay infrastructure
+ time that the harness deliberately does not provide, then the layered "replicated" language
in the peer-record tickets and `docs/architecture.md` should be corrected, and the
membership/authorization model should document that a receiver must obtain membership facts by
some other channel (seed delivery? authority push? FRET?).

## What this ticket should produce

- A definitive answer: **is the `CadreControl` store meant to replicate P2P across a party's
  cadre nodes**, and through what mechanism (Optimystic cluster over the control collections +
  control-network peer discovery, seed-bootstrap fan-out, FRET, …)?
- If yes: identify what's missing for convergence (control-network cohort discovery / cluster
  formation for the control collections) and spawn the fix/plan work — likely related to but
  distinct from the strand-side `strand-cohort-seed-uses-control-network-addresses` gap.
- If no: a doc/correctness pass so the authorization model and the "replicated" claims match
  reality, and a decision on how a receiver legitimately learns sender membership.
- A real two-node integration assertion that a control row written on node A becomes readable
  on node B (the thing `push-wake-e2e` had to stub out). The push-wake scenarios can then be
  upgraded to prove replication-backed authorization end-to-end.

## Notes

- Surfaced by review of `push-wake-two-node-integration-test`. Filed to backlog rather than
  fix/ because it needs a product/architecture decision before implementation, not a
  mechanical bug fix.
- Distinct from `strand-cohort-seed-uses-control-network-addresses` (that one is about
  *strand*-network address publication so a resumed strand can join its *strand* repo
  cluster). This ticket is about the **control** DB itself converging across nodes.
