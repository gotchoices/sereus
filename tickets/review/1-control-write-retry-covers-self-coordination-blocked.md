----
description: A brand-new machine could die during start-up if its network connection blipped while it was creating its database tables. That one start-up step now retries, so a momentary blip no longer stops a machine from provisioning.
prereq:
files: packages/cadre-core/src/control-write-retry.ts, packages/cadre-core/src/control-database.ts (loadSchema ~556-591, lockedWithRetry ~1673), packages/cadre-core/src/index.ts, packages/cadre-core/test/control-write-retry.spec.ts, docs/architecture.md, tickets/implement/control-write-retry-scenario-coverage.md
difficulty: medium
----

# Review: schema-init retry now absorbs a self-coordination refusal

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

## What changed

**One shipped behaviour change, at one call site.** `ControlDatabase.loadSchema` now opts into a
named second policy; every other control write is byte-identical to before.

`packages/cadre-core/src/control-write-retry.ts`:

- New matcher `isSelfCoordinationGraceRefusal`, matching the refusal message **only** with the
  `grace-period-not-elapsed` reason. The same sentence carries three other reasons (`disabled`,
  `partition-detected`, `suspicious-shrinkage`) and none of them is retried — see "Judgement
  calls" below.
- New matcher list `RETRIABLE_SCHEMA_INIT_MATCHERS` = the existing two plus that one. The existing
  `RETRIABLE_CONTROL_WRITE_MATCHERS` is untouched.
- New exported classifier `isRetriableSchemaInitFailure`. Both classifiers now share one private
  body (`matchesRetriableMessage`), so the `reportsIndeterminateCommit` veto — a chain carrying a
  `[blocks:` commit-phase batch token is never retried — is in force for both by construction, not
  by two copies staying in sync.
- `ControlWriteRetryOptions` gained `attempts` and `isRetriable`. Both default to today's values,
  so an omitted field reproduces the old behaviour exactly.
- New exported `SCHEMA_INIT_RETRY_POLICY` = `{ attempts: 5, delaysMs: [250, 500, 1000, 2000],
  isRetriable: isRetriableSchemaInitFailure }`, plus exported `SCHEMA_INIT_ATTEMPTS`.
- The loop reads `attempts` / `isRetriable` from options instead of the module constants.

`packages/cadre-core/src/control-database.ts`:

- `lockedWithRetry(fn, policy = {})` takes an optional policy and merges it as
  `{ ...policy, ...this.controlWriteRetryPacing }` — the spec pacing seam still wins, so specs
  keep injecting `sleep`/`now` without restating the policy.
- `loadSchema` is the only caller passing one.

`packages/cadre-core/src/index.ts` — re-exports the two new symbols plus `SCHEMA_INIT_ATTEMPTS`.

`docs/architecture.md` — the "no approval threshold can relax unanimity" bullet gained the
schema-init exception.

`tickets/implement/control-write-retry-scenario-coverage.md` — appended a section telling that
ticket's implementer the third class exists, that it is an easier real-network capture target
(one node that lost its peers, no three-machine choreography), and that schema-init assertions
must use `SCHEMA_INIT_ATTEMPTS` not `CONTROL_WRITE_ATTEMPTS`.

## Judgement calls a reviewer should push on

**Match by message text, not by error type.** Not a choice. `FindCoordinatorError` (with
`code: 'SELF_COORDINATION_BLOCKED'`) is exported from `@optimystic/db-p2p` and cadre-core depends
on that package, but `OptimysticVirtualTable.initialize` catches and rethrows as
`new Error(message)` with **no `cause`**
(`../optimystic/packages/quereus-plugin-optimystic/src/optimystic-module.ts:313-316`), so only the
text survives the trip. Fails closed like every other matcher here: an upstream rewording stops the
retry engaging, it never makes a re-run unsafe.

**Only the `grace-period-not-elapsed` reason is matched.** The safety argument (a write refused at
coordinator *selection* never reached a peer, so nothing pended and nothing committed) holds for
all four reasons — this is a *usefulness* call, not a safety one. `disabled` is static
configuration; `partition-detected` and `suspicious-shrinkage` describe conditions that will not
resolve inside ~4.6 s of backoff, so retrying them would spend the budget to reach the identical
error. A reviewer who thinks all four should be absorbed is arguing a defensible position; the
narrower match is what shipped.

**5 attempts over `[250, 500, 1000, 2000]` ms.** Worst-case sleep is ~4.6 s (each delay is
jittered ±50% and capped at the largest base, 2000 ms), inside the shared
`CONTROL_WRITE_RETRY_BUDGET_MS` of 10 s. Sized against measured facts, not guessed:

- the guard clears the moment the node holds **one** connection again — both branches raising
  `grace-period-not-elapsed` require `getConnections().length === 0` — so this does not need to
  cover the 30 s grace period, only the gap until a bootstrap dial lands;
- the 30 s `gracePeriodMs` is untunable from Cadre anyway: no caller in either repo passes a
  `SelfCoordinationConfig`;
- a node that has **never** connected is waved through as a bootstrap node (network high-water
  mark of 1), so this retry only ever delays a node that *has* seen peers;
- `findCoordinator` spends its own bounded wait before raising (3 internal attempts 500 ms apart,
  `db-p2p/src/libp2p-key-network.ts:422`), so each of our attempts costs ~1 s of *its* time on top
  of our backoff. Worst case therefore approaches the 10 s budget, and the budget — not the
  attempt count — is what terminates the loop there. That is by design but is the number most
  worth a second opinion.

**Not widened to the general classifier.** Deliberate, and the reasoning is load-bearing:
`NetworkTransactor.commitBlock` resolves a coordinator during **phase 2**
(`resolveCoordinator`, `db-core/src/transactor/network-transactor.ts` ~670/~762) and `commit()`
commits the header block before the rest — so for a general control write this refusal can arrive
*after* something committed, and it carries no `[blocks:` token, so `reportsIndeterminateCommit`
would not veto it. Re-running an insert body over a landed write is exactly the
`UNIQUE constraint failed: CadrePeer.PeerId` failure that veto exists to prevent. Schema init
escapes this because `apply schema` is a diff rather than a replay and a failed `create table`
leaves the catalog clean.

## What to test, and where the coverage actually is

The **unit specs are the load-bearing proof**; the integration scenario is not. In
`packages/cadre-core/test/control-write-retry.spec.ts`:

- `isRetriableSchemaInitFailure` retries the refusal — asserted both bare and through the full
  wrapper stack a real startup prints (`Failed to execute DDL: … / Module 'optimystic' create
  failed … / Failed to initialize Optimystic table: …`), so the `cause`-chain walk is exercised.
  The message text is transcribed **verbatim from the real node-B startup death**, unlike the two
  pre-existing retriable literals which are reconstructions.
- `isRetriableControlWriteFailure` still refuses the same failure — the pair that proves the
  widening is opt-in.
- The other three self-coordination reasons are refused by the schema-init classifier too.
- The commit-phase veto still holds for the widened policy, in both chain orders.
- A table-driven case asserts the two classifiers agree on every *other* message, so a future edit
  to either matcher list cannot silently diverge.
- `retryControlWrite` under `SCHEMA_INIT_RETRY_POLICY`: 5 attempts, backoff within
  `[125, 375]` on the first and `[1000, 2000]` on the last, total sleep under the 10 s budget.
- `ControlDatabase.loadSchema` re-presents the whole DDL after the refusal, and still surfaces
  indeterminate commits / `Missing block` / the other three reasons from the first attempt.

**Known gap, stated plainly:** no test drives this against a real network. Nothing in this change
proves the retry *succeeds* against a live self-coordination refusal — only that the classifier
accepts the message and the loop re-presents the write. That gap is the whole subject of
`implement/control-write-retry-scenario-coverage`, which now carries a note about this class.

## Verification runs

- `yarn workspace @serfab/cadre-core build` — clean.
- `yarn workspace @serfab/cadre-core test` — **5 failures, all pre-existing and already tracked**:
  4 in `test/control-revocation-reissue.spec.ts` and 1 in `test/control-revocation-replay.spec.ts`,
  both listed in `tickets/.pre-existing-known.md` against
  `10-revocation-reissue-same-pk-update-unique-collision` (blocked) with the probe fix owned by
  `implement/10-control-revocation-reissue-test-fixes`. Same `UNIQUE constraint failed:
  Revocation.TableName, Revocation.StampId` / `context.OwnerKey isn't a column` fingerprints as
  recorded there. Not re-reported, not skipped, not touched.
- `vitest run test/control-write-retry.spec.ts test/control-write-lock.spec.ts
  test/control-formation-use-number-retry.spec.ts` — **57 passed**, 0 failed.
- `yarn lint` — clean.
- `yarn build` (whole repo) — clean.

### Integration scenario: 4 valid runs, 3 green / 1 red — and the red is NOT this fingerprint

`yarn workspace @serfab/integration-tests test src/scenarios/provider-seed-accepted.integration.ts`

| run | result | fingerprint |
| --- | --- | --- |
| 1 | green | — |
| 2 | red (3 of 5 tests) | `collection default/CadrePeer/index/_uniq_5 holds committed revision 2, but its header block read as absent` at seed-mint time. `✓ Connected to control network` **is** present, so the DDL succeeded — this is the `bug-control-collection-header-absent-at-committed-revision` class, unrelated to this ticket. |
| — | aborted | stale-build guard tripped mid-sequence: a concurrent edit to `../quereus` src invalidated its dist. Rebuilt and re-ran; not counted. |
| 3 | green | — |
| 4 | green | — |

**This is corroboration at best, and arguably not even that.** The self-coordination fingerprint
did not reproduce in any of the 4 runs — the ticket recorded it at roughly 1 run in 3, so 3 greens
is well within what you would see by chance with no fix at all. Do not read the tally as evidence
the fix works.

**Rebuild siblings before any integration run.** A stale `../quereus` or `../optimystic` dist
aborts the whole run in `globalSetup` before a single test executes (it happened twice here). From
each sibling checkout: `yarn workspace @quereus/quereus build`, `yarn build` in `../optimystic`.

## Review findings

- Nothing parked as a tripwire by this ticket.
