description: A new networked test proves a node can learn who its fellow members are by syncing the shared membership database over the network — the real production path — and then wakes a sleeping peer, instead of being hand-fed those facts locally as the older tests do.
prereq: control-db-two-node-convergence-test, control-db-network-backed
files: packages/integration-tests/src/scenarios/push-wake-e2e.integration.ts (header rewrite ~18-78; new local `connectControlNodes` helper ~205-232; new scenario 4 ~439-564)
difficulty: medium
----

## What landed

Added **scenario 4 — "wakes a member whose authorization and address were learned by
control-DB replication, not local seeding"** to `push-wake-e2e.integration.ts`, alongside the
existing locally-seeded scenarios (which stay as fast wire-path coverage). It is the
replication-backed proof the ticket asked for: membership is written **only on an authority
node**, converges to the consulting nodes over the live control network, and the real wake then
passes its `isMember` / `resolvePeerAddrs` gates **via convergence, not local seeding**.

The file header was updated (the old "cross-node control reads do not converge" deviation is now
false — network-backing has landed); scenario 4 is listed and the locally-seeded scenarios are
described as the fast floor.

### Topology & flow (the proven-stable recipe)

Three nodes in one party: **A** (sole authority + storage), **S** (sender), **Rx** (hibernating
receiver). The design encodes three invariants that were each necessary to get a non-flaky test
against the real network-backed control DB:

1. **One writer, pure readers.** A is the *only* node that writes a row the assertions depend on:
   `A.authorizePeer(S)` (S's membership) and `seedReceiverRecord(A, Rx, …)` (Rx's full self-signed
   address record — one authority insert carrying Rx's own `Sig`). S and Rx never write a row the
   test waits on. This mirrors the single-writer/pure-reader split that makes the two-node
   convergence test clean. (An earlier design had Rx self-`UPDATE` its address; that edge-node
   write was the flaky step and was removed from the critical path.)
2. **Full mesh.** All three nodes are directly connected (`connectControlNodes` ×3, each link
   both-sides confirmed). A star (S→A, Rx→A only) left S↔Rx unlinked, and 3-member cluster commits
   that need those peers to reach each other reset streams they couldn't route — the ticket's
   "ensure all three are connected" precondition, learned the hard way.
3. **No addr-bearing non-self rows.** A and S use **ephemeral** libp2p identities (no `privateKey`)
   so they never self-publish a `CadrePeer` *address* row. This matters because the woken strand's
   `networked` resume seeds its cohort from every `CadrePeer` row with a dialable addr
   (`deriveCohortSeed` → `resumeStrandRuntime`); an authority/relay advertising a control addr is
   wrongly recruited into the strand cluster and fails strand-repo negotiation (the
   `control-network-cohort-discovery` gap). Keeping the only other member (S) addr-less makes Rx's
   resume stand up **networked-solo**, exactly like scenario 1, isolating this test to
   replication-backed *authorization* rather than strand-cohort discovery.

Assertions: after convergence, `Rx.isMember(S) === true` and `S.resolvePeerAddrs(Rx).length > 0`
with **no** local seeding on the consulting node; a never-authorized stranger peer is
`isMember === false` (selectivity); then `S.pushWake(Rx)` returns `{ accepted: true, status:
'active' }` and the strand transitions **hibernating → active** for real.

## How to validate / review

- **Run it:** from `packages/integration-tests`, `yarn vitest run
  src/scenarios/push-wake-e2e.integration.ts`. Expect **3 passed, 1 skipped** (scenario 2 stays
  skipped — see below). Scenario 4 runs ~1.4–4.5 s.
- **Stability:** I ran the full file **20 consecutive times with zero failures** after the final
  design. The path there is itself a finding (see below) — getting here took discarding two flaky
  designs, so re-running a batch (≥10×) is the right confidence check for a reviewer, not a single
  green run.
- **Prove it's really replication (not seeding):** confirm A is a *distinct* node from the
  consulting nodes, and that the only `authorizePeer` / `seedReceiverRecord` calls target **A**.
  `Rx.isMember(S)` and `S.resolvePeerAddrs(Rx)` are gated behind `waitForCadrePeerConverged` /
  `waitForCrossNodeControlSync` polls (never fixed sleeps).
- **Typecheck/lint:** `yarn typecheck` (integration-tests) clean; `eslint` on the file clean.
- **No regression:** `control-db-two-node-convergence.integration.ts` still passes (588 ms).

## Honest gaps & things to scrutinize

- **The hibernating→awake transition works by *avoiding* the strand-cohort gap, not fixing it.**
  It relies on A and S being addr-less so Rx's strand resume is solo. This is a legitimate,
  documented test-topology choice (and faithful — it's a real resume), but a reviewer should
  understand the test would FAIL if A/S advertised control addrs. The underlying gap is
  `control-network-cohort-discovery` (plan/). This is the most important thing to push on:
  is sidestepping acceptable, or should the scenario instead wake an already-active strand (the
  scenario-2 precedent) to make the dependency explicit? I judged the real transition more
  valuable; reviewer may disagree.
- **Flakiness history (transparency).** Earlier iterations were flaky: a star topology hit
  "stream has been reset / 0-of-3 approvals" on cluster commits; an Rx self-`UPDATE` variant timed
  out on the edge-node write. The final single-writer + full-mesh + `seedReceiverRecord` design is
  stable across 20 runs, but this is a **real-libp2p convergence test** — if CI ever flakes, the
  lever is the single-writer / full-mesh invariant (or, last resort per the ticket, `it.skip` +
  the recipe documented), **not** widening timeouts. Timeouts are already generous (30 s polls,
  90 s test).
- **`connectControlNodes` is duplicated.** I added a local copy in this file (the prereq's
  convergence test has its own). A future DRY cleanup could hoist it into the harness
  (`test-network.ts`) and have both tests import it; I kept it local to stay in-scope and avoid
  touching the landed convergence regression anchor.
- **Scenario 2 (NAT/relay) remains `it.skip`** pending `push-wake-e2e-shared-authority-topology`
  (fix/). That ticket overlaps this one; the relay variant is a separate topology and is out of
  scope here. The shared-authority semantics it needs are now demonstrated by scenario 4 (single
  authority + replicated membership), so it has a worked example to follow.
- **Full integration suite not run end-to-end** (many slow libp2p scenarios; exceeds the agent
  idle budget — not agent-runnable). Exercised: push-wake (20×), convergence (1×), typecheck, lint.
  A human/CI run of the remaining scenarios is the residual gap.

## Review checklist

- [ ] Scenario 4 passes reliably (re-run ≥10×).
- [ ] Replication is genuine: writes land only on A; consulting nodes read sibling-written rows.
- [ ] The single-writer + full-mesh + ephemeral-A/S invariants are intact (don't "simplify" them
      away — each was load-bearing for non-flakiness).
- [ ] Decide on the strand-resume disposition (sidestep the cohort gap vs. wake-already-active).
- [ ] Locally-seeded scenarios 1 & 3 unchanged and still green.
