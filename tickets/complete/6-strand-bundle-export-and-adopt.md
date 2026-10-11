description: Let a node bundle up everything its cadre knows about its strands (the strands, their keys, pending joins, open invitations and the addresses of the other members) and let a node of another cadre, run by the same owner, seat that bundle in its own cadre, so an app's strands can follow the app into the user's main cadre.
prereq: app-joins-existing-cadre-by-invitation
architecture: docs/architecture.md#moving-the-apps-strands
files: packages/cadre-core/src/strand-move.ts, packages/cadre-core/test/strand-move.spec.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/joined-strand-store.ts, packages/cadre-core/src/index.ts, docs/architecture.md, docs/strands.md
difficulty: hard
----

# Complete: export a cadre's strands as a bundle, and adopt a bundle into another cadre

The cadre-core half of moving an app's strands from the one-node cadre it founded (party B) into the cadre the user lives in (party A). The kit's half is `move-strand-between-cadres`; the real-network proof is `scenario-strand-moves-between-cadres`. Both import this ticket's exports.

## What landed (`ticket(implement): strand-bundle-export-and-adopt`, plus this review's fixes)

- **`packages/cadre-core/src/strand-move.ts`.** `exportStrandBundle(node)` reads the party's own strands and its joined strands (the `JoinedStrand` table and this machine's unpublished records, one entry per id, `own` wins), each with its party key, saved routing table and carried addresses; every pending join with its outcome; and every invitation still redeemable (unexpired, uses left after the usage count). `adoptStrandBundle(node, bundle)` refuses up front with `StrandMoveSamePartyError` or `StrandMoveNotOwnerError`, then seats strands, then invitations, then pending joins, every step insert-if-absent, and returns a `StrandMoveReport` (`moved`, permanent `refused`, transient `failed` over strands, invitations and pending joins, and three counts).
- **Per-strand order:** saved routing table and carried addresses (only when the adopting node holds none), then the party key, then the row (`publishStrand` for `own`, an owner-signed `insertJoinedStrand` for `joined`, skipped when an identical row is there). The refusal is decided from a read before any write, so a retry reports it again instead of failing on a write.
- **`ControlDatabase.queryFormationInvites()`** and the named `FormationInviteRow` type shared with `queryFormationInvite`; `JoinedStrandSession.unpublishedRecords()`; three `CadreNode` accessors (`listUnpublishedJoinedStrands`, `getCarriedStrandAddrs`, `recordCarriedStrandAddrs`); exports from `index.ts`.
- **Docs:** `docs/architecture.md` → "Moving the app's strands" (the rows that move, the two ends, the write order and why, the founder rule, invitations, pending joins, what stays in B) and one sentence on each of the five re-seated control-table rows; `docs/strands.md` → "What a joiner's node remembers" says a one-machine party keeps its joins machine-local and a move exports those. The `NOTE:` about party-private app tables is at `adoptPendingJoin`.

## Review findings

**Read first:** the implement diff (`ticket(implement): strand-bundle-export-and-adopt`), then the handoff. Every writer the module calls was read for the behaviour the module assumes of it: `publishStrand` (its repeat path compares `Type` and the read secret only, never the founder column, so an adopted row survives the retry), `ensureStrandPartyKey` (throws on a differing key, adopts a concurrently landed equal one), `insertJoinedStrand`, `insertJoinRequest` and `recordJoinOutcome` (the outcome write checks the live stamp and outcome kind, both of which the adopted request satisfies), `insertFormationInvite`, `wireOwnKeyIfOwner`, the joiner's `adoptFormationMembershipInvite` (a joined closed strand in B always holds a `StrandPartyKey`, so the bundle carries it), `membershipInvitesToStage` and the membership reconciler, and the `JoinRequest` / `JoinSuccess` schema constraints (digests only, no timestamp rule a moved row could break). The two dependent tickets' expectations of the API were checked against the shapes: the kit's "delete the record once nothing is under `failed`" rule and its `refused: Array<{ strandId, reason }>` record both match, and the scenario's "uses reduced by one" matches `usesLeft`.

**Found and fixed inline (minor):**

- **A bound invitation whose host strand is absent from the adopting party was copied as a dead row and counted as moved.** `unpublishStrand` leaves a strand's bound `FormationInvite` rows behind, and `insertFormationInvite` does not check the host, so a bundle from a B that had unpublished a strand carried an invitation A could never honour (the formation recorder refuses every redemption against a missing host). The adopt rule is now: bound to a strand that failed this time, deferred; bound to a strand not under `moved` (refused, or never in the bundle), dropped and counted; which subsumes the old refused-only check. Doc sentence under "Invitations" updated. One spec case added for it (`drops an invitation bound to a strand this party does not seat, and moves an unbound one`), which is also the invitation path's only unit coverage.
- **`adoptStrandBundle` on an unstarted node threw `wireOwnKeyIfOwner`'s error** instead of the module's own. The started check now comes first.
- **`recordCarriedStrandAddrs` logged under the `formStrand:` prefix.** `recordFormationStrandAddrs` takes a caller label; both call sites pass theirs.
- **A `joined` outcome for a refused strand** still moves its pending join; the reconciler, finding the party's member row seated, burns the invitation unspent or drops it dead. Confirmed from the reconciler's contract and stated in `adoptPendingJoin`'s doc comment so the next reader does not re-derive it.

**Checked and left alone:**

- A closed `own` entry with a null party key (B's publish committed its row but the mint failed before export) is seated through `publishStrand`, which mints a fresh key in A. Correct: no membership was seated under any key in B, so nothing is shadowed.
- Carried addresses are in-memory on the exporting node and empty after an app restart; the persisted routing table carries the peers then. Documented on the bundle type.
- The refusal pre-check and the write are not atomic (handoff gap). The writes re-check and the strand is reported `failed` then `refused` on retry; the window is one read on a node whose watcher mints only for rows it published. Accepted as the handoff describes.
- Invitation drop counts are per report, not cumulative; the kit reads the report per adoption. Fine.
- Export does one party-key read and, per invitation, one usage count: a handful of rows on a phone. Not worth batching.

**Tests:** the implementer's two cases were kept. The write-order assertion spies on real database methods and pins the stated contract (party key and peers before the row), not an incidental order; the export round-trip is the only coverage export gets and is cheap. One case added, above. Nothing cut.

**Tripwires:** none new. The accepted `NOTE:` on party-private app tables at `adoptPendingJoin` stands; its revisit condition (the blocked decision landing) has not tripped.

**Tickets filed:** none. Nothing found reached the filing bar; the one defect was fixed at its site.

**Validation (2026-10-11):** `yarn lint` exit 0; `yarn workspace @serfab/cadre-core typecheck` exit 0; `yarn workspace @serfab/cadre-core build` exit 0 (dist current for the two dependent tickets); `yarn workspace @serfab/cadre-core test` 165 files, 2445 passed, 1 skipped (pre-existing, in `tickets/.pre-existing-known.md`), 132 s; log at `tickets/.logs/strand-bundle-export-and-adopt.review.test.log`.

**Line endings:** the edited files are LF on disk; git reports it will normalise them to CRLF on the next touch, as it did for the implement commit.
