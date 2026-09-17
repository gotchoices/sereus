description: A machine that has just joined a shared chat strand and writes its participant and first message straight away still loses that write most of the time, even though the new first-sync gate now holds it back until it has received the strand's data; the remaining cause is in the optimystic storage layer (a machine cannot read a row it just committed), so this ticket waits on that fix and records how to confirm it.
files:
  - packages/integration-tests/src/scenarios/strand-chat-participants-converge.integration.ts (test "a joiner that writes IMMEDIATELY after addStrand resolves still converges — nothing is lost (the device shape)")
  - packages/cadre-core/src/strand-first-sync-gate.ts (the gate: Header held AND every App table read once)
  - docs/strands.md ("Joining: no writes before the first sync", the residuals list)
repro: verified
----

# What is wrong

The regression scenario for the joiner write gate has three cases. Two pass reliably. The third, the "device shape" (the joiner writes its participant row and a message the instant `addStrand` resolves, exactly as the reference chat app does), is intermittent:

| gate variant | runs | passed | failure seen |
| --- | --- | --- | --- |
| Header row held only (as implemented) | 4 | 1 | 1 × foreign-key check failed on the message insert; 2 × joiner never converged within 30 s (silent fork) |
| Header held AND a count read of every `App` table settled (as reviewed and kept) | 5 | 1 | 4 × foreign-key check failed on the message insert |

Measured 2026-09-16 over direct loopback connections, against the optimystic plugin build at commit `6302f2e8` (the same-named-tables fix). The implementer saw the test pass once before that rebuild.

The failing check is `CHECK constraint failed: _fk_Message_ParticipantId`, raised at the commit of the joiner's message insert. The joiner had inserted its own participant row in the statement immediately before, and that commit reported success. So the joiner cannot read a row it committed a moment earlier, on a table whose collection it had already fetched from the host (the gate read it before publishing the database). That is not the fork the gate exists to prevent; it is a read-your-own-write defect below sereus.

# Why it is blocked, not fixable here

The optimystic session (`optimystic-4e`, 2026-09-16) reviewed the measurement and is filing it on its own board as a separate fix, distinct from its cohort-assembly work: in a two-party strand every collection resolves to the same cohort, so cohort assembly is ruled out. Its caveat: the failure was observed against the build that also broke sereus's warm-restart tests (the `ALTER COLUMN` error on `CadreControl.CadrePeer`, tracked through `tickets/.pre-existing-error.md`), so it may not survive that fix.

Nothing in sereus can make the write land: the gate already ensures the joiner holds the Header and has fetched every app-table collection before the app is allowed to write. Loosening the test would hide the loss.

# What to do when optimystic reports the fix

1. Rebuild the linked optimystic packages, then run the scenario alone at least five times:

```
cd packages/integration-tests
npx vitest run --reporter=verbose src/scenarios/strand-chat-participants-converge.integration.ts -t "IMMEDIATELY"
```

2. Five passes: delete this ticket; the gate's contract is then demonstrated end to end and `docs/strands.md`'s "A joiner's own write can still be lost after the gate opens" residual can be removed.
3. Still failing on the foreign-key check: send optimystic the run log (`tickets/.logs/`), it is theirs.
4. Failing on the 30 s convergence timeout instead (the silent fork is back): that is a sereus gate question again. Move this to `fix/` with the log; the question is which collection the joiner wrote to without having fetched it, readable with the scenario's `readBlockIndex` helper on the joiner's captured raw storage.
