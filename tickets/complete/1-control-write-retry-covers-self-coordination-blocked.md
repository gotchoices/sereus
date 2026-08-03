----
description: A brand-new machine could die during start-up if its network connection blipped while it was creating its database tables. That one start-up step now retries, so a momentary blip no longer stops a machine from provisioning.
prereq:
files: packages/cadre-core/src/control-write-retry.ts, packages/cadre-core/src/control-database.ts (loadSchema ~557-586, lockedWithRetry ~1669), packages/cadre-core/src/index.ts, packages/cadre-core/test/control-write-retry.spec.ts, docs/architecture.md, docs/STATUS.md, tickets/implement/control-write-retry-scenario-coverage.md
difficulty: medium
----

# Complete: schema-init retry absorbs a self-coordination refusal

## What was wrong

A freshly provisioned node ran its control-schema `create table` statements at start-up, one of
them died with

```
Self-coordination blocked: grace-period-not-elapsed. No coordinator available for key.
```

and start-up aborted with no retry. Whoever provisioned the node then timed out waiting for it to
report healthy (the provider's enrollment poll gives up at 90 s).

**Vocabulary**, since this ticket is unreadable without it:

- **Coordinator** — the one peer chosen to drive a read or write for a given piece of data.
- **Self-coordination** — a node choosing *itself* as that peer rather than a remote one.
- **Self-coordination guard** — optimystic's rule refusing self-coordination for 30 s after a
  node's last connection drops. Its refusal reason is spelled `grace-period-not-elapsed`.
- **Control-schema DDL** — the `create table` statements every node runs at start-up to bring its
  own copy of the party's control database into existence.

The DDL already went through the retry funnel (`lockedWithRetry` → `retryControlWrite`). The retry
never engaged because the classifier matched only two message shapes, neither of them this one.

## What shipped

**One behaviour change, at one call site.** `ControlDatabase.loadSchema` opts into a named second
policy; every other control write is byte-identical to before.

`packages/cadre-core/src/control-write-retry.ts`:

- Matcher `isSelfCoordinationGraceRefusal`, matching the refusal message **only** with the
  `grace-period-not-elapsed` reason. The same sentence carries three other reasons (`disabled`,
  `partition-detected`, `suspicious-shrinkage`) and none of them is retried.
- Matcher list `RETRIABLE_SCHEMA_INIT_MATCHERS` = the existing two plus that one.
  `RETRIABLE_CONTROL_WRITE_MATCHERS` is untouched.
- Exported classifier `isRetriableSchemaInitFailure`. Both classifiers share one private body
  (`matchesRetriableMessage`), so the `reportsIndeterminateCommit` veto — a chain carrying a
  `[blocks:` commit-phase batch token is never retried — is in force for both by construction.
- `ControlWriteRetryOptions` gained `attempts` and `isRetriable`, both defaulting to today's
  values, so an omitted field reproduces the old behaviour exactly.
- Exported `SCHEMA_INIT_RETRY_POLICY` = `{ attempts: 5, delaysMs: [250, 500, 1000, 2000],
  isRetriable: isRetriableSchemaInitFailure }`, plus exported `SCHEMA_INIT_ATTEMPTS`.

`packages/cadre-core/src/control-database.ts`:

- `lockedWithRetry(fn, policy = {})` merges as `{ ...policy, ...this.controlWriteRetryPacing }` —
  the spec pacing seam still wins, so specs inject `sleep`/`now` without restating the policy.
- `loadSchema` is the only caller passing one.

`packages/cadre-core/src/index.ts` — re-exports the two new symbols plus `SCHEMA_INIT_ATTEMPTS`.

`docs/architecture.md` — the "no approval threshold can relax unanimity" bullet gained the
schema-init exception.

`tickets/implement/control-write-retry-scenario-coverage.md` — appended a section telling that
ticket's implementer the third class exists, that it is an easier real-network capture target
(one node that lost its peers, no three-machine choreography), and that schema-init assertions
must use `SCHEMA_INIT_ATTEMPTS` not `CONTROL_WRITE_ATTEMPTS`.

## Judgement calls, and how they held up under review

**Match by message text, not by error type.** Not a choice. `FindCoordinatorError` (with
`code: 'SELF_COORDINATION_BLOCKED'`) is exported from `@optimystic/db-p2p` and cadre-core depends
on that package, but `OptimysticVirtualTable.initialize` catches and rethrows as
`new Error(message)` with **no `cause`**, so only the text survives the trip. Fails closed like
every other matcher here: an upstream rewording stops the retry engaging, it never makes a re-run
unsafe. **Re-verified in review** against
`../optimystic/packages/quereus-plugin-optimystic/src/optimystic-module.ts` (the `catch` at the end
of `initialize`) — the rethrow does drop the cause.

**Only the `grace-period-not-elapsed` reason is matched.** A usefulness call, not a safety one.
**Re-verified in review**: `SelfCoordinationDecision.reason`
(`db-p2p/src/libp2p-key-network.ts:100`) has seven values, but three of them (`bootstrap-node`,
`hwm-decay`, `extended-isolation`) are `allow: true` and never reach the throw at line 537. So
"three other reasons" is exactly right — `disabled`, `partition-detected`, `suspicious-shrinkage`.

**5 attempts over `[250, 500, 1000, 2000]` ms.** Worst-case sleep is ~4.6 s (each delay jittered
±50% and capped at the largest base, 2000 ms), inside the shared `CONTROL_WRITE_RETRY_BUDGET_MS`
of 10 s. The supporting facts were re-checked in review and all hold:

- the guard clears the moment the node holds **one** connection again — both branches raising
  `grace-period-not-elapsed` (lines 276 and 291) require `getConnections().length === 0` — so this
  does not need to cover the 30 s grace period, only the gap until a bootstrap dial lands;
- the 30 s `gracePeriodMs` is untunable from Cadre: no caller in either repo passes a
  `SelfCoordinationConfig`;
- a node that has **never** connected is waved through as a bootstrap node (high-water mark of 1),
  so this retry only ever delays a node that *has* seen peers;
- `findCoordinator` spends its own bounded wait before raising, and it really is the full
  2 × 500 ms here: the early-out at line 520 (`canRetryImprove`) returns `true` whenever
  `networkHighWaterMark > 1`, which is precisely the condition for this refusal. So each of our
  attempts costs ~1 s of *its* time on top of our backoff, worst case approaches the 10 s budget,
  and the budget — not the attempt count — terminates the loop there. By design.

**Not widened to the general classifier.** `NetworkTransactor.commitBlock` resolves a coordinator
during **phase 2** and `commit()` commits the header block before the rest — so for a general
control write this refusal can arrive *after* something committed, and it carries no `[blocks:`
token, so `reportsIndeterminateCommit` would not veto it. Re-running an insert body over a landed
write is exactly the `UNIQUE constraint failed: CadrePeer.PeerId` failure that veto exists to
prevent.

## Coverage

The **unit specs are the load-bearing proof**; the integration scenario is not. In
`packages/cadre-core/test/control-write-retry.spec.ts`:

- `isRetriableSchemaInitFailure` retries the refusal — asserted both bare and through the full
  wrapper stack a real startup prints (`Failed to execute DDL: … / Module 'optimystic' create
  failed … / Failed to initialize Optimystic table: …`), so the `cause`-chain walk is exercised.
  The message text is transcribed **verbatim from the real node-B startup death**.
- `isRetriableControlWriteFailure` still refuses the same failure — the pair that proves the
  widening is opt-in.
- The other three self-coordination reasons are refused by the schema-init classifier too.
- The commit-phase veto still holds for the widened policy, in both chain orders.
- A table-driven case asserts the two classifiers agree on every *other* message.
- `retryControlWrite` under `SCHEMA_INIT_RETRY_POLICY`: 5 attempts, backoff within `[125, 375]` on
  the first and `[1000, 2000]` on the last, total sleep under the 10 s budget.
- `ControlDatabase.loadSchema` re-presents the whole DDL after the refusal, and still surfaces
  indeterminate commits / `Missing block` / the other three reasons from the first attempt.
- (added in review) `retryControlWrite` still runs the body once when `attempts` is below 1.

**Known gap, stated plainly:** no test drives this against a real network. Nothing here proves the
retry *succeeds* against a live self-coordination refusal — only that the classifier accepts the
message and the loop re-presents the write. That gap is the subject of
`implement/control-write-retry-scenario-coverage`, which now carries a note about this class.

## Review findings

**Diff read first, from `git show e8e1faf`, before the handoff summary.** Source, spec, and the two
docs were read in full; the two upstream repos (`../optimystic`, `../quereus`) were read at the
five sites the change reasons about.

### Correctness / safety — nothing found

Every load-bearing claim in the implement handoff was independently checked upstream and holds:

- **The re-run safety argument.** `SchemaManager.createTable`
  (`../quereus/packages/quereus/src/schema/manager.ts:2807-2828`) calls `module.create` inside a
  `try` and only reaches `finalizeCreatedTableSchema` on success, so a failed `create table` really
  does leave the Quereus catalog clean. The sharper version of the question — *what if a phase-2
  refusal left a partly-committed optimystic collection behind, since that refusal carries no
  `[blocks:` token and so escapes the veto?* — also resolves safely: the optimystic vtab opens its
  trees through `createOrGetCollection` (create-on-missing is deliberate there), so a re-issued
  `create table` opens the existing collection rather than colliding with it.
- **The "three other reasons" claim**, the **grace-period clearing condition**, the
  **`findCoordinator` timing**, and the **dropped `cause` on optimystic's rethrow** — all four
  re-verified against upstream source; details under "Judgement calls" above.
- **Message literals.** The two Quereus wrapper texts the spec synthesizes (`Failed to execute
  DDL: %s\nError: %s` and `Module '%s' create failed for table '%s': %s`) match their format
  strings verbatim, and the refusal text matches the throw template at
  `libp2p-key-network.ts:539`. The captured node-B death recorded in the original ticket matches
  the spec constant character for character.

### Fixed in this pass — three minor items

- **`retryControlWrite` could `throw undefined`.** This diff made `attempts` a caller-supplied
  option on an interface exported from the package index. `attempts: 0` ran the body zero times and
  then rethrew a `lastError` nobody set, defeating every downstream `instanceof Error` check with no
  trace of the real failure. Floored at 1, with a spec case.
- **`SCHEMA_INIT_RETRY_POLICY` was an exported mutable singleton.** A consumer assigning
  `SCHEMA_INIT_RETRY_POLICY.attempts = 1` would silently change every node's startup policy. Typed
  `Readonly<ControlWriteRetryOptions>`; spreading it (which is all any caller does) is unaffected.
- **Comment restated what it pointed at.** The 34-line block above `loadSchema`'s single `await`
  spent its last eight lines re-arguing the schema-init-only safety case and then said the argument
  lives on `RETRIABLE_SCHEMA_INIT_MATCHERS`. Compressed to the pointer.

### Docs — one stale reference corrected, out of three files checked

`docs/architecture.md`'s new sentence is accurate against the shipped constants. The
`tickets/implement/control-write-retry-scenario-coverage.md` appendix is accurate.
`docs/cadre-consistency.md` and `docs/cadre-host.md` describe the retry only in general terms that
this change does not falsify, so both were left alone.

`docs/STATUS.md` was the one the change should have touched and did not: its
`provider-seed-accepted` entry still named this work as an open `implement/` ticket and blamed the
self-coordination guard as an untreated root cause, and it also pointed at
`fix/0-bug-control-collection-header-absent-at-committed-revision`, a ticket rerouted to
`blocked/control-coordinator-answers-absent-without-asking-cohort` in commit `5b6a1b2`. Both
references corrected, and the entry now records that the mitigation landed while stating explicitly
that the review pass's greens corroborate rather than prove.

### Tripwire recorded (not filed as a ticket)

`SCHEMA_INIT_RETRY_POLICY` is safe *because of what its one call site writes*, not because the
failure class is generically safe — but nothing in the code said so to a future second opt-in.
Parked as a `NOTE:` on the policy const in `control-write-retry.ts`: a second call site must
re-derive the re-run argument for its own write body, and a third means the policy should be
renamed for what its callers share rather than widened by default.

### Major findings — none filed, and why

No finding survived verification at a severity that warrants a ticket. The one genuinely unproven
thing about this change — that the retry *succeeds* against a live refusal — is already owned end
to end by `implement/control-write-retry-scenario-coverage`, which this diff appended a section to;
filing a second ticket for the same capture would duplicate it.

### Verification runs

- `yarn workspace @serfab/cadre-core build` — clean (twice: before and after the review edits).
- `yarn lint` — clean (twice).
- `yarn workspace @serfab/cadre-core test` — **1413 passed, 5 failed**. The 5 are the
  pre-existing set already recorded in `tickets/.pre-existing-known.md` against
  `10-revocation-reissue-same-pk-update-unique-collision` (blocked), with the probe fix owned by
  `implement/10-control-revocation-reissue-test-fixes`: 4 in `test/control-revocation-reissue.spec.ts`
  and 1 in `test/control-revocation-replay.spec.ts`, same `UNIQUE constraint failed:
  Revocation.TableName, Revocation.StampId` / `context.OwnerKey isn't a column` fingerprints. Not
  re-reported, not skipped, not touched. The count is 1413 rather than the implement pass's 1412
  because of the `attempts` case added here.
- `vitest run test/control-write-retry.spec.ts test/control-write-lock.spec.ts
  test/control-formation-use-number-retry.spec.ts` — **58 passed**, 0 failed.

**No integration scenario was run in this pass.** The implement pass ran
`provider-seed-accepted.integration.ts` four times (3 green, 1 red on the unrelated
`collection … header block read as absent` fingerprint) and correctly declined to call that proof:
the self-coordination fingerprint appears on roughly 1 run in 3, so three greens is well within
chance with no fix at all. Re-running it here would have produced another statistically
uninformative tally at ~2 minutes a run, and the classifier behaviour it would exercise is already
pinned by the unit specs against the verbatim captured message. The honest state of the evidence is
recorded above and in `docs/STATUS.md`.

**Rebuild siblings before any integration run.** A stale `../quereus` or `../optimystic` dist
aborts the whole run in `globalSetup` before a single test executes — it tripped twice during this
review pass alone, from concurrent edits in `../quereus`. From each sibling checkout:
`yarn workspace @quereus/quereus build`, `yarn build` in `../optimystic`.
