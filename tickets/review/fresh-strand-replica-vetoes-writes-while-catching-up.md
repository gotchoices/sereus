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

## Reviewer checks

- `REFRESH_MS = 10_000` against a measured maximum of 2.1 s: is that margin right for a loaded full-suite run?
- The removed `NOTE:` was the only record of why M once ran at 15 s; the history now lives in `complete/4.62-owner-anchor-follows-owner-key-changes` and this ticket.
