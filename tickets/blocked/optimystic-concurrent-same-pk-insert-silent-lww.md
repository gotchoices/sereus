----
description: The shared database library in the sibling optimystic checkout lets two writers insert a row with the same key at the same moment and silently keeps only one of them, telling both writers they succeeded; the schema's safety rules assume such a duplicate would be refused.
files: ../optimystic/packages/db-core/src/collection/collection.ts, ../optimystic/packages/quereus-plugin-optimystic/src/optimystic-module.ts, schemas/control.qsql
difficulty: hard
repro: verified
----

# Blocked (b): optimystic silently last-writer-wins on a concurrent same-primary-key insert

**Category (b) — a dependency outside this repo.** Unblock: an `@optimystic/db-core`
change making a commit whose primary key (or unique value) was taken by a concurrent
committed writer FAIL at merge/sync rather than replace the earlier row — surfacing as
the ordinary `UNIQUE constraint failed: …` / `CHECK constraint failed: …` errors the SQL
layer raises for a sequential duplicate. Land it in `../optimystic`, rebuild
(`cd ../optimystic && yarn build`), then re-run the measurement below.

## What was measured (2026-08-02, sereus `53e54bd`, optimystic `092f33f`)

Full detail lived in this ticket's predecessor, `formation-use-number-lost-update-cross-node`
(deleted from `tickets/blocked/` when the human accepted the redesign below; recover it via
`git log -- "tickets/blocked/28-formation-use-number-lost-update-cross-node.md"`); the
three experiments, condensed:

1. **Two real nodes, same PK.** Two `CadreNode`s, replication cohort confirmed at 2 on
   both sides, both inserting `FormationUsage (Token, UseNumber=1)` in the same tick:
   both promises FULFILLED, exactly one row survives on both nodes' views (the
   second writer's). No error anywhere.
2. **One node, two database handles** over one local store: identical shape. Two writers
   the local write queue cannot see suffice; two machines are not required.
3. **Discriminator — different PKs**, same setup: both rows survive (ordinary eventual
   convergence). The loss is specific to a shared primary key: the second commit
   replaces the first instead of being refused.

Where: the SQL layer's key probe and deferred CHECKs run against a snapshot taken before
the other writer's row exists, so both pass; when the two commits merge in
`@optimystic/db-core`'s `Collection` commit/sync path (reached through
`quereus-plugin-optimystic`'s virtual table), that decision is never re-made — the
surviving row is whichever landed second.

The predecessor ticket's boot recipe for re-measuring (connect nodes BEFORE the first
control write, confirm `readCohort` ≥ 2 on both sides, race `Promise.allSettled`, write
traces with `appendFileSync` because vitest swallows `console.log` there) still applies.

## Why this stays on the board after the formation redesign

The formation flow that surfaced this — sequence-numbered invitation acceptances — is
being redesigned to never share a primary key between concurrent writers
(`tickets/plan/28-formation-unique-token-redesign.md`), which removes THAT flow's
exposure. It does not fix the primitive. `schemas/control.qsql` still leans on "a
duplicate insert is refused" elsewhere:

- `Strand`'s consent branch enforces a strand id may be consent-seated once, EVER, via
  not-exists clauses over committed rows — a silently replaced row undermines the trace
  those clauses read.
- Every `StampId text not null unique` anti-replay column (`Strand`, `FormationInvite`,
  device/peer tables) assumes a repeated stamp is refused, not last-writer-wins.
- `Revocation` / `RevocationRecorded` pairs assume a tombstone row, once committed,
  cannot be silently displaced by a concurrent writer.

The schema's own comments already accept a narrower convergence-window caveat ("unique is
evaluated against LOCALLY VISIBLE rows"); this defect is broader — it holds even in a
converged, confirmed two-member cohort.

## What to do on unblock

Re-run the measurement (experiments 1 and 3 are the cheap discriminators). If the loser's
error message is a new third shape, callers classifying constraint errors need a matching
arm — grep `packages/cadre-core/src` for the message patterns then in use. No sereus
ticket is prereq-chained to this slug; the formation redesign proceeds independently.
