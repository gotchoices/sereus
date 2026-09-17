description: When this machine gives up on a change to the shared party records, nothing says so — no warning, no error reaching the app, nothing in the normal log. In one test run a machine quietly stopped publishing its own network address and the run still reported success.
files: packages/cadre-core/src/control-retry.ts, packages/cadre-core/src/control-write-retry.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/types.ts, packages/cadre-core/test/control-write-retry.spec.ts, packages/integration-tests/src/scenarios/control-write-degraded-cohort-member.integration.ts
difficulty: medium
repro: verified
----

# What happens now

Every local control write passes through one funnel: `ControlDatabase.lockedWithRetry` → `retryControlWrite` → `retryControlOperation` (`packages/cadre-core/src/control-retry.ts`). That loop has exactly two ways to give up on a write — the classifier declines the failure as non-transient, or the attempts/budget run out — and on both it does the same thing: it writes one line to `debug('sereus:cadre:control-db')` and rethrows.

That debug namespace is off unless somebody turns it on. `cadre-cli` enables `cadre:*,sereus:*` only behind its `--debug` flag (`packages/cadre-cli/src/commands/start.ts:103`); nothing else in the repo enables it. So in ordinary operation the funnel's account of what it decided is not written anywhere.

That would be survivable if every caller surfaced the rethrown error, and most do — a CLI command or an API call fails and the operator sees it. The background writes are different. `CadreNode.startRecordRefresh` (`cadre-node.ts:2354`) fires the self-address republish as `void this.registerSelf().catch((error) => log(...))`, where `log` is `debug('sereus:cadre:node')` — the same off-by-default treatment. Two sibling paths do the same thing: the post-connect drain at `cadre-node.ts:3407` and the `connection:open` replication drain at `cadre-node.ts:3665`.

Put together: a background control write can fail permanently, and the machine, the operator and the embedding app all learn nothing.

## What that costs

The self-address republish is the case measured. A node's `CadrePeer` row carries an `UpdatedAt` stamp; a resolver discards a record older than `DEFAULT_PEER_RECORD_MAX_AGE_MS` (15 minutes) and the heartbeat re-stamps at half that (`packages/cadre-core/src/peer-record.ts`). So two consecutive silently-failed heartbeats are enough for every other machine in the party to stop accepting this node's address as fresh — it becomes unreachable to anyone who does not already hold a connection, and nothing anywhere said a word.

The observation that produced this ticket: run 4 of the 2026-09-17 five-run series of `control-write-degraded-cohort-member.integration.ts` reported **7 passed**, while node B's background `[self-record-update]` had been abandoned permanently during the run. The only trace was a debug line that happened to be captured because that run had `DEBUG` set.

## Why the write was abandoned, and why that part is not ours

Contention on a control block now reaches this repo as Optimystic's own sync layer giving up:

```
Control write [self-record-update] failed non-transiently on attempt 1/3, not retried here:
SyncRetryExhaustedError: sync for collection default/cadrecontrol/CadrePeer exhausted 10 retries:
  pending conflict: block(s) held by unresolved rival action(s) pkM1HAKGOKmJUc2aCK8NXA
```

The cause is a wedged pending record on one cohort member, reproduced deterministically upstream and owned there: `../optimystic/tickets/implement/a-member-that-missed-a-commit-refuses-every-later-write`. A member that promised a write and then missed its commit keeps that write's pending record indefinitely and reads it as a live rival on every later write to the same block; at three members one such vote refuses everything.

Two upstream answers matter for what this ticket may and may not do:

- **Do not widen the retry.** Upstream measured a contending writer against a genuinely live, progressing rival: it absorbed the contention in two retries and committed. The budget only looks wrong against a record that will never clear, and against that one no budget is enough. `SyncRetryExhaustedError` is correctly declined here (`control-write-retry.spec.ts` already pins that case) and must stay declined.
- **Contention is no longer a rejection.** `pending conflict` is now a `held` verdict that counts toward neither approvals nor rejections (`../optimystic/packages/db-p2p/src/cluster/cluster-repo.ts`, the branch returning `kind: 'held'`), landed in optimystic `ebc5483c`/`03ffadc4`. The `Transaction rejected by validators (N/M rejected): … pending conflict …` text this repo's comments and specs describe as the live shape did not appear once in five isolated runs and is now historical.

So the local work is not to retry harder. It is to stop losing a write in silence.

# What must be true afterwards

**The funnel reports every abandonment to somebody who is listening by default.** Both exits of `retryControlOperation` — the non-retriable decline and the exhausted loop — notify an observer exactly once, with enough to attribute it: the operation label, how many attempts were made out of how many allowed, why it stopped (declined / attempts / budget), elapsed time, and the error. A throwing observer must not replace the real failure; catch and log around the call.

**A node notices its own abandoned background writes.** The observer is wired by `CadreNode`, not left for an embedder to discover. Two surfaces, and both are wanted: a `CadreNodeEvents` entry so an app can react, and a say-once operator-visible escalation for the case that degrades the party on its own — a self-address republish that has not succeeded for longer than the record's freshness ceiling. `StrandMembershipReconciler.noteIdlePass` (`packages/cadre-core/src/strand-membership-reconciler.ts:503`) is the shape to copy for the escalation: one `console.warn` in the `[sereus]` style, armed once and re-armed on the next success, naming the consequence rather than the mechanism.

**The scenario cannot go green over a lost write.** `control-write-degraded-cohort-member.integration.ts` must fail if a background control write is abandoned outside the windows where a case deliberately degrades the cohort. The file already tracks `activeDegradation` for exactly this kind of scoping, and it already has a `captureControlRetryLogs()` helper — but the new event is a better seam than scraping debug lines, because it does not depend on debug being enabled.

**The comments describing the old shape say the current truth.** Three places describe `pending conflict` as a promise-phase validator rejection, which it no longer is:

- the accepted-tradeoff `NOTE:` on `isUncommittedTransactorAggregate` (`control-write-retry.ts`, around line 195), whose own revisit condition — "when `a-contended-pend-refusal-is-permanent-on-a-small-cohort` lands" — has tripped;
- the module comment at the top of the same file, which offers that rejection as the one rejection the wrapper claims;
- `PROMISE_PHASE_REJECTION_IN_PEND_AGGREGATE` and the `SyncRetryExhaustedError` case in `control-write-retry.spec.ts`, which describe the two as the live and the exhausted sides of the same race.

**The classifier's behaviour does not change, and the reason is recorded.** The follow-up the fix ticket contemplated — "have `matchesRetriableMessage` decline any chain that reports a validator rejection or a non-zero rejection count" — was researched and is **wrong in that general form.** Now that `pending conflict` votes `held`, the promise-phase rejections that remain are stale revision, block-unavailable, membership-not-admitted and a configured validator's refusal (all in `validatePendOperations`, `../optimystic/packages/db-p2p/src/cluster/cluster-repo.ts`). A **stale revision** rejection is precisely the one a re-presentation fixes, because this loop re-runs the whole write body including its reads — so a blanket rejection veto would remove a retry that helps in order to save two wasted attempts on the ones that do not. Keep the wrapper-only claim; rewrite the `NOTE:` to state that, with a revisit condition that is about a rejection class becoming expensive to re-present, or about upstream offering a typed surface (`../optimystic/tickets/backlog/debt-a-downstream-repo-classifies-retries-by-parsing-our-error-text`) — not about contention.

# Design notes

The observer hook belongs on the policy, not in the loop's hard-coded behaviour: `ControlRetryPolicy` and `ControlRetryOptions` both gain an optional `onAbandon`, so the **write** policy carries it and the read policy (`control-read-retry.ts`) can decide separately. Scope this ticket to writes and say so at the seam — an abandoned read throws to a caller that is awaiting it, so nothing is lost silently there; an abandoned write may have no caller at all.

`ControlDatabase` should own a single settable listener and merge it into `lockedWithRetry`'s options, with the same one-listener-per-database ownership contract already written out on `setMembershipChangeListener` (`control-database.ts:2308`) — one `CadreNode`, wired in `start()`, cleared on teardown, a second call replaces rather than fans out.

Do not route this through `console.warn` from inside the retry loop. `cadre-core` is a library, and the file that already warns says why (`cadre-node.ts`, `warnIfAnnounceAddrsDiscardRelay`: prefer embedder surfaces over growing a console surface inside a library). The loop notifies; the node decides that one specific, measured condition deserves a console line.

The escalation threshold should be stated in terms of the consequence, not a retry count: the self record has not been successfully republished for longer than `DEFAULT_PEER_RECORD_MAX_AGE_MS`, at which point other machines are already discarding it. A count of consecutive failures is the wrong bar — one failure at a 7.5-minute heartbeat is already half the budget.

## Why this was not re-measured in this pass

The five-run series behind this ticket ran against `../optimystic` quiet and clean at `987c45cf` (= `03ffadc4` plus one tickets-only commit), so the `dist` under measurement was exactly the reviewed fix. That is no longer the case: `../optimystic` now carries uncommitted edits across `db-core` and `db-p2p` (its own runner is working `a-member-that-missed-a-commit-refuses-every-later-write` and `a-write-reported-torn-can-already-be-saved`). A run today would measure a half-finished upstream tree, not the build the evidence describes. Re-measure after that upstream work lands, not before.

# TODO

- [ ] Add `onAbandon` to `ControlRetryPolicy` and `ControlRetryOptions` in `control-retry.ts`; call it exactly once from both give-up paths (the non-retriable decline and the loop exit), inside a try/catch so a throwing observer cannot replace the write's real failure. Carry label, attempts made, attempts allowed, elapsed ms, a reason discriminant, and the error.
- [ ] Wire it through the write policy only (`retryControlWrite` in `control-write-retry.ts`); leave the read policy alone and say at the seam why reads are out of scope.
- [ ] Give `ControlDatabase` a single `setControlWriteAbandonedListener`, merged into `lockedWithRetry`'s options, with the ownership contract `setMembershipChangeListener` already documents.
- [ ] Add the `CadreNodeEvents` entry in `types.ts` and emit it from `CadreNode`; wire the listener in `start()` and clear it on teardown alongside the existing `setMembershipChangeListener(null)` at `cadre-node.ts:4124`.
- [ ] Track the last successful self-record publish in `CadreNode`; in `startRecordRefresh`'s republish catch, escalate once with a `console.warn` in the `[sereus]` style when that gap exceeds `DEFAULT_PEER_RECORD_MAX_AGE_MS`, naming what other machines will do about it, and re-arm on the next success.
- [ ] Unit-cover the loop's new behaviour in `packages/cadre-core/test/` — both give-up paths fire once, a committed retry fires nothing, a throwing observer does not disturb the rethrown error.
- [ ] Make `control-write-degraded-cohort-member.integration.ts` fail on an abandoned background control write outside a deliberately degraded window, using the new event rather than the debug-line capture. Check the existing cases that provoke abandonment on purpose still pass.
- [ ] Rewrite the accepted-tradeoff `NOTE:` on `isUncommittedTransactorAggregate` and the module comment above it to describe the post-`held` world, with the recorded decision (no blanket rejection veto, and why stale revision is the reason) and a revisit condition that is not "contention".
- [ ] Update the two literals' doc comments in `control-write-retry.spec.ts`: `PROMISE_PHASE_REJECTION_IN_PEND_AGGREGATE` is a historical capture, `SYNC_RETRY_EXHAUSTED_PENDING_CONFLICT` is the live shape. Do not delete either literal — both are the surviving copies of pruned logs.
- [ ] Update the fingerprint table in the scenario's header comment (`control-write-degraded-cohort-member.integration.ts`, around line 137) to match the new delta at the top of `tickets/.pre-existing-known.md`, which is authoritative.
