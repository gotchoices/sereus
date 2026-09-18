description: Teach the control-write retry to re-submit a failed write only when the database library says the write can never land, and never after a failure that might still land. Then confirm on a fresh library build that the degraded three-machine scenario loses no control writes, and retire the matching known-failure notes.
files:
  - packages/cadre-core/src/control-write-retry.ts (`matchesRetriableMessage`, `reportsIndeterminateCommit`, `isUncommittedTransactorAggregate` and its accepted-tradeoff `NOTE:`)
  - packages/cadre-core/src/control-read-retry.ts (`causeChain`, the typed-check precedent; hoist it rather than copy it)
  - packages/cadre-core/test/control-write-retry.spec.ts (`describe('isRetriableControlWriteFailure')` ~240, `describe('isRetriableSchemaInitFailure')` ~416)
  - packages/integration-tests/src/scenarios/control-write-degraded-cohort-member.integration.ts
  - tickets/.pre-existing-known.md (the "Delta 2026-09-17 (evening)" block, lines ~13–33)
  - docs/architecture.md (line ~98, the "No approval threshold can relax unanimity…" bullet that describes the control-write retry)
  - ../optimystic/packages/db-core/src/collection/struct.ts (`TornActionError`, `SyncRetryExhaustedError`; read only)
  - ../optimystic/packages/db-core/src/transaction/errors.ts (`CoordinatorPartialCommitError`; read only)
  - ../optimystic/packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts (`PartialCommitError`, `mapCommitRefusal`; read only)
----

# Control-write retry: classify torn writes by `final`, then re-run the degraded cohort

## Background

Every local control-database write goes through one retry funnel, `retryControlWrite` in `packages/cadre-core/src/control-write-retry.ts`. It re-runs the whole write body (reads included) up to three times inside a 10 s budget. It does so only when the classifier says the failure is one where nothing can have been stored. Today the classifier works entirely on message text walked down the `cause` chain. It claims two shapes: the transactor's pend/read-phase aggregate (`Some peers did not complete: …[block:…]`) and a super-majority shortfall with zero rejections. It vetoes any chain containing the commit-phase `[blocks:` token.

Optimystic (`../optimystic`) landed three things on 2026-09-17 that bear on this funnel:

- **Dead pend fixed** (implement `9cbc7427`, review `98fd2ab1`). A member that promised a write and then missed its commit used to keep that write's pending record and vote `held` against every later write to the block. Every write to that collection was then refused, which is the wedge that made `control-write-degraded-cohort-member` lose writes. Upstream's three-machine reproducer went from failing after ~17 s to passing in ~1.2 s.
- **`TornActionError.final`** (`bbecaf28`). A torn write is one whose log entry is stored but whose other blocks are not known to hold it. `final: true` means the write is not saved and never will be, and its pending records were confirmed cancelled, so submitting it again stores it once. `final: false` means that could not be established, so submitting it again can store it twice. Upstream also documents that submitting again after `SyncRetryExhaustedError` is **not** safe, because the attempt that spent the budget may have left its log entry standing.
- **Staging leak fixed.** A failed write's actions used to stay staged and ride along with the next write.

## What the fix pass established (2026-09-17)

**What reaches this repo.** The error objects survive to the funnel with their `cause` chain intact. `txn-bridge.ts` rethrows the original error, or, for a guard refusal, a new `Error` whose `cause` is the original (`mapCommitRefusal`). Quereus wraps it in a `QuereusError` with `cause`. So `instanceof` checks on chain links work, and `control-read-retry.ts` already relies on this: `isCohortUnreachableRead` checks `instanceof BlockUnavailableError` over `causeChain(error)`. `TornActionError`, `SyncRetryExhaustedError` and `CoordinatorPartialCommitError` are all exported from `@optimystic/db-core`, which cadre-core already depends on. `PartialCommitError` (the legacy multi-tree variant) is exported from `@optimystic/quereus-plugin-optimystic`, also already a dependency.

**Would anything today re-present on `final: false` or `SyncRetryExhaustedError`?** Not in any shape observed, but only by accident of wording. Neither class is claimed by a matcher, because neither message starts with the transactor aggregate's `Some peers did not complete:` prefix. Nothing vetoes them explicitly, though. Both messages embed text from other machines: `SyncRetryExhaustedError` embeds `lastReason`, and `TornActionError` embeds `detail`, "the refusal in the responder's own words". `isUncommittedTransactorAggregate` matches the prefix and `[block:` anywhere inside one message string. The reasons produced today are fixed strings from `cluster-repo.ts` (`pending conflict: …`, `stale revision …`), so this does not fire now. It is one upstream rewording away from re-presenting a write that may land. This was established by reading the code (`db-core/src/transactor/network-transactor.ts` ~748, `collection/collection.ts` ~700–805, ~1552, ~1660), not by running it.

**The same accident covers partial commits.** `CoordinatorPartialCommitError` and `PartialCommitError` mean some collection or tree of the transaction is already durably committed. Their messages embed the underlying failure's message (`Underlying failure: ${reason.message}`). If that failure is a pend-phase transactor aggregate from a sibling collection, the composite message contains both `Some peers did not complete:` and `[block:`, and **today's classifier claims it**. The retry would then re-run the whole write body over collections that already landed. Upstream's contract on that error says a caller "MUST NOT blindly retry the whole transaction". Verified in the fix pass with a throwaway node script against the built `dist/control-write-retry.js` and the real upstream classes: `isRetriableControlWriteFailure` returned `true` for a `CoordinatorPartialCommitError` (wrapped in an `Error` with `cause`) and for a bare `PartialCommitError`, each carrying a pend-phase aggregate as its reason. It returned `false` for a `TornActionError` with `final: true` and for a `SyncRetryExhaustedError`. Not observed in a live run. It can only happen when a control write spans two collections (a table with a secondary index, or a multi-table body). It belongs in the same veto because it is the same class: a failure that says some of the write may be stored.

**Strand writes (step 5 of the fix ticket): no change needed.** Only two non-test sites re-run a strand write automatically:

- the membership reconciler (`strand-membership-reconciler.ts:290–336`, `consumeInvite` and `registerMemberPeer`), on its next scheduled pass;
- the strand-watcher relaunch (`strand-watcher.ts:181–196`), which re-runs founder bootstrap.

Both write rows keyed by the party's public key, and both check for the row before writing. A re-run after a write that did land either skips the write or fails on the primary key; it cannot store a second row. The comment at `strand-membership-reconciler.ts:318–319` already relies on this ("a redemption that lands but reports torn simply heals on the next pass"). Nothing else in cadre-core, `quereus-plugin-sereus` or the reference apps retries a strand write on its own. The reference apps' chat send does not auto-retry, but a user resending by hand mints a new message id each time. That is a separate app-level issue, filed as `backlog/bug-chat-resend-after-uncertain-failure-can-store-message-twice`, and not part of this ticket.

**The degraded-cohort confirmation run could not be taken in the fix pass.** `../optimystic` HEAD was `f8bbf4b6`, which is `98fd2ab1` plus four tickets-only commits (`git diff --stat 98fd2ab1..HEAD -- packages/*/src` is empty), with a clean tree. Its `db-p2p/dist` was built at 19:13, after `98fd2ab1` was committed at 19:12:54. But `db-p2p/src/storage/block-storage.ts` had been touched at 19:21:44 with no content change, so the stale-build guard refused every run (`@optimystic/db-p2p: dist is stale`). The ticket said not to build there, and the guard was not forced. Optimystic's runner then had two implement tickets queued (`legacy-multi-tree-commit-pends-everything-before-committing-anything`, `committing-a-block-deletes-a-pending-record-that-is-already-gone`) that will edit `db-core`/`db-p2p` source. Take the confirmation run against whatever **committed, quiet** build is current then. It must contain `98fd2ab1`; record the SHA you ran on.

## Design

Add one typed veto and one typed matcher to `control-write-retry.ts`, both evaluated over the `cause` chain's error objects rather than its messages. Hoist `causeChain` out of `control-read-retry.ts` into `control-retry.ts` beside `chainMessages`, so both policy modules share it.

```ts
/** A failure that says some of this write may be stored, or may still be. Never re-present. */
function reportsPossiblyStoredWrite(links: readonly Error[]): boolean
	// true if any link is:
	//   SyncRetryExhaustedError                        — upstream: resubmitting is not safe
	//   TornActionError with final !== true            — may be saved already, or land later
	//   CoordinatorPartialCommitError | PartialCommitError — part of the transaction is durable

/** A torn write that can never land: resubmitting stores it once. */
function isFinalTornWrite(link: Error): boolean
	// link instanceof TornActionError && link.final === true
```

`matchesRetriableMessage` becomes, in order:

1. not an `Error` → `false`;
2. `reportsPossiblyStoredWrite(causeChain(error))` → `false`;
3. `reportsIndeterminateCommit(chainMessages(error))` → `false` (unchanged);
4. any link `isFinalTornWrite` → `true`;
5. the existing message matchers.

The veto runs before the new matcher. A final torn write that reaches the funnel wrapped in a partial-commit error is still declined, because a sibling collection landed. Both classifiers (the default one and `isRetriableSchemaInitFailure`) share `matchesRetriableMessage`, so both get the veto and the matcher. That is correct for schema init too. The read classifier (`isRetriableControlReadFailure`) is untouched: a read commits nothing and does not raise these errors.

**Why a final torn write is worth re-presenting, not just safe to.** Upstream raises `final: true` mostly for `completion-refused` / `rival-holds-revision`: a rival holds the revision this write's log entry claimed. That is contention. The funnel re-runs the write body's reads, so attempt 2 builds on the rival's revision. This is the same argument the existing accepted-tradeoff `NOTE:` makes for retrying a stale-revision rejection. It stays inside the existing three-attempt, 10 s budget.

**Fail-closed properties to keep.** `instanceof` against a second loaded copy of `@optimystic/db-core` answers false. For the matcher that means no retry, which is the safe direction. For the veto it means no veto, which falls back to today's text behaviour, no worse than now. Note this asymmetry in the doc comment. Do not add a text fallback for the veto that parses `TornActionError`'s trailing sentence: upstream's own comment says `detail` is for log lines and never to branch on, and the typed field exists.

## Where to record the rule

Rewrite the second bullet of the accepted-tradeoff `NOTE:` on `isUncommittedTransactorAggregate`, which currently says `SyncRetryExhaustedError` "must stay declined". Make it name the new typed veto as the thing that keeps it declined, and state the `final` rule in one line. Point the module comment's paragraph on rejections at `reportsPossiblyStoredWrite`. Update the retry bullet in `docs/architecture.md` (~line 98) with one sentence: a torn write is re-presented only when the library marks it final; `SyncRetryExhaustedError`, a non-final torn write and a partial commit are never re-presented.

## TODO

Phase 1: classifier

- Hoist `causeChain` from `control-read-retry.ts` into `control-retry.ts`, export it, and re-point `isCohortUnreachableRead` at it.
- Add `reportsPossiblyStoredWrite` and `isFinalTornWrite` to `control-write-retry.ts` and wire them into `matchesRetriableMessage` in the order above.
- Unit tests in `control-write-retry.spec.ts`, built from the real upstream classes (construct `TornActionError` / `SyncRetryExhaustedError` / `CoordinatorPartialCommitError` / `PartialCommitError` directly and wrap them the way they arrive: a `QuereusError` with `cause`, and for torn writes also a guard-refusal-style `new Error(msg, { cause })`):
  - `TornActionError` `final: true`, bare and wrapped → retriable (both classifiers);
  - `TornActionError` `final: false` → not retriable;
  - `TornActionError` `final: false` whose `detail` embeds a pend-phase aggregate string (`Some peers did not complete: <peer>[block:x](…)`) → not retriable (pins the veto beating the text matcher);
  - `SyncRetryExhaustedError`, plain and with a `lastReason` embedding that aggregate string → not retriable;
  - `CoordinatorPartialCommitError` whose `reason` is a `TornActionError` `final: true` → not retriable;
  - `CoordinatorPartialCommitError` / `PartialCommitError` whose reason is a pend-phase aggregate `Error` → not retriable. This case is retriable at HEAD today; confirm the test fails before the change.
  - a `retryControlWrite` loop case: a body throwing a final torn write once, then succeeding, runs twice and resolves.
- Update the `NOTE:` on `isUncommittedTransactorAggregate`, the module comment, and `docs/architecture.md` as described above.
- `yarn workspace @serfab/cadre-core test test/control-write-retry.spec.ts test/control-read-retry.spec.ts`, then `yarn lint`.

Phase 2: degraded-cohort confirmation

- Check `../optimystic` is quiet and clean (`git status --short` empty, no files touched in the last few minutes) at a commit at or after `98fd2ab1`, with dist fresh by the guard. Record the SHA. Do not build there; if the guard refuses, wait for their runner, and if it stays refused, say so in the handoff rather than forcing it.
- Rebuild `@serfab/cadre-core` dist after Phase 1 (the scenario runs compiled output).
- Run `yarn vitest run --reporter=verbose src/scenarios/control-write-degraded-cohort-member.integration.ts` from `packages/integration-tests`, 5 times, each run fresh and in isolation, teeing to `tickets/.logs/control-write-retry-torn-final-and-degraded-rerun.run{1..5}.log`. Pass means 7/7 each run, zero `Pend blocks held` / `pending conflict` / `SyncRetryExhausted` lines, and zero `[abandoned-write` reports from the `afterEach` loss check.
- If all five are green: in `tickets/.pre-existing-known.md`, add a closing delta at the top saying the wedge fingerprint owned by optimystic `a-member-that-missed-a-commit-refuses-every-later-write` (the `SyncRetryExhaustedError … pending conflict: block(s) held by unresolved rival action(s)` / `Pend blocks held: n/3` lines in the "Delta 2026-09-17 (evening)" block) is CLOSED as of the SHA you ran on, with the five results. Say that a recurrence is a regression for `.pre-existing-error.md`, and mark the evening block superseded. Also retire the stale pointer in the "Delta 2026-09-17 (later)" block that names `control-write-refused-when-a-rival-write-holds-the-block` as the live candidate for the `resolvePeerAddrs(B)` returning `[]` fingerprint; that ticket is complete. There are no `- ` entry lines owned by the upstream slug; the ownership lives only in that delta prose.
- If any run is red: record per-run results and fingerprints in the handoff. Do not close the delta. If the fingerprint is the dead-pend wedge on a build containing `98fd2ab1`, report it through `tickets/.pre-existing-error.md` as a regression of the upstream fix.
