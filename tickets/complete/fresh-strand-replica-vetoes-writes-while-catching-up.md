description: A storage replica that had just joined a group could reject other machines' writes while it was still copying data, which failed a phone's write about one run in four under load. The fix landed upstream in optimystic 1.12.1; this pass confirms both affected test scenarios now pass reliably, and speeds up the one that had been slowed down to avoid the failure.
prereq:
files: packages/integration-tests/src/harness/cadre-invite.ts (startPinningMember, PinningMemberOptions.reconcileMs), packages/integration-tests/src/scenarios/owner-anchor-follows-owner-changes.integration.ts (M_RECONCILE_MS, REFRESH_MS, header comment), tickets/.pre-existing-known.md (entry removed), packages/integration-tests/src/scenarios/strand-always-on-replica-hosts-cross-party-join.integration.ts (validated, unchanged)
difficulty: easy
----
# A fresh strand replica no longer vetoes writes while it catches up

## Background

A cohort member that had just joined and was still pulling blocks voted `reject` on a pend with `block <id> unavailable (unmaterializable): cannot verify revision`. One reject of three failed the writer's transaction with a non-retryable `ValidatorRejectionError`. Seen on a strand (`strand-always-on-replica-hosts-cross-party-join`, step 3, 6 of 24 failed 8-way parallel) and on the control network (`owner-anchor-follows-owner-changes`, B's `authorizePeer` ~1.5 s after A's `addOwner`, 2 of 3 failed with M reconciling every 2 s).

Fixed upstream by optimystic's `catching-up-member-vetoes-pends-it-cannot-verify`, released in 1.12.1 and adopted by Sereus commit `99614e84`. The promise-round vote now reads the committed revision and pending claims from storage metadata instead of materializing the block; a member that cannot read the metadata gives no answer rather than a veto.

## What this pass changed (Sereus side only)

- `startPinningMember` takes a `reconcileMs` option, forwarded to `controlNodeConfig` (`network.controlCohort.reconcileMs`). On a pinning member that timer is the only thing that runs the membership refresh.
- `owner-anchor-follows-owner-changes` runs M at `M_RECONCILE_MS = 2_000` and cuts `REFRESH_MS` from 30 s to 10 s. The `NOTE:` that kept M at the default 15 s because of this ticket is gone. The test now takes 9–11 s; `owner-anchor-follows-owner-key-changes` recorded about 47 s before.
- The scenario's entry in `tickets/.pre-existing-known.md` is removed.

No test was added: the upstream fix carries its own reproductions at the storage layer, and the two scenarios here are the end-to-end checks.

## Validation (this pass)

- `strand-always-on-replica-hosts-cross-party-join`: 8 processes of `yarn workspace @serfab/integration-tests exec vitest run strand-always-on-replica-hosts-cross-party-join` at once, 3 rounds: **24 of 24 passed** (was 6 of 24 failed on 1.12.0). Test time 7.6–10.2 s per run under that load. No log contained `unmaterializable` or `ValidatorRejection`.
- `owner-anchor-follows-owner-changes` with M at 2 s, run beside `cadre-invite-any-member`, `cadre-invite-row-unreplicated` and `enrollment-e2e` (4 processes at once), 8 rounds: **32 of 32 passed** (was 2 of 3 failed). Plus 8 copies of owner-anchor alone in parallel: 8 of 8. M's anchor followed each step after at most 2.1 s; B's vouch landed ~1.3 s after `addOwner`, the same timing that failed before.
- `yarn typecheck` in `packages/integration-tests` and `eslint` on the two edited files: clean.
- `@serfab/cadre-cli` dist was stale from an earlier commit (the stale-build guard refused to run); rebuilt with `yarn workspace @serfab/cadre-cli build`. No sibling repository was built.

## Known gaps

- Full `yarn check` and the full integration suite were not run in this pass.
- The report's second fingerprint, `SyncRetryExhaustedError … commit-not-durable: 0 of 3 cohort member(s) report holding rev 8 … (local-executed)` on `default/app/Data`, was seen once in a full `yarn check` on optimystic 1.11.0 and never reproduced. Upstream left it out of scope with no code site found. It did not appear in the 24 runs above. If it recurs, it needs a fresh report with `optimystic:db-p2p:coordinator-repo*` logs.
- Upstream did not identify why the replica's held `latest` would not materialize; the fix removed the vote's dependence on it. If it matters again, upstream asks for `optimystic:db-p2p:storage-repo,optimystic:db-p2p:block-storage` in the debug namespaces.

## Reviewer checks (answered below)

- `REFRESH_MS = 10_000` against a measured maximum of 2.1 s: is that margin right for a loaded full-suite run?
- The removed `NOTE:` was the only record of why M once ran at 15 s; the history now lives in `complete/4.62-owner-anchor-follows-owner-key-changes` and this ticket.

## Review findings

Read `ticket(implement): fresh-strand-replica-vetoes-writes-while-catching-up` before the handoff. The diff is three small edits in test code plus removal of the known-failure entry.

- **Correctness.** `startPinningMember` forwards `reconcileMs` to `controlNodeConfig`, which already accepts it (`node-fixtures.ts`, mapped to `network.controlCohort.reconcileMs`), with the same conditional-spread idiom as `topology.ts` and `control-trio.ts`. `M_RECONCILE_MS` is used only by M; `REFRESH_MS` only bounds the wait on M's anchor (`owner-anchor-follows-owner-changes.integration.ts:141`). No defects found.
- **`REFRESH_MS = 10_000` margin.** About 5 times the measured worst case of 2.1 s, and the wait on M's anchor starts only after a separate wait on the replicated row (budget `OP_MS`), so the 10 s covers one 2 s tick plus one refresh pass and none of the replication time. Kept as is; a loaded full-suite run would have to slow a single local refresh pass by more than 8 s to fail it.
- **Removed `NOTE:`.** Its condition ("once that ticket lands, pass `reconcileMs` and shorten the budget") is exactly what this pass did, so removing it is correct; the history lives in `complete/4.62-owner-anchor-follows-owner-key-changes` and this ticket.
- **Hygiene (fixed).** The edited header comment had one line run past the file's wrap width; rewrapped.
- **Docs.** `docs/architecture.md` (owner anchor section) still says replicated changes are followed at the next reconcile, "every 15 s by default" — still true, the scenario only overrides it. `docs/testing.md` lists both scenarios without timing or known-failure notes. No doc change needed. `tickets/.garden-report.md` still lists this ticket as blocked on an upstream release; that file is a generated gardening snapshot and is left for the next garden pass.
- **Tests.** None added and none cut: the change is test configuration, and the upstream fix carries its own storage-layer reproductions.
- **Validation (this pass).** 3 copies of each scenario run at once (6 processes): 6 of 6 passed, test time 7.8–9.6 s; no `unmaterializable` or `ValidatorRejection` in any log. `yarn typecheck` in `packages/integration-tests` and `eslint` on both edited files: clean. Full `yarn check` not run, as in the implement pass.
- **Tripwires / follow-ups.** None filed. The unreproduced `commit-not-durable` fingerprint stays as recorded under Known gaps; it has no code site and no current reproduction, so it does not meet the filing bar.
