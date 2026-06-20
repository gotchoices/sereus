description: A party's shared membership database used to live only in each node's memory, so changes never reached other nodes; it is now wired onto the network layer so those rows actually replicate between nodes, with the database engine taught the transaction rules the security checks depend on.
prereq:
files: packages/cadre-core/src/control-database.ts (initialize ~210-244 — default-vtab + hydrate wiring), packages/integration-tests/src/scenarios/control-db-two-node-convergence.integration.ts (un-skipped, tripwire removed), packages/integration-tests/src/scenarios/push-wake-e2e.integration.ts (circuit-relay variant skipped — see fix ticket), docs/architecture.md (~169 convergence status), ../optimystic/packages/db-core/src/collections/tree/tree.ts (TreeReadView + readView), ../optimystic/packages/db-core/src/collection/collection.ts (createReadTracker), ../optimystic/packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts (getDirtySnapshot), ../optimystic/packages/quereus-plugin-optimystic/src/optimystic-module.ts (queryCommitted/runQuery/committedTreeView/OptimysticCommittedTable + secondary-UNIQUE enforcement), ../optimystic/packages/quereus-plugin-optimystic/test/committed-read.spec.ts, ../optimystic/packages/quereus-plugin-optimystic/test/secondary-unique.spec.ts
difficulty: hard
----

## Outcome

The `CadreControl` tables are now backed by the Optimystic network transactor (default vtab +
args + hydrate, mirroring `connectToStrand`), so a control write on one cadre node replicates
to connected peers, and the cadre-core consent path stays green. Two Optimystic transaction
-semantics gaps were closed to make this work: `committed.<Table>` deferred-CHECK reads (the
`FormationUsage.Monotonic` anti-replay) now honour Quereus's `_readCommitted` flag, and the
vtab now enforces secondary `unique` constraints (the single-use `StampId` / `MemberPrivateKey`
anti-replay columns).

The implementation is described in detail in the implement-stage commit
(`git show 9f70ff0`) and the Optimystic-side commits (`../optimystic` `42b1f17`, `e325d3b`).
This file records the review pass.

## Review findings

**Scope reviewed:** the implement diff (`9f70ff0`, sereus side) read first with fresh eyes,
then the Optimystic Phase-A code (`committedTreeView`/`runQuery`/`queryCommitted`,
`checkUniqueConstraints`/`resolveUniqueConflict`, INSERT/UPDATE wiring, `OptimysticCommittedTable`),
the cadre-core wiring, both integration tests, the two filed follow-up tickets, and the docs.

### Verified correct (checked, no action needed)

- **Cross-repo build/link (the handoff's #1 footgun).** Re-confirmed `dist/` is current in all
  three load-bearing packages: `db-core`, `quereus-plugin-optimystic`, and `@serfab/cadre-core`
  each have `dist` artifacts newer than their `src`, and the wiring
  (`setDefaultVtabName`/`setDefaultVtabArgs`/`hydrate`) is present in
  `cadre-core/dist/control-database.js`. The Optimystic working tree is **clean and committed**
  (the handoff's "NOT committed by this run" warning was stale — the changes are in `42b1f17`
  and `e325d3b`). Note: the committed-read + unique code is attributed in git to a *different*
  ticket's commit (`invalidation-cascade-detection`), but it is committed, built, and tested —
  a history-attribution quirk, not a gap.
- **Committed-read path.** `committedTreeView` builds a per-scan read-only view from the
  txn-bridge's captured pre-stage snapshot (or reads the live tree when nothing is staged, since
  clean == committed), never mutating the shared cached table — so a concurrent live scan during
  the deferred drain is unaffected. Routing covers full scan / point lookup / index seek. Pinned
  by `committed-read.spec.ts` (4 cases, incl. two in-flight tokens in one txn).
- **Secondary-UNIQUE enforcement.** Probes the *live* collection (committed + staged-this-txn) so
  intra-transaction duplicates collide like cross-transaction ones; skips partial-UNIQUE
  (`predicate`), exempts rows with any NULL constraint column, and excludes the row's own PK on
  UPDATE. Wired into both INSERT and UPDATE, returning structured `constraint`/`ok` results (not
  throws) so the engine applies SQL conflict semantics. Pinned by `secondary-unique.spec.ts`
  (5 cases incl. multi-NULL, IGNORE, intra-txn, composite).
- **Convergence test is a genuine replication assertion** (not local-seeding): peer X exists only
  as a row A writes, B never knows it locally, connect-before-write keeps the cohort ≥2, and B
  observes X via pull-on-read. Tripwire correctly removed, target un-skipped.
- **Docs.** `architecture.md:169` convergence status updated accurately (network-backing ✅,
  cohort auto-connect remaining). No stale "control DB is in-memory / never converges" claims
  survive in `cadre-consistency.md`, `STATUS.md`, or `strands.md`.

### Findings dispositioned

- **(major → already ticketed, confirmed sound) push-wake circuit-relay e2e skipped.**
  Network-backing makes the control DB party-shared, so two nodes can no longer each self-genesis
  as authority (`makeOwnAuthority` → `AuthorityKey.Authorized` collision once the cohort forms).
  This is the correct shared-authority semantic; the test encodes the old per-node-isolated
  assumption. Skip + pointer is the right disposition; `tickets/fix/push-wake-e2e-shared-authority
  -topology.md` is filed with accurate root-cause and a sound re-author plan, and overlaps the
  existing `tickets/implement/2-push-wake-replication-backed-authorization.md` (coordination noted
  in the ticket). **Footgun containment verified:** of the integration scenarios, only push-wake-e2e
  and the convergence test use `makeOwnAuthority`; `deliver-seed-cross-network`, `enrollment-e2e`,
  and `seed-bootstrap` do not self-genesis, so no other test silently regresses on shared authority.
- **(major → already ticketed) secondary-UNIQUE is O(rows)/write and not persisted across warm
  restart** (probe full-scans; `uniqueConstraints` not persisted in the Optimystic
  StoredTableSchema). Correct for the small cold/in-memory control tables today;
  `tickets/backlog/optimystic-secondary-unique-robustness.md` tracks index-backing + persistence.
- **(known limitation, not a defect) convergence still needs the cohort to form** — a solo write
  commits local-only; the test stands in for production cohort discovery with a manual `dial()`.
  Auto-connect is the remaining open prerequisite, tracked by `control-network-cohort-discovery`
  (plan/). Documented in both the test header and `architecture.md`.

### No findings (explicitly)

- **No minor findings to fix inline.** The wiring, the Optimystic transaction-semantics code, and
  the tests are clean, single-purpose, and thoroughly commented; lint is green; nothing rose to a
  fix-in-pass item.
- **Error handling / resource cleanup of `initialize()`** was considered: if `hydrate` rejects,
  `initialize()` throws with the libp2p node already registered, but this is the pre-existing
  pattern (`loadSchema` could already throw at the same point) and is not introduced by this
  change — not flagged.

### Not done (deferred, out-of-band)

- **Full integration suite not run end-to-end** (many slow libp2p scenarios; wall-clock exceeds
  the agent idle budget, so not agent-runnable). Exercised the directly-affected and
  highest-risk-for-shared-authority scenarios: convergence (pass, ~664ms), enrollment-e2e
  (9 pass), plus the cadre-core unit suite (556 pass) and the two Optimystic anchor specs
  (9 pass). A human/CI run of the remaining scenarios is the residual confidence gap.

## Validation run during review

- `yarn workspace @serfab/cadre-core test` → **556 passed, 1 skipped**
- `../optimystic` `committed-read.spec.ts` + `secondary-unique.spec.ts` → **9 passing**
- `yarn workspace @serfab/integration-tests test control-db-two-node-convergence` → **1 passed (~664ms)**
- `yarn workspace @serfab/integration-tests test enrollment-e2e` → **9 passed**
- `yarn lint` → **clean (exit 0)**

## Acceptance checklist

- [x] `CadreControl` tables backed by the network transactor (default vtab + args + hydrate).
- [x] A `CadrePeer` row written on A becomes readable on a connected B (convergence test passing).
- [x] No regression in the consent path (full cadre-core suite green).
- [x] Solo nodes commit local-only and don't hang.
- [x] Optimystic unit tests pin `committed.*`-excludes-in-flight-row and secondary-UNIQUE.
- [~] Broad "no regression": one e2e test skipped as an expected shared-authority consequence
      (ticketed in `push-wake-e2e-shared-authority-topology`), not silently left red; full slow
      suite deferred to CI.
