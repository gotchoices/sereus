description: Sereus works out which stage of a failed network write an Optimystic error came from by looking for a bracketed word in the message. Optimystic now says which stage in a field on the error, so read the field and stop reading the message.
prereq: debt-control-write-retry-matches-the-shortfall-by-type
architecture: docs/cadre/control-replication.md#control-write-retry
files: packages/cadre-core/src/control-write-retry.ts (`TRANSACTOR_AGGREGATE`, `SINGLE_BLOCK_BATCH_TOKEN`, `COMMIT_BATCH_TOKEN`, `isUncommittedTransactorAggregate`, `reportsIndeterminateCommit`, `matchesRetriableFailure`, `RETRIABLE_CONTROL_WRITE_MATCHERS`), packages/cadre-core/src/control-read-retry.ts (`isRetriableControlReadFailure` and the module comment), packages/cadre-core/test/control-write-retry.spec.ts, packages/cadre-core/test/control-read-retry.spec.ts, packages/cadre-core/test/control-write-lock.spec.ts (`transientClusterFailure`), packages/integration-tests/src/scenarios/control-write-degraded-cohort-member.integration.ts (`expectAggregateCarriesBatchToken`), packages/integration-tests/src/harness/error-chain.ts, docs/cadre/control-replication.md, ../optimystic/packages/db-core/src/transactor/peers-incomplete-error.ts (upstream, read-only)
difficulty: medium
----
# Match the transactor aggregate by phase

`NetworkTransactor` composes a `Some peers did not complete:` aggregate from four sites, and which site raised it decides whether this repo may re-present the write: a read (`get`) or a promise round (`pend`) failed before anything committed, so the write is known not to have landed; a commit (`commit`) may have landed with only the reply lost; a cancel (`cancel`) is a different sentence entirely. Today `control-write-retry.ts` tells them apart by pairing the sentence with the bracketed token the per-peer detail renders — `[block:` for a single-block batch, `[blocks:` for a multi-block one.

From Optimystic 1.29.0 all four are `PeersIncompleteError` (`@optimystic/db-core`, exported through `src/transactor/index.ts`) with `phase: 'get' | 'pend' | 'commit' | 'cancel'`. Upstream's comment on the class names this repo's classifier as the consumer and says to read `phase`. This ticket does that, and with it the last upstream message text leaves the control-retry funnel.

`prereq:` is the shortfall ticket because it lands the typed-chain spec builders this one reuses and settles the `rejections`/veto-ordering question these fixtures sit on top of.

## The source changes

In `control-write-retry.ts`:

- `isUncommittedTransactorAggregate` takes `links: readonly Error[]` instead of a `message: string`, matching the shape of the other chain predicates (`reportsPossiblyStoredWrite`, `reportsUnreachableCohort`), and answers `links.some(link => link instanceof PeersIncompleteError && (link.phase === 'get' || link.phase === 'pend'))`. It moves out of `RETRIABLE_CONTROL_WRITE_MATCHERS` and into `matchesRetriableFailure`'s typed-claim predicate, beside `reportsUnreachableCohort`, the final torn write and the shortfall the prereq ticket put there.
- `reportsIndeterminateCommit` takes `links` too and vetoes on `link instanceof PeersIncompleteError && link.phase === 'commit'`.
- Delete `TRANSACTOR_AGGREGATE`, `SINGLE_BLOCK_BATCH_TOKEN` and `COMMIT_BATCH_TOKEN`.
- `RETRIABLE_CONTROL_WRITE_MATCHERS` is then empty. Keep the constant: it is what `RETRIABLE_SCHEMA_INIT_MATCHERS` spreads, so the "widened, not replaced" relation between the two policies stays expressed in code, and a future text matcher has one obvious home. Its comment should say the default write policy is now entirely typed and that the only text matcher left in the module is the schema-init self-coordination refusal, which comes from `@optimystic/db-p2p`, not from the transactor.
- `matchesRetriableFailure` no longer needs `chainMessages` for the veto; it still needs it for the schema-init matcher list.

In `control-read-retry.ts`, `isRetriableControlReadFailure` calls the same predicate over the chain it already builds for `reportsUnreachableCohort`, so it walks the chain once and drops its `chainMessages` import.

**Keep one shared predicate claiming `get` and `pend`, rather than a narrower read-side one.** A control read cannot produce a `pend` aggregate — it presents no transaction — so claiming the phase there is unreachable, not unsafe, and one predicate is one thing to keep correct. The existing comment already makes exactly this argument for sharing the matcher verbatim; keep it and say the same about the phase.

## Comments that stop being true

`isUncommittedTransactorAggregate` carries three `NOTE:`s the type retires, and one it does not:

- The discriminator being another repo's formatting detail, and failing closed on a reformat: gone. What can still fail closed is a wrapper dropping `cause`, which is a different risk with a different guard (see the scenario change below), and it belongs in one sentence, not three paragraphs.
- `dischargeCancel` rendering `[block:` under a different sentence: gone. `phase: 'cancel'` cannot be confused with `'get'` or `'pend'`, so there is nothing to keep apart by conjunction.
- The 2026-10-28 observation that none of the degraded-cohort cases produced the `[block:` form: keep the fact (the guard can pass without seeing a live aggregate), drop the instruction about where to inject a reset to produce one, which was about the token.
- The accepted-tradeoff `NOTE:` — that a promise-phase rejection carried inside the aggregate is claimed on the wrapper alone, whatever the cause inside says — **stays**, unchanged in substance. It is a human decision about re-presenting rejections, re-decided on 2026-09-17, and nothing here revisits it. It only needs its wording moved from "claims the wrapper" to "claims the phase".

The module header's "Classifies the transient cases by MESSAGE" paragraph on `isRetriableControlWriteFailure`, and `control-read-retry.ts`'s "The transactor's aggregate is matched by TEXT, since upstream raises it as a plain `Error`", both become wrong and must be rewritten.

## The one intentional behaviour change

An aggregate whose per-peer details came out EMPTY is declined today and claimed after this change, when its phase is `get` or `pend`. The old reasoning — "an unattributable failure is not a proven non-commit" — was a consequence of the token being the only evidence of phase: with no details there was no token, so the phase was unknown. `phase` is on the error whether or not any batch formatted, so such a failure is now attributable, and `get`/`pend` is precisely the proof that nothing committed. The spec case that pins the decline (`never retries an aggregate whose phase cannot be told from its details`) inverts, with its reasoning rewritten; do not leave it asserting the old verdict.

The second half of that same case — a message carrying both tokens — cannot be built any more: one `PeersIncompleteError` has one phase. Replace it with a `get` aggregate and a `commit` aggregate on the same chain, which must stay declined.

## Why dropping the text veto is safe

A veto that fails to fire is the unsafe direction, so the question is what happens when `instanceof PeersIncompleteError` does not match. Two ways that can happen:

- **A wrapper between the raise site and this funnel drops `cause`.** Then every link below it is gone too, including the aggregate's own cause — so there is nothing left on the chain for any typed claim to match either, and the write is not retried. Every wrapper on the real path was read and keeps `cause`: the plugin's `rewrapAsQueryError`, Quereus' module-create wrapper, its `Failed to execute DDL:` wrapper and `throwFailedApply` (the paths are named in the prereq ticket). The residual risk is a future wrapper, which the scenario guard below turns into a red assertion.
- **A second loaded copy of `@optimystic/db-core`.** Then no `instanceof` against that package matches — which, after this change, is every claim the default write classifier makes and the only claim the read classifier makes. Nothing is retried, so a veto that does not fire has nothing to veto. The one text claim left in the module is the schema-init self-coordination refusal, raised by `db-p2p`'s `findCoordinator`; on the commit path it is thrown out of `commitBlocks` from the batch assembly that sits *outside* the try that composes the aggregate (`network-transactor.ts`, `batchesForPayload` at ~1389), so it normally arrives with no aggregate wrapper at all — which is what the `SCHEMA_INIT_RETRY_POLICY` comment already says. The exception is the per-block retry re-resolution inside `processBatches`, where such a throw does become the commit aggregate's `rootCause`; there the typed veto fires in the single-copy world this repo actually links.

Put that in the source as the fail-closed sentence on the veto, not as an essay: the claims and the veto share one `instanceof`, so the veto can only be blind where the claims are blind too.

## The spec fixtures

Every fixture that is an aggregate message literal becomes a real `PeersIncompleteError`. The constructor is private; the two static factories are `PeersIncompleteError.peersDidNotComplete(phase, details, cause?)` — which refuses `'cancel'` by type — and `PeersIncompleteError.cancelNotDischarged(actionId, outstanding, details, cause?)`. The factories compose the same messages the literals hold, so assertions elsewhere that match the sentence keep passing.

- `control-write-retry.spec.ts`: `TRANSACTOR_AGGREGATE`, `TRANSACTOR_AGGREGATE_COMMIT_PHASE`, `TRANSACTOR_AGGREGATE_NO_DETAILS`, `CANCEL_DISCHARGE_AGGREGATE`, `SUPER_MAJORITY_IN_PEND_AGGREGATE`, `SUPER_MAJORITY_IN_COMMIT_AGGREGATE` and `PROMISE_PHASE_REJECTION_IN_PEND_AGGREGATE`. The two shortfall-carrying ones pass the typed `PromiseShortfallError` the prereq ticket introduced as the factory's `cause`, which is what the real chain carries.
- `control-read-retry.spec.ts`: its own `TRANSACTOR_AGGREGATE`, `TRANSACTOR_AGGREGATE_COMMIT_PHASE` and `transientClusterFailure`.
- `control-write-lock.spec.ts`: `transientClusterFailure`.

The captured literals in those fixtures' comments are evidence of what the wire produced and several say "do not restore this from a paraphrase" — keep the literals quoted in the comments where they are the record, even where the fixture itself is now built from the factory.

Add, in both the write and read specs: the same aggregate as plain text is no longer claimed. That is the assertion that fails if a text fallback is ever reintroduced, and `control-read-retry.spec.ts` already pins the equivalent for `BlockUnavailableError`.

`control-write-lock.spec.ts` and the end of `control-read-retry.spec.ts` drive the typed error through a real `ControlDatabase` with a rigged `eval`, not through the classifier directly. Those are the cases that prove the typed link survives the engine, so **run them** rather than reasoning about them; if a Quereus wrapper on that path flattens the error, that is a finding about the production path, not about the rig, and it belongs in the handoff.

## The scenario guard

`expectAggregateCarriesBatchToken` in `control-write-degraded-cohort-member.integration.ts` exists to turn an upstream reformat of the per-peer details into a red assertion instead of a silently disabled retry. The reformat risk is gone; the risk that replaces it is a wrapper losing `cause`, so the guard becomes: when the chain's TEXT contains `Some peers did not complete:`, the chain must carry a `PeersIncompleteError` link. Rename it for what it now checks.

It needs the chain as objects, not as text. `packages/integration-tests/src/harness/error-chain.ts` already walks the chain for `errorChainText`; add an `errorChainLinks(error): Error[]` beside it over the same walk rather than a second traversal in the scenario.

Note the adjacent backlog ticket `debt-degraded-member-scenario-sometimes-loses-the-conflict-race`: it is about the *text* assertion on the shortfall sentence a few lines below this guard, and about the file's `afterEach`. Different sites, different root cause — do not fold it in.

## The doc

`docs/cadre/control-replication.md` → "What is never retried, and why" says of the indeterminate commit: "The classifier tells the phases apart by the error's text, so a rewording upstream disables the retry and never makes it unsafe." Both halves change: the phase comes from a field on the error, and what fails closed is the error class not arriving, not a rewording. The "What is retried" bullet naming "the transactor's 'some peers did not complete' error from the read and promise phases" stays accurate as written.

## Edge cases & interactions

- **Empty details at `get`/`pend`.** Now claimed. The one intentional behaviour change; spec case inverted with new reasoning (see above).
- **`phase: 'cancel'`.** Never claimed and never vetoed, so an undischarged cancel falls through unmatched exactly as today. Spec case, retyped from `CANCEL_DISCHARGE_AGGREGATE` through `cancelNotDischarged`.
- **A `commit` aggregate anywhere on the chain, in either order.** Vetoed, whatever else on the chain looks transient. The existing "at ANY level" case retyped, driven over both the aggregate claim and the shortfall claim as it is today.
- **A `get` and a `commit` aggregate on one chain.** Declined — the veto runs before every claim. Replaces the both-tokens-in-one-message case.
- **The aggregate as plain text.** Not claimed, on either the write or the read path. Spec cases.
- **A possibly-stored failure whose message embeds an aggregate.** `reportsPossiblyStoredWrite` already runs first and is already typed, and the embedded text can no longer be claimed at all, so the `describe.each(WRITE_CLASSIFIERS)` cases that exist to pin the veto beating the *text* matcher now pin something weaker. Keep them — they still pin the veto ordering — and say in their comments that the text is no longer claimable on its own.
- **`PeersIncompleteError.errors`.** The class sets an `AggregateError`-shaped `errors` array holding the same root cause as `cause`. `causeChain` walks `cause` only, so no link is counted twice and no claim is reached through `errors`. By inspection; no test.
- **The typed link surviving the engine.** Verified by running the two specs that drive a rigged `eval` through a real `ControlDatabase`, and guarded live by the renamed scenario assertion.
- **A second loaded copy of `@optimystic/db-core`.** Claims and veto go blind together, so nothing is retried. Fail-closed; stated in the source, not tested.
- **The read classifier's phase set.** Claims `get` and `pend` through the shared predicate; `pend` is unreachable from a read. By inspection, recorded in the comment that already explains the sharing.
- **Dead imports and exports.** `chainMessages` loses its read-side caller and its veto caller; confirm it is still used by the schema-init matcher loop before leaving it exported. `isUncommittedTransactorAggregate` changes signature and is exported from `control-write-retry.ts` but not from the package root — confirm nothing outside the two retry modules calls it.

## TODO

- Read `../optimystic/packages/db-core/src/transactor/peers-incomplete-error.ts` and confirm the installed 1.29.0 `dist` exports `PeersIncompleteError` and `TransactorPhase` from the package root.
- Retype `isUncommittedTransactorAggregate` and `reportsIndeterminateCommit` onto `links` and `phase`; move the former into `matchesRetriableFailure`'s typed-claim predicate; delete `TRANSACTOR_AGGREGATE`, `SINGLE_BLOCK_BATCH_TOKEN` and `COMMIT_BATCH_TOKEN`; leave `RETRIABLE_CONTROL_WRITE_MATCHERS` empty with a comment saying why it stays.
- Rewrite the comments named under "Comments that stop being true", keeping the accepted-tradeoff `NOTE:` in substance and adding the one-sentence fail-closed statement on the veto.
- Point `isRetriableControlReadFailure` at the shared predicate over the chain it already builds; drop its `chainMessages` import and correct its module comment.
- Retype the aggregate fixtures in `control-write-retry.spec.ts`, `control-read-retry.spec.ts` and `control-write-lock.spec.ts` through the two static factories, chaining the typed shortfall where the fixture carries one; keep the captured literals quoted in the comments that are the record of them.
- Invert the empty-details case with its new reasoning; replace the both-tokens case with a `get`-plus-`commit` chain; add the text-only cases to both specs.
- Add `errorChainLinks` beside `errorChainText` in `packages/integration-tests/src/harness/error-chain.ts`; rename and rewrite the scenario guard to require a typed link whenever the chain text shows the aggregate sentence.
- Correct the indeterminate-commit bullet in `docs/cadre/control-replication.md`.
- Run `yarn workspace @serfab/cadre-core typecheck` and `yarn workspace @serfab/cadre-core test` in the foreground, then `yarn lint` (which includes `yarn check:docs`). The degraded-cohort scenario is an integration test measured in minutes — do not run it inside this ticket; say so in the handoff and name it as the live guard a human or CI exercises.
