description: Sereus used to work out which stage of a failed network write an Optimystic error came from by looking for a bracketed word in the message; it now reads the stage from a field on the error instead. Review the swap, including one deliberate change in which failures get a second attempt.
architecture: docs/cadre/control-replication.md#control-write-retry
files: packages/cadre-core/src/control-write-retry.ts, packages/cadre-core/src/control-read-retry.ts, packages/cadre-core/src/control-retry.ts (`chainMessages` doc only), packages/cadre-core/test/control-write-retry.spec.ts, packages/cadre-core/test/control-read-retry.spec.ts, packages/cadre-core/test/control-write-lock.spec.ts, packages/integration-tests/src/harness/error-chain.ts, packages/integration-tests/src/scenarios/control-write-degraded-cohort-member.integration.ts, docs/cadre/control-replication.md
----
# Review: the transactor aggregate is matched by phase, not by text

Optimystic 1.29.0 raises all four `NetworkTransactor` aggregates as one class, `PeersIncompleteError`, with `phase: 'get' | 'pend' | 'commit' | 'cancel'`. This repo's control-retry classifiers now read that field. With it, the last upstream message text leaves the control-retry funnel: the default control-write policy and the whole control-read policy are now matched entirely by type.

## What changed

**`control-write-retry.ts`**

- `isUncommittedTransactorAggregate` takes `links: readonly Error[]` (was a `message: string`) and answers `links.some(link => link instanceof PeersIncompleteError && (link.phase === 'get' || link.phase === 'pend'))`. It moved out of the matcher list into `matchesRetriableFailure`'s typed claims, beside `reportsUnreachableCohort`, the shortfall and the final torn write.
- `reportsIndeterminateCommit` takes `links` too and vetoes on `phase === 'commit'`.
- `TRANSACTOR_AGGREGATE`, `SINGLE_BLOCK_BATCH_TOKEN` and `COMMIT_BATCH_TOKEN` are gone.
- `RETRIABLE_CONTROL_WRITE_MATCHERS` is now an empty array, deliberately kept: `RETRIABLE_SCHEMA_INIT_MATCHERS` spreads it, so the "widened, not replaced" relation between the two policies stays expressed in code, and a future text matcher has one home. Its comment says that and names the one text matcher left in the module (the schema-init self-coordination refusal, which comes from `@optimystic/db-p2p`, not the transactor).
- `matchesRetriableFailure` runs both vetoes off one `causeChain` walk and only computes `chainMessages` for the matcher list at the end.

**`control-read-retry.ts`** — `isRetriableControlReadFailure` calls the same shared predicate over the chain it already builds for `reportsUnreachableCohort`, so it walks the chain once; its `chainMessages` import is gone.

**Comments.** The three `NOTE:`s the type retires are gone (the discriminator as another repo's formatting detail; `dischargeCancel` rendering `[block:` under a different sentence; the instruction about where to inject a reset to produce the token form). The 2026-10-28 fact that no degraded-cohort case produced a live aggregate is kept. The accepted-tradeoff `NOTE:` — a promise-phase rejection carried inside the aggregate is claimed on the wrapper alone, re-decided 2026-09-17 — stays unchanged in substance, reworded from "claims the wrapper" to "claims the phase". The veto carries a one-sentence fail-closed statement: the claims and the veto rest on the same `instanceof`, so the veto can only be blind where the claims are blind too.

**The scenario guard** — `expectAggregateCarriesBatchToken` is now `expectAggregateCarriesTypedLink`, and takes the error rather than the chain text: when the chain's text contains `Some peers did not complete:`, the chain must carry a `PeersIncompleteError` link. The risk it covers changed from an upstream reformat of the per-peer details to a future wrapper dropping `cause`. It reads the chain through a new `errorChainLinks(error): Error[]` beside `errorChainText` in `packages/integration-tests/src/harness/error-chain.ts` — same walk, same cycle guard.

**The doc** — `docs/cadre/control-replication.md` → "What is never retried, and why", the indeterminate-commit bullet: the phase comes from a field on the error, and what fails closed is the error class not arriving, not a rewording. The "What is retried" bullet was already accurate and is untouched.

## The one intentional behaviour change

**An aggregate with EMPTY per-peer details is now retried when its phase is `get` or `pend`.** It used to be declined, because the batch token was the only evidence of phase and no details meant no token. `phase` is on the error whether or not a batch formatted, so such a failure is now attributable, and `get`/`pend` is itself the proof that nothing committed. The spec case that pinned the decline is inverted, with its reasoning rewritten (`retries a get-phase aggregate whose per-peer details came out empty`).

Nothing else about the verdict table moves: a `commit` aggregate is still vetoed anywhere on the chain, a `cancel` aggregate is still neither claimed nor vetoed and falls through unmatched, and the aggregate as plain text with no typed link is claimed by nothing on either path.

## Validation run

All in the foreground, all green:

- `npx tsc -p packages/cadre-core/tsconfig.typecheck.json --noEmit` (src + test) — clean.
- `npx tsc -p packages/integration-tests/tsconfig.json --noEmit` — clean.
- `yarn workspace @serfab/cadre-core test` — **200 files, 2695 passed, 1 skipped**. The skip is pre-existing (nothing in this diff adds or loosens one). Log: `tickets/.logs/2-debt-control-retry-matches-the-transactor-aggregate-by-phase.test.log`.
- The three edited specs together: 112 passed.
- `yarn lint` (ESLint + `yarn check:docs`) — clean, 66 Markdown files OK.

**The typed link survives the real engine.** The ticket asked for this to be run rather than reasoned about, and it was: `control-read-retry.spec.ts`'s `ControlDatabase — read retry` block and `control-write-lock.spec.ts` drive a typed `PeersIncompleteError` through a real `ControlDatabase` (a `CadreNode`-owned one with the inner Quereus `eval` monkeypatched to fail during iteration), not through the classifier directly. The load-bearing cases pass: `absorbs one transient failure mid-iteration and answers on the second attempt`, `does not retry a read inside a locked write body on its own`, `lets a queued write run while an earlier write sleeps out its retry backoff`, `notifies membership once for a retried mutation and never on exhaustion`. No Quereus wrapper on those paths flattens the error.

**Not run:** `control-write-degraded-cohort-member.integration.ts`. It boots a real trio and one of its cases alone takes ~84 s for a single write, so the whole file is measured in minutes — outside what a ticket should run. It is the LIVE guard for this change (the renamed `expectAggregateCarriesTypedLink`, plus the two `isRetriableControlWriteFailure(outcome.error)` assertions already there), and a human or CI should exercise it. Note that on Optimystic 1.20.0 none of its cases produced a live aggregate at all, so the guard can pass without ever seeing one — that fact is recorded in the source.

## What to look at first

**Fixtures became factory functions, not constants.** Every aggregate literal in the three specs is now a lowerCamelCase factory (`transactorAggregate()`, `commitPhaseAggregate()`, `aggregateWithoutDetails()`, `cancelDischargeAggregate()`, `shortfallInPendAggregate()`, `shortfallInCommitAggregate()`, `rejectionInPendAggregate()`), matching the `shortfall()` / `tornWrite()` / `lostUpdate()` convention already in those files. Functions rather than module constants because `never retries a chain that reports a commit-phase aggregate at ANY level` mutates `.cause` on the links it builds — a shared constant error object would leak that mutation into every later case.

**Where the captured literals went.** The ticket asked to keep the captured literals as the record. They are kept as the factory's `details` argument plus the provenance comment ("a real captured message… do not shorten the details to a placeholder: they are the record"), not duplicated a second time as a quoted string in the comment: upstream's factory composes the sentence and the `; root: …` tail around those details, so the captured line is still reproducible byte for byte from the code. If the reviewer wants the full line quoted in the comment as well, that is a one-line-per-fixture addition.

**Two cases that collapsed into one.** Retyping made `keeps the pend/commit split over a typed shortfall chained below the aggregate` and `separates the pend- and commit-phase forms of the SAME super-majority shortfall` the same assertion — the typed aggregate now carries the typed shortfall as its `cause` by construction. They are merged into the second, driven over three delivery depths (bare, the decoy chain, the real `Failed to execute DDL:` wrapper chain), with both comments' reasoning kept. The merged case is also where the now-resolved "seam between this change and the next one" note lived.

**The get-plus-commit chain case.** The ticket asked for the both-tokens-in-one-message case to be replaced by a `get` aggregate and a `commit` aggregate on one chain. Retyping `never retries a chain that reports a commit-phase aggregate at ANY level` produces exactly that, in both orders, over both the aggregate claim and the shortfall claim — so the replacement lives there rather than in a new near-duplicate case, and its comment says so. Confirm that reading.

**Three cases now pin something weaker, as the ticket predicted.** `never retries a non-final torn write whose detail embeds a pend-phase aggregate`, the aggregate-bearing arm of `never retries a SyncRetryExhaustedError, whatever its last reason says`, and `never retries a partial commit whose failure is a pend-phase aggregate` existed to pin the typed veto beating the *text* matcher. Aggregate text is claimed by nothing now, so they pin that the veto still declines a chain whose message reads retriable. Kept, with comments saying exactly that. The partial-commit one notes it would pin the stronger property again the day upstream starts chaining its `reason` on `cause`.

**One edit outside the ticket's file list.** `control-retry.ts`'s `chainMessages` doc comment said it was "the substrate both retry classifiers match their text matchers against (the transactor's aggregate and the coordinator's shortfall are plain `Error`s, recognisable only by text)". Both halves became false with this change, and the read classifier no longer calls it at all, so the paragraph was rewritten to name its real remaining callers (the schema-init refusal matcher and `ControlDatabase`'s own message probes). `chainMessages` stays exported — `control-database.ts`, `member-redemption.ts` and `matchesRetriableFailure` all still use it. `isUncommittedTransactorAggregate` changed signature and is still exported from `control-write-retry.ts` but not from the package root; nothing outside the two retry modules calls it.

## Tests

No new spec file, and the net count moved by one. Each change:

- **changed** `retries a get-phase aggregate whose per-peer details came out empty` (was `never retries an aggregate whose phase cannot be told from its details`) — the one intentional behaviour change, with its reasoning rewritten; its second arm (one message carrying both tokens) cannot exist now that one error carries one phase.
- **added** `never retries the aggregate sentence as plain text — the claim is by type`, in the write spec and again in the read spec — the assertion that reddens if a text fallback for the aggregate is ever reintroduced. Mirrors the shortfall's equivalent case from the prereq ticket, and `control-read-retry.spec.ts`'s existing one for `BlockUnavailableError`.
- **removed** `keeps the pend/commit split over a typed shortfall chained below the aggregate` — merged into the pend/commit case above, which now covers its deliveries.
- **retyped, same behaviour pinned** every other aggregate case in the three specs, plus the write spec's two `agrees with the default classifier on every other failure` tables (the empty-details fixture moved to the retriable column; the commit and cancel aggregates joined the non-retriable one, so both columns still exercise an aggregate).

No test was added for anything a type already enforces: `PeersIncompleteError.peersDidNotComplete` refuses `'cancel'` by type, and `PeersIncompleteError.errors` holding the same root cause as `cause` is covered by inspection (`causeChain` walks `cause` only, so no link is counted twice and no claim is reachable through `errors`).

## Noticed and parked

**Upstream's own comments are now stale.** `PeersIncompleteError`'s class doc and the `NOTE:` above the commit site in `network-transactor.ts` both still describe this repo's classifier as pairing the sentence `Some peers did not complete:` with the `[block:` / `[blocks:` token, and call the plural token "load bearing" for sereus. It is not, as of this change — sereus reads `phase`. Sibling repositories are read-only from here (`tickets/rules/sibling-repos.md`), so nothing was edited there. This is a note for whoever owns optimystic, not work in this repo; the `Exclude<TransactorPhase, 'cancel'>` type guard those comments justify is still worth keeping regardless of what sereus reads.
