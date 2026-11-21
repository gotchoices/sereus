description: When too few machines answer a control write, Sereus currently works out what happened by reading the error's wording. Optimystic now raises that failure as its own error class, so check the class instead and stop depending on the exact sentence.
architecture: docs/cadre/control-replication.md#control-write-retry
files: packages/cadre-core/src/control-write-retry.ts (`SUPER_MAJORITY_SHORTFALL_UNANSWERED`, `isUnansweredSuperMajorityShortfall`, `RETRIABLE_CONTROL_WRITE_MATCHERS`, `matchesRetriableFailure`), packages/cadre-core/test/control-write-retry.spec.ts (the `SUPER_MAJORITY_*` fixtures, `nested`, `ddlFailure`), packages/cadre-core/src/edge-node/strands.ts (`SUPER_MAJORITY_FAILURE`, `isTransientWriteFailure`), packages/cadre-core/test/edge-node/strands.spec.ts (`superMajority`), packages/cadre-core/src/control-retry.ts (`causeChain`, imported, not changed), ../optimystic/packages/db-core/src/network/promise-shortfall-error.ts (upstream, read-only)
difficulty: medium
----
# Match the super-majority shortfall by type

Two places in this repo decide whether to re-present a write by testing whether an error message contains `Failed to get super-majority`. Optimystic raises that failure as `PromiseShortfallError` (`@optimystic/db-core`, exported through `src/network/index.ts`), carrying `approvals`, `rejections`, `peerCount`, `needed`, `silentPeers` and an optional `soloRefused`. Upstream's own comment on the class says to test for the class rather than the text. This ticket moves both sites onto the class.

The transactor's `Some peers did not complete:` aggregate is typed too, and retiring **its** text match is the follow-on ticket `debt-control-retry-matches-the-transactor-aggregate-by-phase`. Nothing here touches it: the aggregate's regex, its `[block:` / `[blocks:` tokens and `isUncommittedTransactorAggregate` stay exactly as they are, and the commit-phase veto (`reportsIndeterminateCommit`) still matches text. Keeping the two apart is deliberate — this ticket's diff is one upstream class and two call sites.

## Site 1: the control-write classifier

In `control-write-retry.ts`:

- Claim the shortfall in `matchesRetriableFailure`, beside the other typed claims that already run after both vetoes: a link that `instanceof PromiseShortfallError` with `rejections === 0`. The existing typed claim line is `reportsUnreachableCohort(links) || links.some(link => isFinalTornWrite(link) || claimsLink?.(link) === true)`; the shortfall belongs in that `links.some(...)` predicate, so it inherits the veto ordering rather than restating it.
- Delete `SUPER_MAJORITY_SHORTFALL_UNANSWERED` and `isUnansweredSuperMajorityShortfall`, and drop the latter from `RETRIABLE_CONTROL_WRITE_MATCHERS`. That list then holds `isUncommittedTransactorAggregate` alone until the follow-on ticket empties it.
- Move the surviving reasoning from the deleted regex's comment onto the new claim: that a non-zero rejection count means a member voted no (`membership-not-admitted`), so re-presenting it would re-present a spent signature; that a pend's shortfall reaches this funnel on its own before any commit, while a commit's arrives under the commit-phase aggregate the veto declines; and that both were seen live in `control-write-degraded-cohort-member`. Delete the `NOTE:` that pointed at this ticket, and the paragraph explaining why the regex could not match a decisive `ValidatorRejectionError` — a type match cannot confuse the two, so the paragraph has nothing left to rule out.

Why `rejections === 0` and not "any shortfall": unchanged from the regex it replaces, and still the right line. The class is raised when the promise round reached no verdict — too few approvals to pass and too few rejections to count as a rejection — so a non-zero `rejections` is a real member voting no, and no backoff changes that answer.

Why a type match is safe at this seam, and what happens when it is not: every wrapper between the raise site and this funnel keeps the error on `cause`, checked by reading each one — the optimystic plugin's `rewrapAsQueryError` (`quereus-plugin-optimystic/src/optimystic-module.ts`), Quereus' module-create wrapper (`quereus/src/schema/manager.ts`, the `Module '<m>' create failed for table '<T>'` throw), its DDL wrapper and its failed-apply rewrap (`quereus/src/runtime/emit/schema-declarative.ts`, the `Failed to execute DDL:` `QuereusError` and `throwFailedApply`). A second loaded copy of `@optimystic/db-core` would fail `instanceof` and the shortfall would simply not be claimed — the same fail-closed direction `reportsUnreachableCohort` and `isFinalTornWrite` already accept, and the same one the deleted regex had on a rewording. Say that on the claim, in one sentence, rather than repeating the full argument that already sits on `reportsPossiblyStoredWrite`.

## Site 2: the edge node's strand-write retry

`retryAfterRestart` in `src/edge-node/strands.ts` retries a strand write on `/Failed to get super-majority/i` over `describeThrown(err)`, which reads the top-level `message` and walks no `cause`. Replace `SUPER_MAJORITY_FAILURE` and `isTransientWriteFailure` with the same typed test the control write now uses: a `PromiseShortfallError` with `rejections === 0` anywhere on the `cause` chain, walked with `causeChain` imported from `../control-retry.js`.

That is deliberately two changes to its behaviour, and both are the point:

- **It widens.** A shortfall arriving under any wrapper — which is every shortfall that reaches an app through SQL — was silently not retried before, because `describeThrown` never looked below the top message. The helper's whole purpose is the first writes after a lone restart, and those are exactly the wrapped ones.
- **It narrows.** A shortfall with a rejection, and any non-`Error` throw, are no longer retried. The rejection argument is the control write's, and it should not differ between the two policies; a non-`Error` throw can carry no typed link, and this helper sleeps 3 s between five attempts, so claiming one on its text would be 12 s spent before the same failure.

A lone restart's own refusal is still claimed: `CoordinatorRepo.refuseSoloPend` builds the shortfall with `approvals: 1, rejections: 0` and `soloRefused` naming why (`absent-members`, `awaiting-bootstrap`, `unrouted`), so it has a zero rejection count like any silent-cohort shortfall. `soloRefused` is not read — do not branch on it.

Keep both sites together rather than splitting them: one upstream class, one decision about `rejections`, and two policies that must not drift apart on it.

Importing `causeChain` adds no new dependency to the `edge-node` entry — it already exports `createEdgeNode`, which loads `CadreNode` and with it Quereus and db-core. `control-retry.ts` does not import anything under `edge-node/`, so the direction stays acyclic.

## The spec fixtures

`control-write-retry.spec.ts` builds its shortfall cases as message literals through `nested(...)`. The four bare-sentence fixtures — `SUPER_MAJORITY_NONE_ANSWERED`, `SUPER_MAJORITY_PARTIAL`, `SUPER_MAJORITY_REJECTED`, `SUPER_MAJORITY_THIRD_NODE_JOIN` — become real `PromiseShortfallError` objects. Its constructor is public and takes the `PromiseShortfall` struct: `{ approvals, rejections, peerCount, needed, silentPeers }`. The message it composes is byte-identical to today's literals, so every `toMatch` on that sentence elsewhere keeps passing; a helper such as `shortfall({ approvals, peerCount, needed, rejections })` replaces the four constants and keeps each case readable.

`ddlFailure` returns a `string`, so a fixture built through it reaches the classifier as text with no typed link below it. Add a builder beside it that produces the real chain instead, mirroring the wrappers named above: a `QuereusError` whose message is `Failed to execute DDL: <ddl>\nError: <inner.message>` and whose `cause` is the inner error, optionally under the `Module '<m>' create failed for table '<T>'` wrapper the startup surface adds. Keep `ddlFailure` itself for the cases that are genuinely about text — the self-coordination refusal, whose matcher stays textual — so the two spellings say which mechanism each case exercises.

The `*_AGGREGATE` fixtures stay message literals in this ticket. Where one carries a shortfall, chain the typed error below the literal (`new Error(SUPER_MAJORITY_IN_PEND_AGGREGATE, { cause: shortfall(...) })`) so the assertion holds for the same reason it will after the follow-on ticket replaces the literal with a real `PeersIncompleteError`.

Two cases to add, neither of which exists today:

- The same sentence as plain text is no longer claimed, the way `control-read-retry.spec.ts` already pins it for `BlockUnavailableError`. This is the assertion that would catch a future edit quietly restoring a text fallback.
- A typed shortfall under the commit-phase aggregate is still declined. In this ticket the text veto fires; in the follow-on the typed one does. Same assertion either way, which makes it the seam between the two tickets.

`strands.spec.ts`'s `superMajority()` becomes a `PromiseShortfallError` too, with a wrapped delivery (the shortfall as the `cause` of an outer error) and a rejection-bearing case added.

## Not in scope

- `cadre-node-control-replication.spec.ts` injects `new Error('Failed to get super-majority')` as an arbitrary failure for a drain test; nothing classifies it. Leave it.
- The scenario and doc references to the sentence (`control-write-degraded-cohort-member.integration.ts` line ~1180 and its siblings, `docs/network/strand-addressing.md`) assert or describe the message, which upstream keeps unchanged. Leave them.
- `docs/cadre/control-replication.md` does not say how the shortfall is matched, so it needs no edit here. The sentence that does name text matching is about the commit-phase veto, and the follow-on ticket owns it.

## Edge cases & interactions

- **A rejection-bearing shortfall.** `rejections > 0` stays declined, at both sites. Spec case at each (the retyped `SUPER_MAJORITY_REJECTED`, and a new strands case).
- **The sentence as text only.** Not claimed any more. Spec case; this is the one that fails if a text fallback creeps back.
- **Depth.** The shortfall is claimed wherever it sits on the `cause` chain — bare (the shape measured live on 2026-10-28, a single-link chain), under Quereus' commit wrapper, and under the DDL and module-create wrappers. Spec cases through the new typed-chain builder; the wrappers' `cause` preservation is established by inspection above, not by a test of another repo's code.
- **A shortfall under the commit-phase aggregate.** Still vetoed. Spec case (see "The spec fixtures").
- **A shortfall under a possibly-stored failure.** `reportsPossiblyStoredWrite` runs before every claim, so a `SyncRetryExhaustedError`, a non-final `TornActionError` or either partial-commit error carrying a shortfall stays declined. Covered by inspection of the existing claim ordering — the new claim goes inside the same `links.some(...)` the vetoes already precede — and by the existing `describe.each(WRITE_CLASSIFIERS)` block, which needs no new case.
- **A solo refusal.** `approvals: 1, rejections: 0, soloRefused: <reason>` is claimed, unchanged from the regex's behaviour. One spec case, because it is the lone-restart shape `retryAfterRestart` exists for.
- **A non-`Error` throw, and a non-`Error` `cause` link.** `causeChain` stops at the first non-`Error` link, so both answer `false` without throwing. The write classifier's existing cases cover it; add the equivalent for `retryAfterRestart`, whose old text match would have claimed a bare string.
- **A second loaded copy of `@optimystic/db-core`.** `instanceof` fails, the shortfall is not claimed, nothing is retried. Fail-closed; stated in the source comment, not tested (the repo links one copy through root `resolutions`).
- **The three write policies.** The claim sits in `matchesRetriableFailure`, so the default, schema-init and lost-update classifiers all inherit it. The spec's `agrees with the default classifier on every other message` tables drive all three from one list — retype their entries rather than adding a fourth table.

## TODO

- Read `../optimystic/packages/db-core/src/network/promise-shortfall-error.ts` and confirm the installed 1.29.0 `dist` exports `PromiseShortfallError` from the package root.
- Claim `PromiseShortfallError` with `rejections === 0` inside `matchesRetriableFailure`'s typed-claim predicate in `control-write-retry.ts`; delete `SUPER_MAJORITY_SHORTFALL_UNANSWERED` and `isUnansweredSuperMajorityShortfall` and remove it from `RETRIABLE_CONTROL_WRITE_MATCHERS`.
- Rewrite the comments: carry the rejection-count and phase reasoning onto the new claim, drop the `NOTE:` naming this ticket and the `ValidatorRejectionError` paragraph a type match makes moot, and state the fail-closed consequence in one sentence.
- Replace `SUPER_MAJORITY_FAILURE` / `isTransientWriteFailure` in `edge-node/strands.ts` with the typed chain test; import `causeChain` from `../control-retry.js`. Record in its comment that the match now reaches any depth and no longer claims a rejection-bearing shortfall or a non-`Error` throw.
- In `control-write-retry.spec.ts`: add a `shortfall(...)` builder and a typed-chain DDL builder beside `ddlFailure`; retype the four bare-sentence fixtures; chain the typed shortfall under the `*_AGGREGATE` literals that carry one; add the text-only and under-commit-aggregate cases; add the solo-refusal case.
- In `strands.spec.ts`: retype `superMajority()`, add a wrapped-delivery case, a rejection-bearing case and a non-`Error` case.
- Check whether `chainMessages` and `causeChain` have any import that this change leaves unused, and whether any comment elsewhere in the two source files still describes the shortfall as text-matched.
- Run `yarn workspace @serfab/cadre-core typecheck` and `yarn workspace @serfab/cadre-core test` in the foreground, then `yarn lint`.
