description: Sereus decides whether to retry a write that too few machines answered by reading the error's message text. Optimystic now raises that failure as its own error type, so Sereus could check the type instead and stop depending on the wording.
architecture: docs/cadre-consistency.md
files: packages/cadre-core/src/control-write-retry.ts (`SUPER_MAJORITY_SHORTFALL_UNANSWERED`, `isUnansweredSuperMajorityShortfall`, `matchesRetriableFailure`), packages/cadre-core/test/control-write-retry.spec.ts (the `SUPER_MAJORITY_*` fixtures, `nested`, `ddlFailure`), packages/cadre-core/src/edge-node/strands.ts (`SUPER_MAJORITY_FAILURE`, second arm)
tradeoffs: Upstream keeps the message byte for byte as a contract with Sereus and pins it in its own tests, so the text match is stable today; the change rewrites about a dozen spec fixtures for no change in behaviour, and a typed check fails closed if a wrapper ever drops the error's `cause` or a second copy of `@optimystic/db-core` is loaded.
----
# Match the super-majority shortfall by type

## What is there now

`control-write-retry.ts` retries a control write whose cohort did not answer. One of the failures it claims is the coordinator's super-majority shortfall with zero rejections, matched by the regex `SUPER_MAJORITY_SHORTFALL_UNANSWERED` over every message in the error's `cause` chain.

From Optimystic 1.20.0 that failure is `PromiseShortfallError` (`@optimystic/db-core`), with `approvals`, `rejections`, `peerCount`, `needed` and `silentPeers` as fields. Its message is the sentence the regex matches, kept unchanged on purpose (upstream `1-offline-sync-typed-promise-shortfall`; its doc says to test for the class rather than the text).

Seen live on 1.20.0 (`adopt-optimystic-1-20-0`, `control-write-degraded-cohort-member`, 2026-10-28):

- A pend that met a silent member failed the control write with the `PromiseShortfallError` object itself, not wrapped: the funnel logged `failed after 1/3 attempt(s): PromiseShortfallError: Failed to get super-majority: 2/3 approvals (needed 3, 0 rejections)`, and the scenario's error chain had one link.
- A commit that met a member gone silent after the pend still arrived as text inside the `[blocks:1]` aggregate, and the commit-phase veto declined it.

## The change

- In `matchesRetriableFailure`, after both vetoes, claim `link instanceof PromiseShortfallError && link.rejections === 0` beside the other typed claims, and delete the regex and its matcher from `RETRIABLE_CONTROL_WRITE_MATCHERS`.
- In the spec, build the bare-sentence fixtures (`SUPER_MAJORITY_NONE_ANSWERED`, `_PARTIAL`, `_REJECTED`, `_THIRD_NODE_JOIN`) as real `PromiseShortfallError` objects carried on `cause`, and pin that the same sentence as plain text no longer matches, as `control-read-retry.spec.ts` does for `BlockUnavailableError`. `ddlFailure` builds text today, so the schema-init cases need a wrapper that keeps the error as `cause`, the way Quereus's `Failed to execute DDL:` error does (`../quereus/packages/quereus/src/runtime/emit/schema-declarative.ts`, the `QuereusError` built with the step's error as its cause).
- The aggregate fixtures (`SUPER_MAJORITY_IN_PEND_AGGREGATE`, `_IN_COMMIT_AGGREGATE`) stay text: the aggregate is matched by its wrapper and its batch token, not by the sentence inside it.

What has not been seen live: the schema-init path (a third node's `apply schema` meeting a shortfall). Its failure was never captured whole (see `SUPER_MAJORITY_THIRD_NODE_JOIN`'s comment), so whether every wrapper on that path keeps `cause` is known only from reading Quereus.

Upstream's `classifyCommitFailure` is not a replacement. It would claim this one failure (`cohort-unreachable`) but sorts the `[block:` aggregate, the `[blocks:` veto and the self-coordination refusal as `unknown`, and it does not separate zero rejections from some.

## Second arm: the edge node's strand-write retry

`retryAfterRestart` in `packages/cadre-core/src/edge-node/strands.ts` retries a strand write on `/Failed to get super-majority/i` over the top-level message only, at any rejection count. Its NOTE says to match on a typed error once Optimystic has one. Decide there whether a write some member rejected should still be retried.
