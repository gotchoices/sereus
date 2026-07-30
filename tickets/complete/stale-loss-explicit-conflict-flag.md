----
description: A write that loses a race to another machine now says so plainly in its failure response, so both write paths agree it is worth retrying instead of one of them giving up.
files: ../optimystic/packages/db-core/src/network/struct.ts, ../optimystic/packages/db-core/src/network/stale-failure.ts, ../optimystic/packages/db-core/src/network/index.ts, ../optimystic/packages/db-core/src/transaction/coordinator.ts, ../optimystic/packages/db-core/src/transactor/network-transactor.ts, ../optimystic/packages/db-core/src/testing/test-transactor.ts, ../optimystic/packages/db-p2p/src/repo/coordinator-repo.ts, ../optimystic/packages/db-p2p/src/storage/storage-repo.ts, ../optimystic/packages/db-core/test/stale-failure.spec.ts, ../optimystic/packages/db-core/test/coordinator.spec.ts, ../optimystic/packages/db-core/test/network-transactor.spec.ts, ../optimystic/packages/db-p2p/test/coordinator-repo-stale-classification.spec.ts, ../optimystic/packages/db-core/docs/transactor.md, ../optimystic/packages/db-core/docs/network.md, ../optimystic/docs/internals.md, ../optimystic/docs/transactions.md
difficulty: medium
----

# Complete: explicit `conflict` flag on pend failures

All changes are in the sibling `../optimystic` workspace (separate git repo, linked into Sereus via
`resolutions`), on branch `main`, uncommitted alongside the previous ticket's changes. **No Sereus
source changes** — confirmed by grep, see findings.

## What was wrong

Two write paths disagreed about whether a failed write was worth retrying, because each inferred
retryability from the *shape* of the failure payload rather than from anything the failure said:

- `Collection.sync` (single collection) retries on any non-success — fine.
- `TransactionCoordinator.pendPhase` (multi-collection) called a failure retryable only if it
  carried a `missing` (already-committed newer actions) or `pending` (rival in-flight action) list.

`CoordinatorRepo.classifyStaleRejection` confirms a lost race by re-reading its *own* storage, which
reveals that the revision is taken but not which actions took it — so it returned a failure with
only a free-text `reason` and neither list. The coordinator read that as a hard rejection and
refused to retry a race it could have won.

## What shipped

Retryability is stated, not inferred.

- `StaleFailure` gained `conflict?: boolean` (`db-core/src/network/struct.ts`): "this was an
  optimistic-concurrency loss; a re-read, rebase and re-pend can win."
- `isConflictFailure` (`db-core/src/network/stale-failure.ts`, re-exported from
  `network/index.ts`) is the one rule every pend consumer calls:
  `failure.conflict ?? Boolean(failure.missing?.length || failure.pending?.length)`. The fallback
  keeps producers that never set the field working, including a remote peer on an older build.
- Producers set `conflict: true` on genuine lost races only: `CoordinatorRepo.classifyStaleRejection`
  and `StorageRepo.pend`'s three optimistic-concurrency returns (`missing` branch, `'f'` policy,
  `'r'` policy). `StorageRepo.pend`'s validation-failure return is deliberately unflagged with a
  comment saying why.
- `NetworkTransactor.pend` **rebuilds** its aggregate `StaleFailure` from the per-batch responses
  rather than forwarding one, so it re-derives `conflict` across them; any conflicting batch makes
  the aggregate a conflict. It also now carries the first available reject `reason` through (the old
  aggregate dropped it).
- `TransactionCoordinator.pendCollection` calls `isConflictFailure(pendResult)`.
- `TestTransactor.pend`'s three optimistic-concurrency returns set `conflict: true`.
- Commit side deliberately untouched — see *Scope boundaries*.

Docs: `docs/internals.md`, `docs/transactions.md` (implement pass);
`packages/db-core/docs/transactor.md`, `packages/db-core/docs/network.md` (review pass).

## Scope boundaries honoured

- `TransactionCoordinator.commitCollection` still treats every returned non-success as a retryable
  stale loss, with a `NOTE:` at the site explaining it deliberately does not consult
  `isConflictFailure`.
- `ClusterRepo`'s ahead-vs-behind divergence test on `result.missing?.length` unchanged.
- `StorageRepo.commit`, `TestTransactor.commit` and the `FlakyCommitTransactor` forced-failure
  helper set no `conflict`.
- `classifyStaleRejection` stays conservative: confirmation is a purely local re-read, and the
  free-text reject reason is never parsed.
- `Collection.sync` does not read `conflict`; it retries on any non-success.

## Review findings

Read the full uncommitted `../optimystic` working-tree diff before the handoff summary. Note the
tree also carries the prior ticket's changes (`cluster-coordinator.ts`'s `ValidatorRejectionError`,
`classifyStaleRejection` itself, `mesh-harness.ts`, and the `ClusterClient` → `ICluster` narrowing);
those were separated out and treated as this ticket's input, not its output.

### Checked

- **Pend-producer coverage.** Audited every `success: false` site across all packages' `src`. All
  four `StorageRepo.pend` non-success returns are correctly dispositioned (`storage-repo.ts:328`
  validation deliberately unflagged; 377/385/388 flagged). `CoordinatorRepo.classifyStaleRejection`
  flagged. `TestTransactor.pend`'s three flagged. `ClusterRepo` has no `pend` at all.
  `test-transactor.ts:303,311,444` and `storage-repo.ts:495,608` — the sites the implement TODO
  listed — are all *commit*-path, correctly left alone.
- **Consumer coverage.** No remaining pend-path consumer re-derives retryability.
  `quereus-plugin-optimystic` and `db-cli` src have **zero** references to `StaleFailure` /
  `missing` / `pending` / `staleLoss` — the handoff's unaudited packages have nothing to audit.
  Sereus `packages/*/src` likewise has zero references, confirming no Sereus change was needed.
- **`missing-base-revision` refusal.** `isMissingBaseRevisionFailure` takes a `CommitResult` and all
  three call sites are commit-path — correctly outside this change.
- **Wire path.** `RepoClient.pend` returns `processRepoMessage<PendSuccess | StaleFailure>`
  verbatim; `repo/service.ts:266` assigns `response = await this.repo.pend(...)` unmodified;
  `protocol-client.ts` does `JSON.stringify(message)` over the whole envelope with no field
  whitelist. `conflict` crosses the wire by construction. Verified by reading all three sites, not
  by a live round-trip (see *Not filed*).
- **`pendPhase`'s aggregation rule** (`staleLoss: anyConflict && !anyHard`) is still correct with an
  explicit flag feeding it, and the new tests pin both halves.
- **Lint, build, full test suites** — see *Validation*.

### Minor — fixed in this pass

1. **`isConflictFailure` had no dedicated spec** (the handoff flagged this itself). Added
   `db-core/test/stale-failure.spec.ts`: 10 cases pinning the one subtle thing, the `??`-vs-`||`
   precedence — an explicit `conflict: false` must suppress the fallback *even when `missing` or
   `pending` evidence is present*, and only an absent field may trigger it. Also pins that the
   fallback returns a boolean rather than leaking an array length onto the public `staleLoss` field.
2. **Two per-package docs were stale and the implement pass did not touch them.** The rule is that
   docs are out of date until read, and these two publish exactly what changed:
   - `packages/db-core/docs/transactor.md:230` publishes the `StaleFailure` type verbatim. It was
     missing `conflict`, and used two type names that no longer exist (`TrxTransforms`,
     `TrxPending`, contradicting the correct `ActionTransforms`/`ActionPending` shown two paragraphs
     below). Added the field, corrected the names, and added a "Retryability (`conflict`)"
     subsection stating the field-plus-fallback rule and that consumers must read it through
     `isConflictFailure`.
   - `packages/db-core/docs/network.md:227` "Stale Failure Handling" asserted the returned
     `StaleFailure` carries "the `missing` field containing the newer committed transactions" — flatly
     false for the confirmed-loss shape this ticket exists to serve. Rewrote it and added the
     field-not-shape rule plus the rebuild-in-`pend` note.

### Major — none filed

Nothing found rises to major. Every gap the handoff listed is now closed (the `isConflictFailure`
spec), conditional (parked as a tripwire), or an explicitly-honoured scope boundary.

### Tripwires parked

- `db-core/src/transactor/network-transactor.ts`, the pend stale aggregation — `NOTE:` added: the
  aggregate uses `stale.some(isConflictFailure)`, so a pend whose batches mix a genuine lost race
  with a genuine hard rejection is reported retryable and burns its (bounded, backed-off) retry
  budget before failing. Deliberate today: an unclassified reason-only response from an older peer is
  indistinguishable from a hard rejection at this level, so `every` would refuse to retry a real race
  whenever one batch came from such a peer. `every` becomes both safe and tighter once every producer
  sets `conflict`.
- The implement pass's own tripwire (`coordinator.ts` `commitCollection` deliberately ignoring
  `isConflictFailure`) was reviewed and left as written — it names the right trigger condition.

### Second opinions the handoff asked for

- **Commit-side `conflict` absence is the right reading.** The implement ticket's TODO listed
  `test-transactor.ts:299,307,440` and `storage-repo.ts` commit returns while its own scope boundary
  forbade flagging commit failures. Those line numbers are all commit-path, `commitCollection`
  ignores the flag anyway, and flagging them would have created a producer with no consumer. Leaving
  them absent is consistent.
- **The added `reason` passthrough in the aggregation is kept.** The implement TODO described it as
  pre-existing ("keep the existing `reason` and `missing` passthrough unchanged"); it was not — the
  old aggregate silently dropped `reason`. So this is an undocumented scope addition, but a strictly
  better one: it is consumed by `SyncRetryExhaustedError.lastReason` and the multi-collection
  writer's failure message, and it is now asserted in `network-transactor.spec.ts`.
- **`conflict: false` does have a real producer** — `NetworkTransactor.pend`'s aggregation always
  sets the field, true or false. The handoff's "explicitly not retryable is never produced" gap only
  holds for *leaf* producers, and the new unit spec covers the semantics directly.

### Not filed, on purpose

- **End-to-end mixed-version wire round-trip.** Left untested. The path is `JSON.stringify` over the
  whole envelope with verbatim passthrough on both sides (three sites read, listed above) — there is
  no mechanism that could drop an unknown field. A `OPTIMYSTIC_INTEGRATION=1` libp2p test would cost
  that suite's full runtime for near-zero information. Not worth a ticket.

## Validation

All from `../optimystic` unless noted, after the review-pass edits:

| command | result |
| --- | --- |
| `yarn lint` (optimystic root, `eslint .`) | clean, exit 0 |
| `yarn build` (all optimystic workspaces) | clean, exit 0 |
| `yarn test` (all optimystic workspaces) | **0 failing.** db-core 1282 passing (was 1272 + 10 new); db-p2p 1437 passing / 41 pending; rest 52+49+44+43+12+125+326+6+258 passing, 12 pending |
| `yarn lint` (Sereus root) | clean, exit 0 |
| `yarn test` (Sereus root, all workspaces) | 131 passing / **1 failing**, pre-existing — see below |

The 41 + 1 + 11 pending optimystic specs are pre-existing skips, untouched.

### Pre-existing failure (not re-reported)

Sereus `packages/integration-tests`:
`push-wake-e2e.integration.ts > E2E push-wake over the control network > delivers a wake to a NAT'd
receiver over a circuit-relay (signaling-first) dial` fails with
`UnsupportedListenAddressesError: Some configured addresses failed to be listened on`. Already listed
in `tickets/.pre-existing-known.md` against in-flight slug
`bug-strand-node-relay-reservation-denied-by-membership-gate`, so the root cause is tracked and
`.pre-existing-error.md` was **not** written. Nothing skipped or loosened. Unrelated to this ticket:
it is a libp2p relay-reservation / membership-gate fault at `libp2p.start()`, with no pend path
involved.

### Tests covering this change

- `db-core/test/stale-failure.spec.ts` (**new, this pass**) — 10 cases over `isConflictFailure`.
- `db-core/test/coordinator.spec.ts` (`pendPhase`) — the regression test for the original bug (a
  conflict-flagged failure with no `missing`/`pending` yields `staleLoss: true`; fails against the
  old shape-inference code), plus reason-only-stays-hard and older-producer-fallback cases.
  `InstrumentedTransactor` gained a `conflictPendCollections` ctor param.
- `db-core/test/network-transactor.spec.ts` — `runMixedPend(staleResponse)` helper driven by three
  cases: conflict-flagged (aggregate carries `conflict: true` with an empty `missing`), hard
  rejection (`conflict: false`), and `missing`-only fallback (`conflict: true`).
- `db-p2p/test/coordinator-repo-stale-classification.spec.ts` — confirmed-loss cases assert
  `conflict: true` and that `isConflictFailure` agrees.
