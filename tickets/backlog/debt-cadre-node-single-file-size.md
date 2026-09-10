----
description: The main node class in the core library has grown into a single 4,770-line file covering many unrelated jobs, which makes it slow to read, review, and change safely.
files: packages/cadre-core/src/cadre-node.ts
difficulty: hard
tradeoffs: Splitting the central class touches almost every test in the package and risks churn-for-churn's-sake; a maintainer may reasonably prefer to leave it whole until a concrete change is actually made painful by the size.
----

# `cadre-node.ts` has become a catch-all file

`CadreNode` is the library's entry point — the object an embedding app constructs and
drives. Over time nearly every new capability has been added as more methods on that one
class, and the file it lives in is now much larger than anything else in the package.

Measured 2026-08-13 with `wc -l`:

```
4770  packages/cadre-core/src/cadre-node.ts
1273  packages/cadre-core/src/types.ts
 535  packages/cadre-core/src/strand-instance-manager.ts
 187  packages/cadre-core/src/strand-database.ts
```

The next-largest source file is under a third its size, and `types.ts` is a declarations
file rather than logic.

## Why this is worth writing down

Nothing is *broken*. The cost is felt when working on it:

- A reader looking for one behaviour has to scroll past a dozen unrelated ones.
- A reviewer cannot hold the class's invariants in their head, so changes get judged
  locally rather than against the whole object's lifecycle.
- Unrelated concerns share one `this`, so any new field is implicitly reachable from
  every method — the class has no internal boundaries to enforce.

This was noticed while reviewing an unrelated change (the strand-mode retirement, which
*shrank* this file slightly). It is pre-existing, and no single edit caused it.

## Distinct jobs currently living in the file

Listed as observation, not as a proposed split — where to cut is the open question, and
some of these are only a handful of methods:

- Control-network lifecycle: start/stop, genesis, owner keys, self-registration.
- Peer management: adding drones/phones, invitations, revocation, seed bootstrap.
- Strand launch and teardown: `addStrand`, `launchStrand`, cohort-seed resolution.
- Hibernation orchestration: wake, check-in, resume, service-wake windows.
- Strand formation: solicitation, disclosure, open invitations.
- Relay and delegate handling: circuit-relay targets, delegate announcements/grants.
- Push/wake fan-out and device tokens.

## What "done" would look like

Some of those jobs move behind their own module with an explicit interface, and
`CadreNode` becomes the thing that wires them together rather than the thing that
implements them. The public API an embedder sees (`CadreNode`'s methods) should not
change — this is an internal reorganization, not a redesign.

Deciding whether the reorganization is worth its churn — and which seam to cut first —
is the actual open question. A maintainer may well decide the answer is "not yet".

## Evidence: it is still growing

Re-measured 2026-08-15 with `wc -l packages/cadre-core/src/cadre-node.ts`: **5,073** lines,
up from the 4,770 recorded above on 2026-08-13. The growth is one feature —
`merge-strand-peer-addrs-into-strand-peerstore` — landing four more methods
(`connectedSiblingTargets`, `refreshStrandPeerAddrs`, `refreshOneStrandPeerAddrs`,
`mergeStrandPeerAddrs`) plus a constant and a throttle map on the class. They belong with
the relay/delegate-handling group in the list above: all of them are periodic control-mesh
maintenance riding the reconcile pass, and none of them touch `CadreNode`'s public API. If
a first seam is ever cut, that group is now large enough to be a plausible candidate.

## Re-measured 2026-08-18 (review of `control-revocation-reissuable-tombstone`)

`wc -l packages/cadre-core/src/cadre-node.ts` → **5104** lines, up from the 4770 recorded
above on 2026-08-13. The revocation drain/queue work added another self-contained
subsystem (`pendingRevocations`, `noteGuardedDelete`, `drainPendingRevocations`,
`reconstructAuthoredMembership`) as more methods on the same class. Evidence for the
existing ticket, not a new one — the growth rate is the point.

## Re-measured 2026-09-09 (review of `strand-founding-resume-path`)

`wc -l packages/cadre-core/src/cadre-node.ts` → **6075** lines, up from the 5104 recorded
above on 2026-08-18 — roughly +19% in three weeks, and now well past the 4770 the ticket
was opened at. The resume-path work contributed ~230 of that: `foundStrand`,
`adoptPublishedStrand`, and two module-level helpers (`strandRowMismatches`,
`requireMatchingStrandRow`), all of them strand-founding logic landing on the same class
as everything else. They belong with the "strand launch and teardown" group in the list
above, which — with `addStrand`, `launchStrand`, `publishStrand`, `unpublishStrand`,
`foundStrand`, `handleStrandAdded`, `handleStrandRemoved` and cohort-seed resolution — is
now the largest of the seven jobs listed. Evidence for the existing ticket, not a new one.

## Re-measured 2026-09-10 (review of `strand-party-member-key`)

`wc -l` → **6496** `packages/cadre-core/src/cadre-node.ts`, **2803** `packages/cadre-core/src/control-database.ts`. The node file is up from the 6075 recorded above on 2026-09-09; the party-key work contributed ~160 lines as three more methods on the same class (`ensureStrandPartyKey`, `resolveStrandPartyKey`, plus the resolution threaded through `launchStrand`/`addStrand`/`publishStrand`). Again the "strand launch and teardown" group.

Worth noting alongside it: `control-database.ts` is now the package's second-largest source file at 2803 lines, and the same pattern produced it — one class accumulating a method pair per control table (`queryX` / `queryXStampId` / `insertX` / `deleteX`), now nine tables' worth, plus the lock/retry/transaction machinery and the revocation sweep. The measurement table at the top of this ticket (which put the next-largest file at 535 lines) is stale by a wide margin; if a seam is ever cut in `CadreNode`, the per-table writer groups in `ControlDatabase` are the same kind of cut and worth considering in the same pass. Evidence for this ticket, not a new one.
