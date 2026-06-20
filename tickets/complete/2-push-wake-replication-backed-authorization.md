description: A new networked test proves a node can learn who its fellow members are by syncing the shared membership database over the network — the real production path — and then wakes a sleeping peer, instead of being hand-fed those facts locally as the older tests do.
prereq: control-db-two-node-convergence-test, control-db-network-backed
files: packages/integration-tests/src/scenarios/push-wake-e2e.integration.ts
difficulty: medium
----

## What landed

Added **scenario 4 — "wakes a member whose authorization and address were learned by
control-DB replication, not local seeding"** to `push-wake-e2e.integration.ts`, alongside the
existing locally-seeded scenarios (kept as fast wire-path coverage). Membership is written **only
on an authority node** (A), converges to the consulting nodes (S, Rx) over the live network-backed
control DB, and the real wake then passes its `isMember` / `resolvePeerAddrs` gates **via
convergence, not local seeding**. The file header docstring was updated: the old "cross-node
control reads do not converge" deviation is now false (network-backing landed), scenario 4 is
listed, and the locally-seeded scenarios are described as the fast floor.

### Topology & flow

Three nodes in one party: **A** (sole authority + storage), **S** (sender), **Rx** (hibernating
receiver). Three load-bearing invariants make it deterministic against the real network-backed
control DB:

1. **One writer, pure readers.** Only A writes a row the assertions depend on — `A.authorizePeer(S)`
   and `seedReceiverRecord(A, Rx, …)`. S and Rx never write a waited-on row; they pull A's rows on
   read. (Mirrors the single-writer/pure-reader split of the two-node convergence test.)
2. **Full mesh.** All three control nodes are directly connected (`connectControlNodes` ×3, each
   link both-sides confirmed) so a 3-member cohort commit can route between cluster members.
3. **No addr-bearing non-self rows.** A and S use ephemeral libp2p identities (no `privateKey`) so
   they never self-publish an addr-bearing `CadrePeer` row; Rx's strand resume therefore stands up
   networked-solo, isolating this test to replication-backed *authorization* rather than the
   strand-cohort discovery gap.

Assertions: after convergence `Rx.isMember(S)` and `S.resolvePeerAddrs(Rx).length > 0` with no
local seeding on the consulting node; a never-authorized stranger is `isMember === false`
(selectivity); then `S.pushWake(Rx)` returns `{ accepted: true, status: 'active' }` and the strand
transitions hibernating → active for real.

## Review findings

Adversarial pass over the implement diff (commit `5264087`) read with fresh eyes before the
handoff, cross-checked against the prereq `control-db-two-node-convergence.integration.ts` and the
production `cadre-node.ts` / `strand-cohort.ts` source.

**Checked & verified clean:**

- **Tests run + stability.** `yarn vitest run src/scenarios/push-wake-e2e.integration.ts` from
  `packages/integration-tests` — **3 passed, 1 skipped** every run. Ran **9 consecutive times,
  zero failures**; scenario 4 runs ~1.5–4.5 s. This is a real-libp2p convergence test, so the
  batch (not a single green) is the confidence check. (The implementer's claim of 20× green is
  consistent with what I observed at 9×.)
- **Lint + typecheck.** `eslint` on the file → exit 0. `yarn typecheck` (integration-tests) → clean.
- **Replication is genuine, not seeding (correctness).** Confirmed by inspection that A is a
  distinct node from the consulting nodes, the only `authorizePeer` / `seedReceiverRecord` calls
  target **A**, and the consulting-node reads (`Rx.isMember(S)`, `S.resolvePeerAddrs(Rx)`) are gated
  behind `waitForCadrePeerConverged` / `waitForCrossNodeControlSync` polls — never fixed sleeps.
- **The "networked-solo" claim is true against source.** Verified `resumeStrandRuntime →
  resolveCohortSeed → deriveCohortSeed` (`cadre-node.ts:1209/1499/1504`, `strand-cohort.ts:29`):
  an addr-less sibling row yields `hasOtherPeers = true` + empty `bootstrapNodes`, so
  `selectStrandMode` picks `networked` with no dialable peers — identical to scenario 1. The
  ephemeral-A/S invariant is what keeps `bootstrapNodes` empty; the comment's rationale is accurate.
- **Comment line-references currently accurate.** Spot-checked `registerSelf` skip-without-key
  (`cadre-node.ts:602`), `resumeStrandRuntime` (`:1209`), `WAKE_PROTOCOL` handler. All match. (Such
  inline line numbers are inherently drift-prone, but this is the file's pre-existing comment style
  and they are correct as of this commit — left as-is.)
- **Real hibernating → active.** `bringUpHibernatingStrand` asserts active→hibernating, then the
  wake asserts `status: 'active'` and `getStrand(...).status === 'active'` — a genuine transition,
  not the already-active branch.
- **Resource cleanup / error handling.** All three nodes stopped in `finally` with `?.` guards for
  partial boot. No `it.only`/`describe.only`, no stray debug logging in the diff.
- **No regression.** `control-db-two-node-convergence.integration.ts` still passes.
- **Referenced follow-ups exist** (no dangling references): `fix/push-wake-e2e-shared-authority-topology`,
  `plan/control-network-cohort-discovery`.
- **Docs.** STATUS.md / architecture.md track subsystems, not individual scenarios — no drift; the
  file's own updated header docstring is the relevant documentation and reflects the new reality.

**Findings & disposition:**

- **MINOR — DRY: growing duplication of integration-test helpers (filed, not fixed inline).**
  `connectControlNodes`, `makeOwnAuthority`, `nodeConfig`/`NodeOpts` are now copied verbatim across
  the two control-db sibling scenarios, and the two `connectControlNodes` copies have already
  diverged (this file's is pair-scoped; the convergence test's only checks `length > 0`).
  `wsTransports` / `createSignedSAppConfig` are duplicated suite-wide (8 / 5 files). A proper fix is
  a harness-consolidation effort spanning many files and the landed regression anchor, which is too
  broad to do inline here without an inconsistent half-measure. Filed
  `tickets/backlog/integration-test-harness-helper-consolidation.md`.

- **RESOLVED (design question raised by implementer) — strand-resume disposition.** The implementer
  flagged that the hibernating→active transition works by *avoiding* the strand-cohort discovery gap
  (ephemeral A/S → networked-solo resume) rather than fixing it, and asked whether to instead wake
  an already-active strand to make the dependency explicit. **Decision: keep the sidestep.** Waking
  a real hibernating strand is the more valuable assertion, the sidestep is faithful (it's a real
  resume, not a stub), it is thoroughly documented in the scenario comment, and the underlying gap
  is orthogonal to this ticket's subject (replication-backed *authorization*) and already tracked by
  `plan/control-network-cohort-discovery`. No change.

- **NO major findings; no bugs.** No new fix/plan tickets warranted.

**Categories with nothing to report (explicitly):**

- *Edge/error/regression test coverage* — happy path, selectivity negative (stranger), and the
  non-member rejection (scenario 3) are all present; the wake decision matrix + framing are covered
  by the cadre-core unit tests this file's header points to. No additional cases needed for the
  replication-backed scenario.
- *Type safety* — no `any`; non-null assertions are test-context and consistent with sibling tests.
- *Performance / resource leaks* — bounded polls (30 s) with `finally` shutdown; no leaks observed
  across 9 runs.

## Honest residual gaps (carried forward from implement, unchanged)

- **Full integration suite not run end-to-end** — many slow libp2p scenarios exceed the agent idle
  budget (not agent-runnable). Exercised here: push-wake (9×), convergence (1×), lint, typecheck.
  A human/CI run of the remaining scenarios is the residual gap.
- **Scenario 2 (NAT/relay) stays `it.skip`** pending `fix/push-wake-e2e-shared-authority-topology`
  — a separate relay topology, out of scope here. Scenario 4 now gives it a worked
  single-authority + replicated-membership example to follow.
- **Flakiness lever, if CI ever flakes:** the single-writer / full-mesh / ephemeral-A/S invariants
  (or, last resort, `it.skip` + the documented recipe) — **not** widening the already-generous
  timeouts.

## How to re-validate

- From `packages/integration-tests`: `yarn vitest run src/scenarios/push-wake-e2e.integration.ts`
  → expect 3 passed, 1 skipped. Re-run ≥10× for convergence-stability confidence.
- `npx eslint packages/integration-tests/src/scenarios/push-wake-e2e.integration.ts` (clean);
  `yarn typecheck` (clean).
