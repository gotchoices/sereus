description: Sereus used to work out which stage of a failed network write an Optimystic error came from by looking for a bracketed word in the message; it now reads the stage from a field on the error instead. One kind of failure that used to be given up on immediately now gets a second attempt.
architecture: docs/cadre/control-replication.md#control-write-retry
files: packages/cadre-core/src/control-write-retry.ts, packages/cadre-core/src/control-read-retry.ts, packages/cadre-core/src/control-retry.ts, packages/cadre-core/test/control-write-retry.spec.ts, packages/cadre-core/test/control-read-retry.spec.ts, packages/cadre-core/test/control-write-lock.spec.ts, packages/integration-tests/src/harness/error-chain.ts, packages/integration-tests/src/scenarios/control-write-degraded-cohort-member.integration.ts, docs/cadre/control-replication.md
----
# The transactor aggregate is matched by phase, not by text

Optimystic 1.29.0 raises all four `NetworkTransactor` aggregates as one class, `PeersIncompleteError`, carrying `phase: 'get' | 'pend' | 'commit' | 'cancel'`. This repo's control-retry classifiers now read that field. With it, the last upstream message text leaves the control-retry funnel: the default control-write policy and the whole control-read policy are matched entirely by type. Implemented in `ticket(implement): debt-control-retry-matches-the-transactor-aggregate-by-phase`; reviewed here.

## What landed

- **The claim.** `isUncommittedTransactorAggregate` takes `links: readonly Error[]` (was a message string) and answers `links.some(link => link instanceof PeersIncompleteError && (link.phase === 'get' || link.phase === 'pend'))`. It moved out of the matcher list into `matchesRetriableFailure`'s typed claims, beside `reportsUnreachableCohort`, the super-majority shortfall and the final torn write.
- **The veto.** `reportsIndeterminateCommit` takes `links` too and vetoes on `phase === 'commit'`. `TRANSACTOR_AGGREGATE`, `SINGLE_BLOCK_BATCH_TOKEN` and `COMMIT_BATCH_TOKEN` are gone.
- **The empty matcher list, kept.** `RETRIABLE_CONTROL_WRITE_MATCHERS` is now an empty array. `RETRIABLE_SCHEMA_INIT_MATCHERS` spreads it, so the "widened, not replaced" relation between the two policies stays expressed in code, and a future text matcher has one home. The only text matcher left in the module is the schema-init self-coordination refusal, which comes from `@optimystic/db-p2p`, not from the transactor.
- **One chain walk each.** `matchesRetriableFailure` runs both vetoes off one `causeChain` walk and computes `chainMessages` only for the matcher list at the end; `isRetriableControlReadFailure` reuses the chain it already builds for `reportsUnreachableCohort`, so the read path walks once too and no longer imports `chainMessages`.
- **The live guard.** The degraded-cohort scenario's `expectAggregateCarriesBatchToken` is now `expectAggregateCarriesTypedLink` and takes the error rather than the chain text: when the chain's text contains `Some peers did not complete:`, the chain must carry a `PeersIncompleteError` link. The risk it covers changed from an upstream reformat of the per-peer details to a future wrapper dropping `cause`. It reads the chain through a new `errorChainLinks(error)` beside `errorChainText`.
- **The doc.** `docs/cadre/control-replication.md` → "What is never retried, and why", the indeterminate-commit bullet: the phase comes from a field on the error, and what fails closed is the error class not arriving, not a rewording.

## The one intentional behaviour change

**An aggregate with EMPTY per-peer details is now retried when its phase is `get` or `pend`.** It used to be declined, because the batch token was the only evidence of phase and no details meant no token. `phase` is on the error whether or not a batch formatted, so such a failure is now attributable, and `get`/`pend` is itself the proof that nothing committed.

Nothing else about the verdict table moves: a `commit` aggregate is still vetoed anywhere on the chain, a `cancel` aggregate is still neither claimed nor vetoed, and the aggregate as plain text with no typed link is claimed by nothing on either path.

## Review findings

### Checked

**The phase table against upstream.** Read `../optimystic/packages/db-core/src/transactor/peers-incomplete-error.ts` rather than trusting the handoff. The four phases and the two factories are as described, and `peersDidNotComplete` refuses `'cancel'` by type. `errors` is always exactly `[cause]`, so `causeChain` — which follows `cause` only — misses no link and counts none twice; no test was needed for that.

**The veto's narrowing.** The old veto matched the text `[blocks:` in any message; the new one requires a typed commit aggregate. Grepped the whole of optimystic: `[blocks:` is rendered at exactly one site, the commit aggregate's own per-peer details. So the narrowing is equivalent in practice and strictly more precise.

**Byte-identity of every retyped fixture.** The specs now compose each fixture through the upstream factory instead of carrying the captured literal, and the handoff claims the result reproduces the captured line byte for byte. Checked all five against the factories' format strings, including `PromiseShortfallError`'s sentence (`db-core/src/network/promise-shortfall-error.ts`) for the two shortfall-bearing ones. Every one reproduces its literal exactly, so the "do not shorten the details, they are the record" comments are telling the truth.

**Happy path, edge and error paths by running them.** Full `@serfab/cadre-core` suite, both typechecks, `yarn lint`. Plus a throwaway spec (deleted) driving the classifier over two chain shapes the committed specs do not build — see the two fixes below, both of which it confirmed.

**Docs.** Read every file the change touched and grepped `docs/` for the retired tokens and for any claim that the classifier reads text. `control-replication.md` is the only doc that describes this classifier, in the read-retry paragraph and the two write-retry bullets; all three now read correctly, and the one the implementer did not touch ("What is retried") was already phase-worded. No doc that should have been touched was missed.

### Found and fixed in this pass

**The commit veto's "fails CLOSED" claim was overstated, and the gap is real.** The doc said this veto and every claim rest on the same `instanceof`, so a chain the veto cannot see is one no claim can see either. That holds for the default and lost-update policies, whose claims are all typed — but schema init adds one matched by TEXT, and a commit aggregate raised over the self-coordination refusal embeds that refusal as its own `; root: …` tail. Ran it: such a chain delivered text-only (typed link dropped) is **retried** by `isRetriableSchemaInitFailure`, where the text veto this change replaced declined it. Then checked whether anything reaches it: all three Quereus wrappers on the schema-init path pass the inner error as `cause` (`schema-declarative.ts`'s DDL wrapper and `throwFailedApply`, `manager.ts`'s module-create wrapper), so nothing hits this today. Qualified the paragraph and recorded the rest as a `NOTE:` tripwire at the veto, with both revisit conditions: a wrapper that stops carrying `cause`, or the default policy growing a text matcher of its own.

**The `cancel` bullet read as a chain-level rule when it is a per-link one.** It said a `cancel` aggregate "falls through unmatched and is not retried", which a reader can take as "a chain reporting an undischarged cancel is never retried". Ran it: a cancel aggregate carrying a `get` one below it is claimed on that lower link. That is the right answer (nothing committed at either phase) and is what the text matcher did too, so no behaviour changed — but the comment now says so.

**`errorChainText` and the new `errorChainLinks` carried two copies of one walk.** The new helper's comment asserted "same walk, same cycle guard" while in fact using a different guard and differing on the non-`Error` tail. Made `errorChainText` build on `errorChainLinks` and name the tail explicitly, so the asserted shared walk is literally shared. Verified equivalent against the old implementation on 16 inputs first — cycles (self and two-link), non-`Error` tails, nullish and falsy causes, non-`Error` throws — because this helper backs assertions in eight integration scenarios that are too slow to run inside a ticket.

### Weighed and deliberately left

**Moving `isUncommittedTransactorAggregate` into `control-retry.ts`.** It is now the same kind of shared typed chain predicate as `reportsUnreachableCohort` and `reportsUnansweredShortfall`, which both live in the shared module — and it is why `control-read-retry.ts` imports the write module at all. Left where it is: it is one half of the phase table and the other half (`reportsIndeterminateCommit`) has to stay with the write policy, so splitting the table across two files would cost more cohesion than the one import costs.

**Cutting two now-weaker spec cases.** `never retries a non-final torn write whose detail embeds a pend-phase aggregate` and `never retries a partial commit whose failure is a pend-phase aggregate` are, with aggregate text claimed by nothing, near-duplicates of the plainer case above each of them. Kept: both re-acquire their stronger meaning — the veto beating a claim — the moment any text claim for the aggregate returns, which the module still has a matcher list for; and the new plain-text cases pin the absence of the claim, not the ordering of veto against claim.

**The duplicated fixtures.** `transactorAggregate()` exists byte-identically in the write and the read spec, and `transientClusterFailure()` in the read and the lock spec. Pre-existing (two copies of one literal before, two factories now), each carrying a comment that points at its twin; hoisting three lines into a shared test module buys less than that cross-reference already does.

**Upstream's stale comments.** `PeersIncompleteError`'s class doc and the `NOTE:` above the commit site in `network-transactor.ts` still describe this repo as pairing the sentence with the `[block:` / `[blocks:` token, and call the plural token load-bearing for sereus. It is not, as of this change. Correctly parked by the implementer rather than edited — sibling repositories are read-only from here (`tickets/rules/sibling-repos.md`) — and the `Exclude<TransactorPhase, 'cancel'>` guard those comments justify is worth keeping whatever sereus reads.

### Tests

No new spec, and nothing cut. The two cases the implementer added (`never retries the aggregate sentence as plain text — the claim is by type`, once per path) pin the contract that no text fallback for the aggregate returns unnoticed, which is the one thing this change makes newly breakable; the inverted empty-details case pins the intentional behaviour change. Considered adding a case for the schema-init text/typed asymmetry found above and did not: it would pin a verdict we do not want, on a chain nothing can build today. The `NOTE:` is the record.

### Not filed

No major finding reached the filing bar. The one defect-shaped finding is conditional on a wrapper that does not exist (checked, not assumed), so it is a tripwire at the site rather than a ticket; the two modularity findings were weighed against their cost above and declined with reasons.

## Validation

All in the foreground, all green:

- `npx tsc -p packages/cadre-core/tsconfig.typecheck.json --noEmit` (src + test) — clean.
- `npx tsc -p packages/integration-tests/tsconfig.json --noEmit` — clean.
- `yarn workspace @serfab/cadre-core test` — **200 files, 2695 passed, 1 skipped**. The skip is `key-store.spec.ts`'s `skipIf(process.platform === 'win32')` POSIX-mode case, unrelated to this diff and not a failure; nothing here adds or loosens a skip.
- The three edited specs together, re-run after the comment edits: 112 passed.
- `yarn lint` (ESLint + `yarn check:docs`) — clean, 66 Markdown files OK.

**The typed link survives the real engine.** `control-read-retry.spec.ts`'s `ControlDatabase — read retry` block and `control-write-lock.spec.ts` drive a typed `PeersIncompleteError` through a real `ControlDatabase` (a `CadreNode`-owned one with the inner Quereus `eval` monkeypatched to fail during iteration), not through the classifier directly. The load-bearing cases pass, so no Quereus wrapper on those paths flattens the error.

**Not run:** `control-write-degraded-cohort-member.integration.ts`. It boots a real trio and one of its cases alone takes ~84 s for a single write, so the whole file is measured in minutes — outside what a ticket should run. It is the live guard for this change (`expectAggregateCarriesTypedLink` plus the two `isRetriableControlWriteFailure(outcome.error)` assertions), and it also exercises the `errorChainText` refactor, which is why that refactor was proven equivalent against the old implementation rather than left to this scenario. A human or CI should exercise the file. Note that on Optimystic 1.20.0 none of its cases produced a live aggregate at all, so the guard can pass without ever seeing one — recorded in the source.
