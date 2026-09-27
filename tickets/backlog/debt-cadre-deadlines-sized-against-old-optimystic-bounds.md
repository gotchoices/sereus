description: Several of cadre's own "give up after N seconds" limits were chosen back when the network layer underneath them gave up after 1 second. That layer now waits up to 5 seconds for one machine, and up to 25 for a whole round of repair, so some of cadre's limits now expire before the thing they are waiting on can possibly finish. Nothing records which limits depend on which, so the next change to either number is guesswork.
architecture: docs/architecture.md#replication-cluster-size
files:
  - packages/quereus-plugin-sereus/src/cluster-size.ts (COHORT_READ_DEADLINE_MS — the number that moved)
  - packages/cadre-core/src/membership-connection-gater.ts (ADMISSION_DECISION_TIMEOUT_MS, 2000)
  - packages/cadre-core/src/control-read-retry.ts (CONTROL_READ_RETRY_BUDGET_MS, 1500)
  - packages/cadre-core/src/control-write-retry.ts (CONTROL_WRITE_RETRY_BUDGET_MS, 10000)
  - packages/cadre-core/src/strand-formation-protocol.ts (DEFAULT_PROVISION_TIMEOUT_MS, 12000)
  - packages/cadre-core/src/seed-bootstrap.ts (DEFAULT_SEED_READ_TIMEOUT_MS / DEFAULT_SEED_DELIVER_TIMEOUT_MS, 10000)
  - packages/cadre-core/src/control-cohort.ts (DEFAULT_CONTROL_COHORT_RECONCILE_MS, 15000)
  - packages/cadre-core/src/strand-first-sync-gate.ts (DEFAULT_STRAND_FIRST_SYNC_TIMEOUT_MS, 120000 — the one that WAS weighed)
severity: edge-case
likelihood: normal-use
tradeoffs: Nothing is observably broken — every deadline named here wraps a path that either fails open by design or retries, so the visible effect is slower and vaguer failures on slow links rather than wrong answers; and the honest fix is per-case judgement across eight sites with no single mechanical check at the end of it, which a maintainer may reasonably defer until a deployment actually reports one of these timeouts firing.

# cadre-core's deadlines were sized against Optimystic's old bounds, and the relationship is recorded nowhere

## What happened

cadre asks the other machines holding a block which revision is newest before serving a read whose local copy might be stale. Optimystic gives each machine a per-peer deadline to answer, and derives a second, longer bound for a whole round of repair from it. Until this week cadre declared neither, so both took Optimystic's own defaults: **1000 ms per machine, and 5000 ms for a whole round** (`max(5000, 5 x per-peer)`).

Cadre now declares 5000 ms per machine, because two phones talking through a relay cannot answer inside a second. The derived whole-round bound therefore became **25000 ms**. Both numbers went up by 5x, in one edit, in a different package from the code that depends on them.

Cadre has its own deadlines layered on top of those, and each was chosen against the old pair. Read off the source as of this ticket:

| cadre-core deadline | value | was it above Optimystic's old bound? | is it above the new one? |
| --- | --- | --- | --- |
| `ADMISSION_DECISION_TIMEOUT_MS` | 2 000 ms | yes (vs 1 000 per-peer) | **no** |
| `CONTROL_READ_RETRY_BUDGET_MS` | 1 500 ms | roughly (vs 1 000 per-peer) | **no** |
| `DEFAULT_SEED_READ_TIMEOUT_MS` | 10 000 ms | yes (vs 5 000 per round) | **no** |
| `CONTROL_WRITE_RETRY_BUDGET_MS` | 10 000 ms | yes (vs 5 000 per round) | **no** |
| `DEFAULT_PROVISION_TIMEOUT_MS` | 12 000 ms | yes (vs 5 000 per round) | **no** |
| `DEFAULT_CONTROL_COHORT_RECONCILE_MS` | 15 000 ms | yes (vs 5 000 per round) | **no** |
| `DEFAULT_STRAND_FIRST_SYNC_TIMEOUT_MS` | 120 000 ms | yes | yes |

Only the last one was weighed when the per-peer deadline was raised; its own doc comment records the measurement that justifies it. The other six were not considered, and nothing anywhere states that they depend on a number declared in `quereus-plugin-sereus`.

## Why it matters, concretely

"Cadre's deadline expires first" is not automatically wrong — several of these deadlines exist precisely to cut a slow inner operation off. What is wrong is that nobody decided, per site, which of the two readings applies. Two consequences are already true rather than hypothetical, and were verified by reading the code (no run was needed, and none would distinguish them without a slow link):

**The inbound membership gate can no longer make a real decision on a slow link.** When an unknown peer connects to a control node, the gate reads the control database to ask whether that peer is an authorized member. The read is uncached and can go to the network. The gate fails open after 2 s, deliberately — a slow decision admits rather than wedging libp2p's inbound upgrade forever. But a read whose consult finds one silent peer now takes 5 s, so on the very deployment this change was made for, the gate's answer is *always* the fail-open one. An unplaced peer is admitted for 5 s where it used to be about 1 s. It is admitted to nothing more than a connection — the per-protocol stream gates still refuse it every members-only protocol, and unplaced relay reservations are capped at 8 — which is why this is a widened cost and not a hole. It is still a security-relevant posture that got looser without anyone choosing it.

**The control-read retry no longer retries the case it was extended to cover.** `control-read-retry.ts` deliberately treats a `cohort-unreachable` read as worth one more attempt, and its own comment says that is safe "because the cost of being wrong is bounded by `CONTROL_READ_RETRY_BUDGET_MS`". That budget is checked *between* attempts, not during one, so a first attempt that burns the 5 s per-peer deadline overshoots the whole 1 500 ms budget and the loop stops. The retry still earns its place for the failure it was originally built for (a ~25 ms transactor aggregate off a stream still forming), but the slow case it was widened to include is now unreachable.

The four remaining rows are unexamined. Each needs one question answered: does this deadline mean "cut the inner operation off" (fine, and should say so) or "leave room for the inner operation to finish" (now wrong)?

## What a fix looks like

The root of it is not any one of these numbers — it is that the ladder between cadre's deadlines and Optimystic's has no single owner and no check. Three things, in order of value:

- **Record the ladder once**, as a section under [`docs/cadre-consistency.md`](../../docs/cadre-consistency.md) or beside the replication-policy material in [`docs/architecture.md`](../../docs/architecture.md): the two Optimystic bounds, how the second is derived from the first, and each cadre deadline that wraps a read or a commit with the reading it intends. A reader changing either side should meet one page, not eight comments.
- **Decide each of the four unexamined sites** and say so at the site — either raise the deadline, or state that cutting the inner operation off is intended and what the caller sees when it happens.
- **Guard the two relationships that are load-bearing.** `control-read-retry.spec.ts` already asserts `CONTROL_READ_RETRY_BUDGET_MS < ADMISSION_DECISION_TIMEOUT_MS`, so the idiom exists. The analogous assertions cannot be plain inequalities — several of these deadlines are legitimately below Optimystic's bounds — so what a check can pin is that each *declared intent* still matches the numbers, which is why the intents have to be written down first.

There is no repro to run, and no test to add before the decisions are made. The magnitudes above are read off the named constants, not measured; the 5x change itself is arithmetic from Optimystic's `reconcilePassTimeoutMs` (`max(5000, 5 x cohortQueryTimeoutMs)`).

## Related, but not this

`debt-relay-reservation-decision-repeatable-cost` also touches `membership-connection-gater.ts`. Its root cause is different — the *cost* of one reservation decision and an unplaced peer's ability to repeat it — and the two do not resolve at the same site. They interact only in that a cheaper decision (answered from a materialized snapshot rather than a network read) would incidentally remove this ticket's first consequence.
