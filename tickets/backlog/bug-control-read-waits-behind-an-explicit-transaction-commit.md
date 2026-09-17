description: Reading the shared party settings can still stall for tens of seconds while certain multi-step settings changes (removals, re-issued revocations, invitation redemptions) finish committing to a slow machine, because the database refuses the "read the last committed state" shortcut while such a change is open.
files: packages/cadre-core/src/control-database.ts, ../quereus/packages/quereus/src/core/database.ts, packages/cadre-core/test/control-read-routing.spec.ts
repro: static
severity: edge-case
likelihood: unusual
tradeoffs: The fix most likely needs a new Quereus option (a caller declaring "this read is not part of the open transaction"), which is an upstream API decision, and the stall only shows up when a removal or redemption overlaps a read while a cohort member is slow.
----

# A control read still waits behind an explicit-transaction commit

## Background

`ControlDatabase.readRowsOnce` sends a control read to Quereus's committed-read path (`readConcurrency: 'committed'`, which runs off the database's exec mutex) whenever a write is in flight, so reads do not wait for a write's slow network commit. `control-read-queues-behind-a-write-waiting-for-the-database` widened "in flight" to cover a write still waiting for the mutex.

That path is refused inside an **explicit** transaction. `Database._isConcurrentReadEligible` (`../quereus/packages/quereus/src/core/database.ts`) returns false when `!getAutocommit() && !isImplicitTransaction()`, so the read silently falls back to the serialized path. Quereus does this on purpose: a read issued inside a `BEGIN … COMMIT` must see that transaction's own rows, and Quereus cannot tell such a read from one issued by an unrelated caller.

`ControlDatabase` can tell them apart: reads issued outside a locked write body pass `retry: true`, reads inside pass `retry: false`.

## The defect (two arms, one site)

`ControlDatabase.inTransaction` opens an explicit transaction for every multi-statement control write: `deleteGuardedRow` (strand, peer, device-token and validation-key removals), `reissueRevocations`, and formation redemption.

- **Arm 1, waiting.** `Database.commit()` runs `exec("COMMIT")`, which holds the exec mutex for the whole network commit. Against a slow cohort member that is 20 to 55 s (measured in `control-write-degraded-cohort-member.integration.ts`). An unlocked read that arrives during it takes the serialized path and waits for all of it. The integration suite's 15 s read deadline would fail on such an overlap.
- **Arm 2, reading uncommitted rows.** Between the statements of an explicit transaction the mutex is free. An unlocked serialized read that lands there runs inside the writer's open transaction and sees its uncommitted rows, for example a guarded row already deleted but its tombstone not yet written. If the commit then fails, the read reported a state that never existed. The window is short: the body issues its next statement a few microtasks later.

Both arms were inferred from the Quereus source, not observed. To confirm, add a case to `control-read-routing.spec.ts`: a `withWriteLock` body that runs `begin`, one statement, and then holds before `commit`. An unlocked read issued during the hold should show arm 2, reading the uncommitted row. Holding the mutex inside `COMMIT` shows arm 1.

## Expected behaviour

An unlocked control read never waits for a locked write of any shape, and never observes a locked write's uncommitted rows. Worth pinning as one general spec that runs every `inTransaction` caller as well as the single-statement writers.

## Likely directions (not settled)

- A Quereus option for a read that declares it is not part of the open transaction, which makes it eligible for the committed path during an explicit transaction. That is an upstream API change in the same area as `../quereus/tickets/backlog/feat-concurrent-reads-database-default.md`.
- Removing explicit transactions from `ControlDatabase` is not an option. The delete and its tombstone must commit together (`Strand.RevocationRecorded` refuses a bare delete).
