----
description: A test that proves two devices can pass data over a connection one of them just opened can no longer get far enough to check that — it now fails seconds after start-up, for an unrelated reason that lives in the shared database library rather than in this project.
prereq:
files: packages/integration-tests/src/scenarios/control-cohort-edge-carries-data.integration.ts, packages/integration-tests/src/harness/control-trio.ts, ../optimystic/tickets/fix/isolated-read-cannot-confirm-a-never-written-block.md
difficulty: hard
repro: verified
----

> **Measured 2026-09-03 — the re-run this ticket prescribes has now been done, and the answer is
> "still masked". Five isolated rounds, five identical failures.**
>
> The 2026-08-21 audit below says the upstream unblock condition looks already satisfied and that
> the next step is to run the scenario ~6 times and see what the carry step does. Run in isolation
> against `@optimystic/db-p2p` 0.27.0, both siblings rebuilt from committed release trees:
>
> | round | result |
> | --- | --- |
> | 1-5 | **1 failed of 1, every round**, at ~8.8 s |
>
> ```
> Error during query on table 'Revocation': Query failed:
>   Block default/Revocation is unavailable (cohort-unreachable): the repo could not determine whether it exists
> ```
>
> Identical to the fingerprint the audit recorded, and still in **boot** — the carry step this
> scenario exists to measure has still never executed. So the ticket's own question ("what does the
> carry step do today?") remains unanswerable, and the alternative the body offers — retire this and
> open a fresh ticket against the boot failure that actually fires — is now the better-evidenced
> option. That call is a human's; nothing here has been retired.
>
> One thing this run does settle: the failure is **not** intermittent any more. Five for five means
> whoever picks up the boot failure has a reliable repro, which the ticket has never had.

> **Audit 2026-08-21 — premise still holds, but the unblock condition may already have been met.**
> The scenario `control-cohort-edge-carries-data` still dies before reaching the carry step, so the
> original stream-reset symptom remains unobservable and the ticket's reasoning stands. Two things
> have moved:
>
> - **The masking failure's fingerprint changed.** It is now
>   `Block default/Revocation is unavailable (cohort-unreachable)` during boot, measured in the
>   full-suite runs of 2026-08-20 and 2026-08-21. The body below describes the earlier shape.
> - **The upstream ticket named as the unblock condition,
>   `../optimystic/tickets/fix/isolated-read-cannot-confirm-a-never-written-block.md`, is no longer
>   on that repo's board** — only a run log from 2026-08-13 remains, so it was processed and has
>   since been pruned from `complete/` (30-day policy). If it landed, this ticket's stated unblock
>   condition is *already satisfied* and the next step it prescribes — re-run the scenario ~6 times
>   and see what the carry step does — is actionable now rather than blocked.
>
> Given that, the alternative the body already offers (delete this and open a fresh ticket against
> whatever the carry step actually does today) looks like the stronger option, since none of the
> original stream-reset analysis has been reproduced since 2026-08-12.

# Blocked on an upstream read failure that lands before this ticket's symptom

## Why this is blocked (the decision a human may want to make)

This ticket was opened against a stream-reset failure in the *carry* step of
`control-cohort-edge-carries-data`. **That symptom is no longer observable**: the
scenario now dies 5-15 s into boot, long before the carry step, on a defect that
lives in `../optimystic`. Nothing in this repo can move it forward until that
lands. The upstream ticket is filed:

```
../optimystic/tickets/fix/isolated-read-cannot-confirm-a-never-written-block.md
```

Unblock condition: that ticket lands and `../optimystic` is rebuilt. Then re-run
the scenario ~6 times and see what the carry step does — it may be green, it may
show the original stream reset, or it may show something new. Today that question
cannot be asked.

Alternative a human might prefer: delete this ticket and re-open a fresh one after
the upstream fix, since none of the original stream-reset analysis was reproduced
today and it may no longer describe anything real.

## What was measured today (2026-08-12)

`../optimystic` was rebuilt first (`db-core`, then `db-p2p`); its working tree
carried only logging-plumbing edits from its own runner (per-peer-id debug
namespaces), which are behaviour-neutral. So the "half-edited sibling" caveat the
original ticket raised no longer applies to this measurement.

Eight runs of
`yarn vitest run src/scenarios/control-cohort-edge-carries-data.integration.ts`
from `packages/integration-tests`:

- **7 runs** failed within 5-15 s with
  `Block default/Revocation is unavailable (peers-unreachable): the repo could not
  determine whether it exists`.
- **1 run** (and every run made with heavy `DEBUG` output, which slows the process
  enough to change which wall it hits) failed instead on the known boot gate
  `Timeout waiting for B resolves C's signed CadrePeer address record`, owned by
  `blocked/control-peer-row-refresh-invisible-to-third-node`.
- **0 runs** reached the carry step this ticket is about.

The `peers-unreachable` fingerprint is not new — the completed ticket
`complete/control-coordinator-answers-absent-without-asking-cohort.md` recorded it
as this scenario's fingerprint on 2026-08-03 and said so explicitly ("that ticket
needs re-measuring regardless"). This is that re-measurement.

## The upstream mechanism, in one paragraph

A node with no connections asks the key network who should coordinate a read. There
is nobody to ask, so it picks itself — knowingly degraded, which is the fallback
that exists precisely so an isolated node can still read its own copy. The read
then reaches the local coordinator, which consults the block's cohort before
answering. The one other cohort member is unreachable, so the consult comes back
inconclusive and the answer is marked "could not determine whether this block
exists" — which the caller turns into a hard error. Because Cadre filters every
membership read through the revocation tombstone table, and that table has never
been written on a fresh network, **every** peer-record read on a not-yet-connected
node hits this. Full trace and candidate fixes are in the upstream ticket.

## Diagnostics added here (kept, not reverted)

Both are small and independent of the outcome above:

- `harness/control-trio.ts` — every straight-line boot call is wrapped in
  `atStage(...)`, so a transactor error thrown by one of them names the boot step it
  came from instead of arriving anonymous. The polls already carried a description;
  the straight-line calls carried nothing.
- the scenario's step-2 baseline read is wrapped the same way, with the peer-id map
  appended (`explain(...)`) — the same treatment the polls already got.

`yarn lint` and `tsc --noEmit` in `packages/integration-tests` are clean with both.

## Loose end for whoever picks this up

The `peers-unreachable` failure **could not be attributed to any call site.** With
every straight-line boot call wrapped, the whole `bootControlTrio(...)` call wrapped,
and `process.on('unhandledRejection')` + `process.on('uncaughtException')` handlers
registered in the test file, none of them fired — yet vitest still reported the error
as the test's own failure and stopped the test. Whatever path delivers it to vitest
is not an ordinary awaited rejection in the test or harness. Worth understanding: it
means a control-DB read can fail a run while every catch block in the path stays
silent, which makes any failure of this shape hard to attribute. (Temporary probes
were removed; only the two diagnostics above remain.)

## Original symptom, preserved for the re-measurement

The carry step used to fail with an aggregate transactor error naming node C — the
coordinator B's read was pinned to, over the connection B had just opened to it —
with `The stream has been reset`, repeating identically for the full 60 s poll and
passing on other runs of the same code. If that reappears after the upstream fix,
the questions the original ticket posed still stand: who resets the stream (C's
membership admission gate, C's repo protocol handler, or the muxer), and what C's
coordinator cache holds for the failing block's key at that moment.

## Housekeeping when this unblocks

`tickets/.pre-existing-known.md` carries an entry for this slug (the carry-step
line). It has been updated to today's fingerprint; remove it when the scenario runs
clean.

> **The upstream ticket this file names has LANDED, and its conclusion changes what this ticket is
> blocked on — 2026-09-05.** Written from the `../optimystic` side during a tending pass; nothing
> here was re-measured.
>
> **Stale reference first.** The `files:` header points at
> `../optimystic/tickets/fix/isolated-read-cannot-confirm-a-never-written-block.md`. That path no
> longer exists: the ticket advanced through that pipeline and completed as
> `optimystic/tickets/complete/absence-verdict-names-the-evidence`.
>
> **What it shipped.** A read that finds a block missing locally now returns a *named* verdict
> instead of one catch-all, and the four values are meant to be branched on: `'unmaterializable'`;
> `'peers-unreachable'`; `'cohort-unreachable'` (nothing held locally and no cohort member outside
> this node could be asked at all); `'claimed-elsewhere'` (a peer positively claimed a revision that
> could be neither corroborated nor acquired — the block is known to exist somewhere).
>
> **What it deliberately did NOT do, in its own words:** *"The isolated boot does not start working
> because this landed."* The repo layer refuses to decide that a node which reached nobody may
> believe its own emptiness. Whether a given read may proceed on this node's own view is per-read
> policy and belongs to the caller — i.e. to this repo. That is a materially different thing from
> what this ticket is parked on: the boot failure recorded here is by design an application
> decision, not an upstream defect.
>
> **Except that the decision cannot currently be executed from here, and THAT is an upstream
> defect.** The upstream ticket states its contract as "a consumer's boot path can catch
> `reason === 'cohort-unreachable'` and proceed under its own risk model with no further plumbing".
> True for a consumer calling `db-core` directly; false for a consumer reading through SQL, which is
> every read this repo makes. `OptimysticModule` catches the typed error and rethrows
> `new Error(message)` with no `cause`, so the class and its `reason` field are destroyed and only
> the interpolated sentence survives — which is exactly why the failure recorded above is only
> visible here as prose. Quereus's own wrapper above it *does* thread `cause` faithfully, so the
> plugin is the sole broken link.
>
> Filed upstream as `optimystic/tickets/fix/2-a-sql-caller-cannot-see-why-a-read-failed`
> (`repro: static` — read from code, not run), citing this ticket as the waiting consumer.
>
> **Suggested re-shaping, for whoever owns this here.** The unblock condition is no longer "upstream
> must make an isolated boot read succeed". It is two smaller things:
>
> - upstream makes the reason reachable (the ticket above); and
> - this repo decides its own boot-read policy — which of the four reasons a bring-up read may
>   proceed past on this node's own view, and which must still fail. `'cohort-unreachable'` during
>   bring-up is a plausible tolerate; `'claimed-elsewhere'` is not, since tolerating it would serve
>   a knowingly false absent.
>
> The ticket's own alternative — retire this and open a fresh one against the boot failure that
> actually fires, rather than the stream-reset symptom never reached in five isolated rounds — looks
> better than ever under that framing. Still a human's call; nothing has been retired.
