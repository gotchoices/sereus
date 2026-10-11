description: Let a node bundle up everything its cadre knows about its strands (the strands, their keys, pending joins, open invitations and the addresses of the other members) and let a node of another cadre, run by the same owner, seat that bundle in its own cadre, so an app's strands can follow the app into the user's main cadre.
prereq: app-joins-existing-cadre-by-invitation
architecture: docs/architecture.md#moving-the-apps-strands
files: packages/cadre-core/src/strand-move.ts (new), packages/cadre-core/test/strand-move.spec.ts (new), packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/joined-strand-store.ts, packages/cadre-core/src/index.ts, docs/architecture.md, docs/strands.md
difficulty: hard
----

# Review: export a cadre's strands as a bundle, and adopt a bundle into another cadre

The cadre-core half of moving an app's strands from the one-node cadre it founded (party B) into the cadre the user lives in (party A). The kit's half (when to export, when to adopt, where the bundle is kept) is `move-strand-between-cadres`; the real-network proof is `scenario-strand-moves-between-cadres`. Both depend on this ticket's exports.

## What landed

- **`packages/cadre-core/src/strand-move.ts` (new, 526 lines by `wc -l`).** `exportStrandBundle(node)` reads the party's own strands, its joined strands (the `JoinedStrand` table and this machine's unpublished records, one entry per id, `own` wins), each with its party key, saved routing table and carried addresses; every pending join with its outcome; and every invitation still redeemable (unexpired, uses left after the usage count). `adoptStrandBundle(node, bundle)` refuses up front with `StrandMoveSamePartyError` or `StrandMoveNotOwnerError` (via `wireOwnKeyIfOwner`), then seats strands, then invitations, then pending joins, every step insert-if-absent, and returns a `StrandMoveReport`.
- **Per-strand order:** saved routing table and carried addresses (only when the adopting node holds none for the strand), then `ensureStrandPartyKey(id, partyKey)`, then the row (`publishStrand` for `own`, an owner-signed `insertJoinedStrand` for `joined`, skipped when an identical row is there). The refusal is decided from a read before any write (`strandRefusal`), so a retry reports it again instead of failing on a write.
- **`ControlDatabase.queryFormationInvites()`** and a named `FormationInviteRow` type, which `queryFormationInvite` now returns too (same shape, one shared mapper).
- **`JoinedStrandSession.unpublishedRecords()`** (straight from the store, no last-good fallback: an export must fail loudly, not export fewer strands) and three `CadreNode` accessors: `listUnpublishedJoinedStrands()`, `getCarriedStrandAddrs(id)`, `recordCarriedStrandAddrs(id, addrs)`.
- **Exports** from `index.ts`: the two functions, the two errors, `StrandBundle`, `StrandBundleEntry`, `FormationInviteEntry`, `StrandMoveReport`, `StrandMoveFailure`, and `FormationInviteRow`.
- **Docs:** `docs/architecture.md` gained the subsection "Moving the app's strands" under "An app joins an existing cadre" (the rows that move, the two ends, the write order and why, the founder rule, invitations, pending joins, what stays in B), one sentence on each of the five control-table rows that are re-seated, and a pointer from the existing "not open on the phone until they are moved" sentence. `docs/strands.md` → "What a joiner's node remembers" says a one-machine party keeps its joins machine-local and a move exports those. The `NOTE:` about party-private app tables is at `adoptPendingJoin` in `strand-move.ts`, pointing at `tickets/blocked/decide-party-private-labels-and-app-state.md`.
- The cadre-core `dist` was rebuilt so the two dependent tickets import the new module.

## Where this deviates from the implement ticket, and why

- **`FormationInviteEntry` carries `validationUrl`.** The report comes from adoption, and the ticket wants a `ValidationUrl` row counted under `invitationsDropped`, so export has to carry the field. Export still leaves out spent and expired rows silently.
- **`StrandMoveReport.failed` is `Array<{ kind: 'strand' | 'invitation' | 'pending-join'; id; reason }>`**, not `Array<{ strandId; reason }>`. A transient write failure on an invitation or a pending join has to reach the caller, or the kit's rule "delete the move record once nothing is under `failed`" would discard the bundle with those rows unmoved. `refused` keeps the ticket's `{ strandId, reason }` shape; only strands are ever refused. An invitation's `id` is the id a join request for it would carry (`pendingJoinId(token)`), never the bearer token.
- **`networkState` is an optional property** rather than `PersistedNetworkState | undefined`, so a bundle parsed back from JSON type-checks.
- **An invitation bound to a strand that failed this time is deferred** (not written, not counted), not dropped: the retry that seats the strand copies it. One bound to a refused strand is dropped and counted, as specified.
- **A pending join's outcome is written after a conflict** when the live request is still pending and has every request column equal to the bundle's. This closes the crash window between the request insert and its outcome insert (otherwise a `joined` outcome's unredeemed membership invitation would be lost) without touching a request A made on its own, which has its own `RequestedAt`.
- **Cross-kind rows refuse even for open strands.** An `own` entry whose id A holds as a `JoinedStrand`, or a `joined` entry whose id A holds as its own `Strand`, is refused whether or not a party key is involved. The ticket only spelled out the closed-strand (party-key mismatch) case; the open case would otherwise seat a shadowed duplicate the watcher's existing `NOTE:` says never to create from a poll.
- **`FounderOwnerKey` of an `own` entry is not carried.** The bundle keeps `Id`, `Type`, `MemberPrivateKey` only, as the ticket's `Pick` says; in A the row is always signed by the app's key, which is the point of the founder rule.

## How to exercise it

```ts
// On B's running node, before the switch:
const bundle = await exportStrandBundle(nodeB);
// ...carry `bundle` as JSON across the switch (it holds secrets)...
// On A's running node, once the app's key is an owner there:
const report = await adoptStrandBundle(nodeA, bundle);
// report.moved / report.refused (permanent) / report.failed (adopt the same bundle again)
```

Adopting the same bundle a second time is the resume path and must report the same result.

## Tests

`packages/cadre-core/test/strand-move.spec.ts`, two cases on one real self-owner node each (`startSelfOwnerNode`), hand-built bundles with real key material:

- **Adopts the same bundle twice onto one row per table per strand, seating the party key and peers before the row.** One closed `own` strand (with a routing table and one carried address) and one closed `joined` strand. After two adoptions: one `Strand` row, one `JoinedStrand` row, one `StrandPartyKey` row per strand, the stored party keys equal the bundle's, both ids under `moved`, nothing refused or failed, both reports equal. The write order is pinned with `vi.spyOn` on `insertStrandPartyKey` / `insertStrand` / `insertJoinedStrand` (`invocationCallOrder`), the network state and carried addresses are read back, and `exportStrandBundle` on the adopting node returns both entries, which is the only coverage export gets.
- **Refuses a strand this party already participates in under its own identity, and still moves the others.** A different party key is seated for the `own` strand first. Expected: that id under `refused` with its reason, the `joined` strand under `moved`, nothing failed, the pre-existing key untouched, no `Strand` row written.

Validation run (2026-10-11): `yarn lint` clean; `yarn workspace @serfab/cadre-core typecheck` clean; `yarn workspace @serfab/cadre-core test` 165 files, 2444 passed, 1 skipped (pre-existing), 120 s; log at `tickets/.logs/strand-bundle-export-and-adopt.test.log`.

## Known gaps for the reviewer

- **Not unit-tested, by the ticket's choice:** export's reading of the three sources beyond the round-trip assertion above, the invitation arithmetic (`usesLeft`, expiry, the `ValidationUrl` and bound-to-refused drops), pending-join adoption (insert, outcome, the conflict path), the two typed up-front refusals, and the transient `failed` path. The integration scenario (`scenario-strand-moves-between-cadres`) is where invitations and pending joins get exercised against a live responder.
- **The refusal pre-check and the write are not atomic.** A row landing between them makes `ensureStrandPartyKey` or `publishStrand` throw; the strand is reported `failed` this time and `refused` on the retry. Acceptable because the watcher mints only for a row this machine published and the window is one read.
- **`adoptStrandBundle` calls `wireOwnKeyIfOwner`**, which also installs the seed bootstrap on a node that did not have one. That is that method's existing behaviour and is what a joined start calls anyway; the spec's node reaches it through `startSelfOwnerNode`, which enrolls the key but wires nothing, so the spec also covers adopting on a node whose seed bootstrap was wired by the adoption itself.
- **Invitation drops are counted per call.** A `ValidationUrl` row is counted under `invitationsDropped` on every adoption of the bundle, so the count is per report, not cumulative.
- **`recordCarriedStrandAddrs` logs under the `formStrand:` prefix**, since it is a one-line wrapper over `recordFormationStrandAddrs`. Cosmetic.
- **Docs timing.** The sentence "B's strands are not open on the phone until they are moved" stays as is with a link; `move-strand-between-cadres` rewrites it once the kit runs the move at join time.
- **Line endings.** The edited files were written with LF; git reports it will normalise them to CRLF on the next touch, and `git diff --stat` shows only the intended lines changed.
