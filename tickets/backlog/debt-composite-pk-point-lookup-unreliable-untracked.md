description: The database layer has a shortcut for "fetch exactly one row by its full primary key" that can silently come back empty on a networked strand; one caller was rewritten to avoid it, but nothing fixes or tracks the shortcut itself, and nobody has checked which other callers still lean on it.
files: ../optimystic/packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/cadre-core/src/strand-member-registry.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/strand-membership-writer.ts
difficulty: hard
----

## Background

When a query puts an equality on **every** primary-key column of a table, the optimystic
virtual-table module reports the predicate as fully handled and serves the read as a single
point lookup — one tree descent for one encoded key — instead of a scan. Because the module
claims the predicate, the SQL engine adds no filter of its own and does not re-check
anything: whatever the descent returns *is* the result.

On a networked strand that descent has been observed to miss — returning **zero rows for a
row that provably exists**. A caller that reads "zero rows" as "absent" then does the wrong
thing.

`member-peer-exists-composite-seek-robustness` (complete) removed one such caller: the
`registerMemberPeer` insert-if-absent guard now filters on the *leading* key column only
(a partial primary-key match, which the module explicitly declines to handle, so it is
served by a scan) and re-compares both key columns in JavaScript. That made **that one
call site** independent of the shortcut. It did not fix the shortcut, and no ticket
anywhere tracks fixing it — the upstream slug the plan stage went looking for
(`optimystic-networked-composite-pk-seek-unreliable`) does not exist on optimystic's board;
every stage folder plus `complete/` was checked.

## Why this is worth a ticket

Two open questions, neither answered by the work that landed:

**1. Is the failure specific to multi-column keys?** The evidence so far says probably yes,
but nobody has confirmed it. The observed failure was on `Strand.MemberPeer`, whose primary
key is two columns, `(MemberKey, PeerId)`. In the *same* networked scenario
(`packages/integration-tests/src/scenarios/strand-membership-closed-strand-e2e.integration.ts`)
single-column primary-key reads — `Strand.Invite where Key = ?`, `Strand.Member where
Key = ?`, `Strand.Manager where MemberKey = ?` — were observed working. A single-column
primary key with an equality also satisfies "every key column has an equality", so it takes
the *same* code path. If the bug is in how a multi-column key is encoded for the descent
(likely, but unverified), single-column lookups are safe; if it is in the descent itself,
they are not.

**2. Which callers still use the shortcut?** A repo-wide grep found **no** remaining
full-*multi*-column primary-key lookups in `packages/` (the only two-column equality,
`FormationUsage where Token = ? and StrandId = ?` in `strand-formation-consent.spec.ts`,
matches no key column at all — that table's key is the single column `UsageStampId` since
`formation-unique-token-redesign` — so it is served by a scan and is unaffected).
Single-column primary-key lookups, however, are ordinary and widespread, e.g.:

- `packages/cadre-core/src/strand-member-registry.ts:164` — `isMemberRegistered` reads
  `select count(1) from Strand.Member where Key = ?`. A miss here reports an existing
  member as unregistered, and the enrollment path re-admits them.
- `packages/cadre-core/src/control-database.ts` — several control-database reads keyed by
  their primary key (`CadreControl.Strand where Id = ?`, `CadrePeer where PeerId = ?`,
  `DeviceToken where PeerId = ?`, `FormationInvite where Token = ?`).

Whether any of these are actually at risk depends entirely on question 1. That is the point
of the ticket: **decide, once, with evidence** — rather than rewriting call sites one at a
time on suspicion, or leaving a known-unreliable read shape in the hot path unexamined.

**3. Secondary-index seeks are a third shape, and one now sits under an authorization rule.**
Added by review of `formation-unique-token-redesign`. That change declared
`index FormationUsageByToken on FormationUsage (Token)`, so
`ControlDatabase.countFormationUsage` — `select count(1) from FormationUsage where Token = ?` —
is now served by a descent through a *separate* index collection instead of the table scan it
got before, when `Token` was a leading primary-key column with no full-key equality (a shape
the module explicitly declines). No miss has been observed on an index seek; the point is that
nobody has checked, and this particular count is what enforces an invitation's use limit, so an
under-count admits a member the invitation did not pay for. Whatever question 1 concludes about
descents should cover index descents too, not only primary-key ones. The code site carries a
`NOTE:` pointing here.

## What "done" looks like

- A reproduction of the miss, isolated enough to say whether it is multi-column-key specific.
  (This is currently hard to reach from sereus: the closed-strand end-to-end scenario fails
  at strand bring-up on the blocked `control-db-convergence-optimystic-p2p` issue, so the
  networked path is not exercisable here until that clears. A reproduction inside optimystic
  itself is likely the faster route.)
- Either a fix in optimystic (the descent or the key encoding), or a documented statement of
  exactly which lookup shapes are safe on a networked strand and which are not.
- If single-column lookups turn out to be affected too, follow-up tickets for the call sites
  above — that would be a live correctness bug in enrollment, not hardening.

## Out of scope

Rewriting call sites pre-emptively. The scan-and-filter-in-JS shape used by
`memberPeerExists` is correct but costs a full table scan; applying it everywhere would be a
real performance regression for a risk that may not exist.
