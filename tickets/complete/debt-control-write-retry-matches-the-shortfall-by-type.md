description: When too few machines answer a control write, Sereus used to work out what happened by reading the error's wording. It now checks the error's type instead, so a reworded sentence upstream cannot quietly change which writes get a second try.
architecture: docs/cadre/control-replication.md#control-write-retry
files:
  - packages/cadre-core/src/control-retry.ts (`reportsUnansweredShortfall` — the shared predicate, added in review)
  - packages/cadre-core/src/control-write-retry.ts (`matchesRetriableFailure`, `RETRIABLE_CONTROL_WRITE_MATCHERS`; `SUPER_MAJORITY_SHORTFALL_UNANSWERED` removed)
  - packages/cadre-core/src/edge-node/strands.ts (`isTransientWriteFailure`)
  - packages/cadre-core/test/control-write-retry.spec.ts (`shortfall`, `ddlChain`, `nested`, the `*_FACTS` constants)
  - packages/cadre-core/test/edge-node/strands.spec.ts (`superMajority`)
  - docs/cadre/control-replication.md ("What is never retried, and why"), packages/cadre-rn/README.md ("Helpers")
  - ../optimystic/packages/db-core/src/network/promise-shortfall-error.ts (upstream, read-only)
----

# What landed

Both places that decide whether to present a control write again when too few cohort members answered now test for Optimystic's `PromiseShortfallError` with `rejections === 0`, instead of matching the sentence `Failed to get super-majority: …`. Upstream's own comment on that class asks consumers to do exactly this. The installed `@optimystic/db-core` 1.29.0 exports the class from the package root, and the message it composes is byte-identical to the literals that were removed, so every assertion on that sentence elsewhere in the tree still holds.

The two places are the control-write classifier (`control-write-retry.ts`, behind `ControlDatabase.lockedWithRetry`) and the edge node's `retryAfterRestart` — the helper an app wraps its first writes after a lone restart in. They share **one** predicate, `reportsUnansweredShortfall` in `control-retry.ts`, which sits beside `reportsUnreachableCohort`, the typed claim the read and write classifiers already shared. The implement stage left the predicate duplicated in both modules with a comment in each saying they must not drift apart; this review made that claim structural instead (see below).

What the shared predicate decides is only that the promise round went *unanswered*. Where that leaves the write stays with each caller: the control funnel still vetoes a shortfall carried by a commit-phase batch (`[blocks:`), because a commit may have landed with only the reply lost, and the edge-node helper has no transactor aggregate around an app's own write to read a phase off.

Two behaviour changes at the edge-node site, both deliberate and both narrowings:

- a shortfall carrying a rejection is no longer retried — a member voted no, and that verdict is the control funnel's line too, which the two must not differ on;
- a non-`Error` throw is no longer retried — it can carry no typed link, and this helper sleeps 3 s between five attempts, so claiming one on its text would spend 12 s before the identical failure.

A lone node's own refusal to write by itself is still claimed: `CoordinatorRepo.refuseSoloPend` builds the shortfall with `approvals: 1, rejections: 0` and `soloRefused` naming why, so it carries a zero rejection count like any silent-cohort shortfall. Nothing branches on `soloRefused`.

Out of scope and untouched: the transactor's aggregate is still matched by text (`Some peers did not complete:` paired with the `[block:` / `[blocks:` token), which is what `2-debt-control-retry-matches-the-transactor-aggregate-by-phase` retires — and which empties `RETRIABLE_CONTROL_WRITE_MATCHERS`, down to one entry after this change.

# Review findings

## Checked

Read the implement diff (`ticket(implement): debt-control-write-retry-matches-the-shortfall-by-type`) before the handoff summary, with the handoff's own warning in mind that the diff came from two concurrent runner processes on one ticket rather than a single authoring pass. Everything below was re-derived from the code rather than taken from that summary.

**The claim's position and the vetoes above it.** `reportsUnansweredShortfall` is asked after `reportsPossiblyStoredWrite` (typed) and `reportsIndeterminateCommit` (text), so a shortfall under a `SyncRetryExhaustedError`, a non-final `TornActionError`, either partial-commit error or a commit-phase `[blocks:` token is still declined. The specs drive the commit-phase split both ways — aggregate as text with a typed shortfall below it, bare and through the DDL wrapper chain.

**That the walk did not change reach.** The claim moved from `chainMessages` (Quereus' `unwrapError`) to `causeChain`. Read `unwrapError` (`quereus/src/common/errors.ts`): it follows `.cause` and nothing else, exactly as `causeChain` does, so the two walks reach the same links — `causeChain` additionally stops at a cycle and at a non-`Error` link. No shape that was claimed before is unclaimed now.

**That the typed link actually survives to both funnels.** Traced every wrapper between the raise sites and the callers and confirmed each passes the inner error as `cause`: the optimystic plugin's `rewrapAsQueryError` (`optimystic-module.ts`), Quereus' statement-execution rewrap (`statement.ts`, which passes `e instanceof Error ? e : undefined`), its module-create wrapper and its DDL wrapper, and upstream's own `PeersIncompleteError`, which sets both `cause` and `errors`. Also confirmed the typed error survives the wire: a coordinator returns the facts as a `ShortfallFailure`, `NetworkTransactor.refusalFrom` forwards that refusal verbatim, and both write paths rebuild the class from it (`TransactionCoordinator`, `Collection`'s `write-attempts.ts`).

**That no other site in the repo still matches this failure by text.** Swept every `super-majority` / `PromiseShortfall` reference in `packages/`. The remaining hits are prose, scenario assertions on a sentence upstream keeps, and one neighbouring classifier — `isSchemaRefusal` in `quereus-plugin-sereus/src/app-schema.ts` — which was already typed (it tests `QuereusError` codes and names `PromiseShortfallError` only as an example of what is *not* one). Nothing was missed.

**Docs against the new reality.** Read every doc the change touches and the ones it should have: `docs/cadre/control-replication.md` ("Control-write retry" and its limits section), `docs/network/strand-addressing.md`, `packages/cadre-rn/README.md`. Two were stale after the change; both fixed below. The replication doc's "An indeterminate commit" bullet, which says the phases are told apart by text, is still correct — that veto is the follow-on ticket's.

**Source hygiene.** `control-retry.ts` 376 lines, `control-write-retry.ts` 649 (down from 668), `edge-node/strands.ts` 89, `control-write-retry.spec.ts` 1,424 (`wc -l`). No split warranted; the write-retry module is long because each case carries its reasoning, which is where that reasoning belongs. No comment in the diff narrates a statement — all of them carry a why or a constraint.

**Validation.** `yarn lint` (ESLint + `check:docs`, 66 Markdown files) clean. `yarn typecheck` across all workspaces clean, including the coverage and stale-build-guard checks. `yarn workspace @serfab/cadre-core test`: **200 files, 2,694 passed, 1 skipped, 0 failed** (422 s). The two failures the implement stage reported in `control-database-solo-warm-start.spec.ts` did not recur — that file passes in a full uncontended run, which confirms the `one-off` load diagnosis already recorded in `tickets/.pre-existing-known.md`. Nothing was added to or changed in that record. No integration scenario was run: a real shortfall needs a multi-node cluster, and `control-write-degraded-cohort-member` runs past the per-ticket time budget. It stays the first thing to run if anything here is doubted.

## Found and fixed in this pass

**The two sites repeated the predicate instead of sharing it.** `isUnansweredShortfall` lived unexported in `control-write-retry.ts` and the same `link instanceof PromiseShortfallError && link.rejections === 0` was written again inline in `strands.ts`, each with a comment pointing at the other — a "must not drift apart" claim held up by prose. Extracted to `reportsUnansweredShortfall` in `control-retry.ts`, the module that already owns the typed claim two classifiers share (`reportsUnreachableCohort`), with the same `readonly Error[]` signature. Both call sites now ask it. The write funnel's veto-ordering reasoning stayed at its use site, where it applies; what the funnel does *not* share with the edge-node helper is now stated at each end rather than implied. Not public API: only `control-retry.ts`'s types are re-exported from the package index.

**The comment and two test docblocks justified the change with a widening that does not happen.** They said the old `describeThrown(err)` match "read the top-level message alone, so a shortfall under any wrapper … was silently not retried". Every wrapper on that path interpolates the inner message into its own (`rewrapAsQueryError`, the DDL and module-create wrappers, `PeersIncompleteError`'s `; root:` suffix), so the sentence *was* visible at the top level and the old match did fire. The real change at that site is the narrowing, plus independence from the wording. Rewritten in `strands.ts` and in the `retries a shortfall delivered under a wrapper` docblock, which now says what it actually pins. Worth correcting rather than leaving: a future reader weighing whether the retry still reaches a new wrapper would have drawn the wrong conclusion from it.

**The solo-refusal case claimed exhaustiveness it did not have.** It looped a hand-written array of the three `SoloRefusalReason` values and said "a future branch on one of them has to change this case" — but a fourth reason added upstream would have left it green and unasserted. Keyed off the union instead (`Record<SoloRefusalReason, true>`), so a new reason fails to compile here. The ladder's first rung: let the type carry the claim rather than a comment.

**`docs/cadre/control-replication.md` named a mechanism that no longer exists.** "No matcher claims … a shortfall that counts a rejection" — the shortfall is not a matcher any more. Reworded to the policy, with the reason it is now wording-independent.

**`packages/cadre-rn/README.md` promised more than the helper delivers.** `retryAfterRestart` was described as retrying "a write that fails for want of a super-majority", which a reader would reasonably take to include a shortfall a member voted against. It now says it retries a write the cohort did not *answer*, and that a rejection propagates on the first attempt — the public face of the narrowing above.

## Found and filed

None. Nothing surviving this pass serves a current-release anchor or names a class-level invariant: the behaviour is correct on the happy path, the edge cases (zero rejections at every approval count, a rejection, a solo refusal, every chain depth, both aggregate phases) and the error paths (budget exhaustion rethrows the last error unchanged), and the only remaining text match is the transactor aggregate, which `2-debt-control-retry-matches-the-transactor-aggregate-by-phase` already owns.

## Tripwires recorded

None added. The two conditional concerns this change carries already have `NOTE:` tripwires at their sites, and both were kept and re-stated on the shared predicate rather than duplicated: a second loaded copy of `@optimystic/db-core` fails `instanceof` and the shortfall is then not claimed (fail-closed, the same direction `reportsUnreachableCohort` accepts), and the chain's `cause` preservation is established by reading the wrappers, not by a test — if one ever stops passing `cause` the specs stay green and the retry silently stops engaging, with `control-write-degraded-cohort-member.integration.ts` as the real guard.

## Tests

Cut none; the implement stage's set earns its place. The three retyped tables (`agrees with the default classifier on every other failure`, twice, and the commit-phase veto at any level) each pin a named piece of the policy over real branching, and the new cases are the ones a reviewer would otherwise have had to add: that the sentence as plain text is *not* claimed (the assertion that reddens if a text fallback creeps back, mirroring what `control-read-retry.spec.ts` pins for `BlockUnavailableError`), that the typed link is claimed at every chain depth, and that the pend/commit split holds over a typed shortfall below the aggregate — the one case whose assertion is identical before and after the follow-on ticket, which is what makes it the seam worth having.

Added none. Both defects found in this pass were in comments and in a test's own exhaustiveness, not in behaviour; the second was fixed by making the existing case's claim structural rather than by adding a case beside it.
