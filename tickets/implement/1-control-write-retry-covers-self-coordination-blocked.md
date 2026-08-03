----
description: A brand-new machine can die during start-up if its network connection blips at the wrong moment while it is creating its database tables, and it never tries again. Make that one start-up step retry, so a momentary blip no longer stops a machine from provisioning.
prereq:
files: packages/cadre-core/src/control-write-retry.ts, packages/cadre-core/src/control-database.ts (initializeSchema ~530-582, lockedWithRetry ~1668), packages/cadre-core/test/control-write-retry.spec.ts, packages/integration-tests/src/scenarios/provider-seed-accepted.integration.ts
difficulty: medium
repro: static
----

# Retry control-schema DDL when coordinator selection was refused

## The symptom

A freshly provisioned node dies during start-up, in control-schema DDL, and never reports
healthy — so whoever provisioned it times out waiting (the provider's enrollment poll gives up at
90 s). Its own log:

```
✓ Pinned 1 owner key(s) for cold-start seed trust
✓ Health server on port 59711, metrics on port 59712
✓ Seed endpoint authenticated (POST /seed requires bearer token)
Failed to start cadre node: Failed to execute DDL: create table CadreControl.Revocation (…)
Error: Module 'optimystic' create failed for table 'Revocation': Failed to initialize Optimystic
table: Self-coordination blocked: grace-period-not-elapsed. No coordinator available for key.
```

Note the missing `✓ Connected to control network`. Observed in
`provider-seed-accepted.integration.ts` step 4 (node B, the third real `cadre-cli` child in the
party) on 1 of 3 runs, 2026-08-03. A run costs ~2 minutes; a green run ~43 s.

## Vocabulary

- **Coordinator** — the one peer chosen to drive a read or write for a given piece of data.
- **Self-coordination** — a node choosing *itself* as that peer rather than a remote one.
- **Self-coordination guard** — optimystic's rule that refuses self-coordination for 30 seconds
  after a node's last connection drops (`grace-period-not-elapsed`).
- **Control-schema DDL** — the `create table` statements every node runs at start-up to bring its
  own copy of the party's control database into existence.

## Why the write is never retried today

`ControlDatabase.initializeSchema` already routes the whole `exec(schemaContent)` through
`lockedWithRetry` → `retryControlWrite` (`control-database.ts:580`, with the safety argument for
re-running a partially-applied schema in the comment above it). The retry does not engage because
`isRetriableControlWriteFailure` matches only two message shapes — a transactor aggregate from a
pre-commit phase, and an unanswered super-majority shortfall. `Self-coordination blocked: …`
matches neither, so `initializeSchema` gets exactly one attempt and start-up dies.

Whether it *should* be retried is a real question, and the answer is yes for this call site: a
write that could not even select a coordinator never reached a peer, so nothing pended and nothing
committed. Re-presenting it is a proven non-commit, unlike the commit-phase aggregate the existing
classifier deliberately vetoes.

## Do NOT widen the general classifier — scope this to schema init

`RETRIABLE_CONTROL_WRITE_MATCHERS` is consulted for **every** control write, and for the general
case "self-coordination was refused" is *not* provably a non-commit:
`NetworkTransactor.commitBlock` resolves a coordinator through `resolveCoordinator` →
`findCoordinator` during **phase 2** (`../optimystic/packages/db-core/src/transactor/network-transactor.ts`,
`commitBlock` ~670, `resolveCoordinator` ~762). `commit()` commits the header block before the
rest, so a refusal there can land after something already committed — and the resulting error
carries no `[blocks:` batch token, so `reportsIndeterminateCommit` would not veto it. Re-running an
insert body over a write that landed is exactly the failure mode that veto exists to prevent
(`UNIQUE constraint failed: CadrePeer.PeerId`).

Schema init does not have that problem, and its re-run safety is already argued in place: `apply
schema` is a diff, not a replay, and a failed `create table` leaves the catalog clean, so attempt 2
re-emits only the failed table and its successors.

So: give `initializeSchema` its own retry policy that additionally accepts this class, and leave
every other control write on today's classifier unchanged.

## Match by message text, not by error type

`FindCoordinatorError` (with `code: 'SELF_COORDINATION_BLOCKED'`) is exported from
`@optimystic/db-p2p`, and `@serfab/cadre-core` already depends on that package — but the error
**object** does not survive the trip. `OptimysticVirtualTable.initialize` catches and rethrows as
`throw new Error(message)` with **no `cause`**
(`../optimystic/packages/quereus-plugin-optimystic/src/optimystic-module.ts:313-316`), so only the
text reaches this repo. Match the message, and note the fragility the same way the existing
matchers do — this fails closed (stops retrying) if optimystic ever rewords it.

## Budget: what a retry can and cannot buy

Measured constants, for whoever picks the numbers:

- optimystic's grace period is **30 s** (`gracePeriodMs` default, `libp2p-key-network.ts:130`), and
  `SelfCoordinationConfig` is never plumbed by any caller in either repo — every construction site
  passes `undefined` — so it cannot be tuned from here.
- today's policy is `CONTROL_WRITE_ATTEMPTS = 3` with delays `[250, 1000]` under a
  `CONTROL_WRITE_RETRY_BUDGET_MS = 10_000` ceiling, i.e. at most ~1.25 s of added wait.

The block does **not** require waiting out the full 30 s: it clears the moment the node has one
connection again (both branches that produce it require `getConnections().length === 0`). A
cold-start node is actively dialling its bootstrap peers, so a few seconds of retry is the right
shape.

One property makes a longer budget cheap here: a node that has *never* connected has a network
high-water mark of 1 and is allowed through as a bootstrap node, so it never produces this error at
all. The retry therefore only ever delays a node that **has** seen peers. A node whose peers are
gone for good still fails, just later — so keep the budget inside the existing 10 s ceiling rather
than stretching it to cover the whole 30 s window.

## Verification is expensive and probabilistic — say so in the handoff

The only end-to-end proof is `provider-seed-accepted.integration.ts`, which reds on this fingerprint
roughly 1 run in 3 and reds on a *different*, unrelated fingerprint
(`blocked/control-coordinator-answers-absent-without-asking-cohort`) on others. A green run is not
proof. The unit-level proof — the classifier accepts the real message text and the general
classifier still rejects it — is the load-bearing one; treat the scenario as corroboration and
record the run tally honestly.

## Related, deliberately not merged

- `blocked/offline-node-cannot-serve-its-own-data` — the same optimystic guard, seen on the **read**
  side. That one has no Sereus-side fix and is blocked upstream. This ticket does not depend on it
  and must not wait for it.
- `implement/control-write-retry-scenario-coverage` — real-network coverage for the *existing*
  classifier. Different scope; if both land, mention this class there.

## TODO

- Read `packages/cadre-core/src/control-write-retry.ts` end to end before changing anything — the
  classifier's existing comments carry the safety reasoning this change has to preserve.
- Add a matcher for the self-coordination refusal message, exposed so it is **opt-in per call
  site** rather than added to `RETRIABLE_CONTROL_WRITE_MATCHERS`. Shape is the implementer's call
  (an extra `ControlWriteRetryOptions` field, or a second exported policy) — whichever keeps the
  default policy byte-identical for every existing caller.
- Wire only `ControlDatabase.initializeSchema` to the widened policy; leave `lockedWithRetry`'s
  default path unchanged.
- Pick attempts/delays for the schema-init policy inside the existing
  `CONTROL_WRITE_RETRY_BUDGET_MS` ceiling. Document the choice against the measured facts above.
- Keep the `reportsIndeterminateCommit` veto in force for the widened policy too — a chain carrying
  a commit-phase batch token is still never retried.
- Add unit coverage in `packages/cadre-core/test/control-write-retry.spec.ts`: the widened policy
  retries the real message text (copy it verbatim from the log at the top of this ticket, wrapped
  the way `optimystic-module.ts` wraps it and then QuereusError-wrapped, so the `cause`-chain walk
  is exercised); the **default** policy still does not; and a chain that also carries `[blocks:`
  is refused by both.
- Run the cadre-core suite and `yarn lint`.
- Run `yarn workspace @serfab/integration-tests test src/scenarios/provider-seed-accepted.integration.ts`
  a few times, record the tally and each failure's fingerprint, and do not claim the scenario as
  proof.
- Note in the review handoff that a stale sibling build will abort any integration run — rebuild
  `../quereus` and `../optimystic` first (`yarn workspace <name> build` from their own checkouts).
