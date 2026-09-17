description: When this machine gave up on a change to the shared party records, nothing said so. It now tells the app through an event, and warns the operator directly in the one case that quietly cuts the machine off from the rest of the party.
files: packages/cadre-core/src/control-retry.ts, packages/cadre-core/src/control-write-retry.ts, packages/cadre-core/src/control-read-retry.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/control-write-retry.spec.ts, packages/cadre-core/test/cadre-node-abandoned-write-report.spec.ts, packages/integration-tests/src/scenarios/control-write-degraded-cohort-member.integration.ts, docs/architecture.md
difficulty: medium
----

# What was built

Every local control write goes through one retry funnel (`ControlDatabase.lockedWithRetry` → `retryControlWrite` → `retryControlOperation`). It gives up two ways — the classifier declines the failure as non-transient, or attempts/budget run out — and both only wrote a `debug('sereus:cadre:control-db')` line, a namespace nothing turns on by default. Foreground writes also reject to their caller, so an operator sees those. Background writes do not: the self-address republish and the two replication drains in `cadre-node.ts` are fired unawaited with a `debug`-only catch, so a permanently failed one reached nobody at all.

Four pieces, bottom up:

**The loop reports both give-up exits.** `ControlRetryPolicy` and `ControlRetryOptions` each gained an optional `onAbandon`, notified exactly once before the rethrow with a `ControlRetryAbandonment`: label, attempts made, attempts allowed, elapsed ms, a `reason` of `declined` / `attempts` / `budget`, and the error object itself (identity preserved, so an app can classify it with the same matchers). The notify is wrapped in try/catch — a throwing observer is logged and swallowed, because the loop is on its way to rethrowing the failure that actually matters.

**Writes only.** `retryControlWrite` carries the seam; `control-read-retry.ts` deliberately does not, and says so at its own seam: every control read is awaited by the caller that issued it, so an abandoned read surfaces as that caller's rejection and nothing is lost silently.

**`ControlDatabase` owns one settable listener.** `setControlWriteAbandonedListener`, same one-listener-per-database contract already written on `setMembershipChangeListener`. It is merged into `lockedWithRetry`'s options LAST (after policy and spec-injected pacing) and read through the field rather than captured, so wiring or clearing it mid-flight still governs a write already in backoff.

**`CadreNode` surfaces it two ways.** A `control:write-abandoned` entry in `CadreNodeEvents`, wired in `start()` beside the membership and guarded-delete listeners and cleared on teardown; plus one operator escalation. The escalation's bar is the consequence, not a failure count: other machines discard a `CadrePeer` record older than `DEFAULT_PEER_RECORD_MAX_AGE_MS` (15 minutes) and the heartbeat re-stamps at half that, so once this node has gone that long without publishing, anyone not already connected can no longer reach it. `console.warn` once, re-armed by the next successful publish. `lastSelfRecordPublishAt` is stamped inside `publishSelfRecord` on both publishing outcomes (so every caller — boot, heartbeat, address change, drain, explicit — counts), and both fields reset on teardown so a stop/start cycle does not inherit the previous lifetime's history.

The classifier's behaviour is unchanged, on purpose. See "The decision not to change the classifier" below — that is the part most worth a second opinion.

# How to exercise it

**The loop, in isolation** — `packages/cadre-core/test/control-write-retry.spec.ts`, new `describe('retryControlWrite — abandonment notification')`: the declined exit reports `attemptsMade: 1` with the error identity intact; the attempts exit reports after the last attempt; the budget exit is told apart from the attempts exit (a ~20 s first attempt spending the 10 s budget must not read as "tried three times"); a write a retry RESCUED reports nothing; an unlabelled call reports with no label rather than an invented one; a throwing observer never displaces the write's own failure, on both exits.

**The database seam** — same file, in the `loadSchema` describe: a listener set on a `ControlDatabase` receives the abandonment with `loadSchema`'s own `schema-init` label, and stops receiving once cleared with `null`.

**The node's two surfaces** — `packages/cadre-core/test/cadre-node-abandoned-write-report.spec.ts` (new): the event carries the abandonment unchanged and works with no listener attached; the escalation stays silent when the node never published and while the record is still fresh, warns once past the ceiling naming the consequence and the underlying failure, does not repeat, and re-arms on the next successful publish. Runs on a bare `new CadreNode(config)` — no libp2p, no database, no clock to wait out.

**The party, end to end** — `control-write-degraded-cohort-member.integration.ts` now watches `control:write-abandoned` on all three nodes from construction (so the boot-time self-publish is covered) and an `afterEach` fails the case if any write was abandoned while the cohort was healthy. Scoping is by `DegradedHandle.degradesCohort`, a new flag on the handle, not by "a handle is held" — the healthy case holds a zero-delay *observer*, and a write lost there is exactly what this file must report. Releasing a real degradation opens a 5 s settle grace (`ABANDON_SETTLE_GRACE_MS`) because `restore()` aborts held streams and the writes stalled behind them settle just after. All six per-case `restore(); activeDegradation = null;` pairs were replaced by one `releaseDegradation()` so the window has a single end.

Useful manual check, since the scenario cannot be run right now (below): run the file with `DEBUG='sereus:cadre:control-db'` and compare the `[abandoned-write <node>]` console lines the watch now prints against the funnel's own `failed non-transiently` / `failed after N/M` lines. They should agree one-for-one.

# What was NOT verified, and why

**No vitest run at all.** The stale-build guard refuses every suite in this repo: `@optimystic/db-p2p`'s `dist` is older than its `src`, because `../optimystic` is mid-ticket with ~17 modified files across `db-core` and `db-p2p`. Building their in-flight tree to satisfy the guard would replace the `dist` their own runner is using, so it was not forced — the same call `tickets/.pre-existing-known.md` records being made on 2026-09-17 ("refused by the stale-build guard … they were not forced"). **Every new spec case in this ticket is unrun by vitest.**

What was done instead: each new case was mirrored as a plain `node` script against cadre-core's freshly built `dist/`, importing nothing from `@optimystic/*`, and all passed — 6 checks for the loop, 1 for the `ControlDatabase` listener seam, 7 for the node's event and escalation. That is evidence the asserted behaviour is real; it is **not** evidence the spec files themselves run green under vitest (imports, `expect` shapes and the harness casts are typechecked but unexecuted). Running `yarn workspace @serfab/cadre-core test` once the guard clears is the first thing a reviewer should do. The probe scripts were scratch and are deleted.

`yarn workspace @serfab/cadre-core typecheck`, `yarn workspace @serfab/integration-tests typecheck`, `yarn lint` and `yarn workspace @serfab/cadre-core build` all pass.

**The integration scenario was not run**, for the guard plus the reason the implement ticket already gave: a run today measures a half-finished upstream tree, not the build the evidence describes. The new `afterEach` is therefore unexercised against a real party — in particular, whether the 5 s settle grace is the right size is a judgement call, not a measurement. If it turns out to be too short, the symptom is a case that reddens on a write the previous case provoked; too long, and a genuine loss right after a release is missed. Both are visible in the `[abandoned-write …]` lines, which print whether the loss was scoped.

**The escalation has never fired in a real process.** It needs a 15-minute gap; the unit cases set the stamp directly. The path from a failed republish into it is one call in `startRecordRefresh`'s catch.

# The decision not to change the classifier

The fix ticket contemplated a follow-up: have the classifier decline any chain reporting a validator rejection or a non-zero rejection count. That was researched and **deliberately not done**, and the reasoning is now recorded in three places that previously described the old world — the accepted-tradeoff `NOTE:` on `isUncommittedTransactorAggregate`, the module comment above it, and the retry paragraph in `docs/architecture.md`.

The short version: contention is no longer a rejection. Upstream made "another write holds this block right now" a `held` verdict counting toward neither approvals nor rejections (`validatePendOperations`, `../optimystic/packages/db-p2p/src/cluster/cluster-repo.ts`), so a contended write is no longer refused by a vote — it is retried by the collection's own sync and arrives here as `SyncRetryExhaustedError`, which no matcher claims and which must stay declined. What remains rejectable at the promise phase is stale revision, block-unavailable, membership-not-admitted and a configured validator's refusal; **stale revision is precisely the one a re-presentation fixes**, because this loop re-runs the whole write body including its reads. A blanket rejection veto would remove a retry that helps in order to save two wasted attempts on the ones that do not. The revisit condition on the `NOTE:` was rewritten accordingly — it is now about a rejection class becoming expensive to re-present, or upstream offering a typed surface, and no longer about contention.

The verdict kinds above were read off `../optimystic`'s working tree, which has uncommitted edits. The `held` branch itself is described by the implement ticket as landed at `ebc5483c`/`03ffadc4`; the surrounding file was not diffed against those commits.

# Comment and doc updates

- `control-write-retry.ts`: the module comment's rejection paragraph and the `isUncommittedTransactorAggregate` `NOTE:` rewritten for the post-`held` world, with the recorded decision above.
- `control-write-retry.spec.ts`: `SYNC_RETRY_EXHAUSTED_PENDING_CONFLICT` is now marked the LIVE shape of contention; `PROMISE_PHASE_REJECTION_IN_PEND_AGGREGATE` is marked a HISTORICAL capture whose wrapper rule is still live. Both literals kept — they are the surviving copies of pruned logs. The two cases that reference them were reworded to match.
- The scenario's fingerprint table now carries the abandoned-write fingerprint with its upstream owner, and records the `Transaction rejected by validators … pending conflict` text as CLOSED — matching the delta at the top of `tickets/.pre-existing-known.md`, which stays authoritative.
- `docs/architecture.md`: the control-write retry paragraph's contention section replaced (it still promised the classifier change this ticket declined), and the abandonment reporting and escalation added.

# Things a reviewer should look at

- The `ABANDON_SETTLE_GRACE_MS` judgement call, above.
- `lockedWithRetry` now always passes an `onAbandon` closure even with no listener set. Harmless, but it means a policy that carried its own `onAbandon` would be displaced at this seam rather than fanning out; that is documented there and is the intended contract, not an accident.
- The escalation fires only from a FAILED republish. A heartbeat whose publish reports `skipped` neither stamps nor warns, so a node that stops being able to publish without erroring (revoked, row removed) goes quiet. Documented at the method as the intended reading — a revoked node has nothing to publish — but it is a real asymmetry worth a second opinion.
- `escalateIfSelfRecordStale` is the second `console.*` in this library. The `NOTE:` on the first one (`warnIfAnnounceAddrsDiscardRelay`) said a second should instead route through an embedder surface; both notes were updated to state the rule that actually now applies — an event beside every console line, and a third such condition needs to degrade the whole party in silence to earn one.
- The scenario's `afterEach` will report a boot-time abandonment against the FIRST case, since `beforeAll` runs before any `afterEach`. That is deliberate (a write lost during boot is a real finding) but the attribution reads oddly in the output.
