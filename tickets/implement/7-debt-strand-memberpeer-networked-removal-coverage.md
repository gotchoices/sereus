----
description: Prove on two real networked machines that a member can delete its own device record and that a manager can clear the leftover device records of a member it removed — today both paths are only tested inside a single process.
files: packages/integration-tests/src/scenarios/strand-membership-closed-strand-e2e.integration.ts, packages/cadre-core/src/strand-membership-writer.ts (removeMemberPeer, listMemberPeers, scanMemberPeers, memberPeerStampId), packages/cadre-core/test/strand-membership-peer-rotation.spec.ts (existing single-process coverage — read, do not duplicate), schemas/strand.qsql (MemberPeer, Revocation), docs/architecture.md (line ~623, end-to-end coverage paragraph)
difficulty: medium
----

# Networked coverage for `MemberPeer` removal

## Baseline (verified at HEAD, 2026-07-30)

`yarn workspace @serfab/integration-tests test strand-membership-closed-strand` — **1 passed**,
test body 2.46 s, file 12.8 s. The scenario used to die at strand bring-up on the blocked
`control-db-convergence-optimystic-p2p` issue; that ticket is in `complete/`, the failure is no
longer in `tickets/.pre-existing-known.md`, and the run above confirms it. The best-effort
bootstrap-replication probe in step 4 logged `sync=true`, so `Strand.*` rows do reach the joiner
DB in practice.

That means the extension this ticket asks for is now actually runnable, and the stale warning in
`docs/architecture.md` ("⚠️ That assertion is written but has **not yet executed**") is wrong and
must be corrected as part of this change.

## What already exists (do not re-test it)

`packages/cadre-core/test/strand-membership-peer-rotation.spec.ts` covers, in **bootstrap mode**
(single process, no network), the whole `removeMemberPeer` surface: self branch, manager branch,
stranger rejection, orphan survival across revocation, the enumerate-then-clear loop, remove-one-
leave-siblings, absent-row no-op, `NoUpdate`, and the same-transaction-manager rejection. None of
that needs repeating. **Permission/rejection semantics are settled; this ticket is about the
network.**

What has never run over a real network: any `removeMemberPeer` call at all, `listMemberPeers`, and
the absence probe (`memberPeerStampId`) returning "absent" for a row that really is gone.

## Design

### A second `it`, not more steps on the existing one

Do **not** append removal steps to the existing `it`. Two reasons:

1. **The file's own rejection floor forbids it.** The header states that a rejected write is
   asserted only to `throw` — post-state rollback is not asserted — so no count or enumeration
   assertion is sound after the first rejected write. Step 7 of the existing test attempts an
   impostor `MemberPeer` insert under **the joiner member's own key** (`joinerMember.publicKeyB64`,
   `PeerId = 'peer-impostor'`). If that rejected insert leaked a row, `listMemberPeers(joiner)`
   would legitimately return `['peer-impostor']` and any appended `toEqual([])` would be asserting
   against contaminated state.
2. The existing `it` is already ~220 lines of narrative; removal deserves its own clean strand.

So: extract the bring-up into a helper and add a second `it` in the same file with its own
two-node strand. Runtime cost is roughly another 2.5 s.

### The bring-up helper

Factor the existing lines "two real CadreNodes" through "manually connect strand-level libp2p +
best-effort sync probe" (currently steps 1–4 of the single `it`) into:

```ts
interface ClosedStrandFixture {
	founderNode: CadreNode;
	joinerNode: CadreNode;
	founderStrand: /* the addStrand result type */;
	joinerStrand: /* same */;
	founderDb: Database;
	joinerDb: Database;
	founderKeyPair: Ed25519KeyPair;   // strandMemberKeyPair(memberPrivateKey)
	/** True when the founder's bootstrap rows were observed on the joiner DB. */
	syncObserved: boolean;
}

async function bringUpClosedStrand(label: string): Promise<ClosedStrandFixture>
```

- The bootstrap assertions currently in steps 1–2 (founder has exactly `Header`/`Member`/`Manager`,
  joiner has none before the dial) are bring-up invariants — move them **into** the helper so both
  tests get them.
- The helper must stop any node it started if it throws partway, then rethrow — otherwise a
  bring-up failure leaks live libp2p nodes into the rest of the file.
- Each `it` still owns its own `try { … } finally { await joinerNode?.stop(); await founderNode?.stop(); }`.
- `label` distinguishes the party ids (`closed-${label}-${Date.now()}`) so the two tests never
  share identifiers.
- The existing `it` must keep passing verbatim after the extraction — run it before and after.

### The new `it`: "clears device records on a real two-node strand"

Narrative, in order (order matters — see *Edge cases* below):

1. Bring up via the helper. Admit a plain member `M` (fresh keypair) through the real
   `issueInvite` → `consumeInvite` flow against the founder DB. **`M` is never promoted to
   manager** — a manager cannot lose membership (`Member.NotAManager`), and this test needs to
   revoke it.
2. `M` registers **two** devices: the joiner node's real strand peer id
   (`joinerStrand.libp2pNode!.peerId.toString()`) and a second synthetic id. Capture each row's
   `StampId` (scan `select MemberKey, PeerId, StampId from Strand.MemberPeer`, filter in JS — see
   the lookup-shape rule below) for the tombstone assertion in step 4.
3. `listMemberPeers(founderDb, M)` sorted equals both ids. This is the first networked execution
   of the leading-key scan as a *public* enumeration.
4. **Self removal.** `removeMemberPeer(founderDb, { memberKeyPair: M, peerId: secondPeerId })`.
   Assert `listMemberPeers` now equals `[joinerPeerId]`, and that a `Strand.Revocation` row exists
   with `TableName = 'MemberPeer'` and the removed row's `StampId` — proving `RevocationRecorded`
   was satisfied by a networked write, not just a bootstrap one.
5. **Revoke `M`,** `revokeMember(founderDb, { managerKeyPair: founderKeyPair, memberKey: M })`.
   Assert the `Member` row is gone (JS-filtered scan) **and** that `listMemberPeers(founderDb, M)`
   still returns `[joinerPeerId]` — orphan survival, now on a real network.
6. **Manager cleanup.** The loop the feature exists for:
   `for (const peerId of await listMemberPeers(founderDb, M)) await removeMemberPeer(founderDb, { managerKeyPair: founderKeyPair, memberKey: M, peerId })`.
   Assert `listMemberPeers(founderDb, M)` is `[]`.
7. **Restart-safe re-clear.** Calling `removeMemberPeer` again for the same `(M, peerId)` resolves
   quietly (`resolves.toBeUndefined()`). This is the absence probe answering "absent" for a row
   that is genuinely gone, over the network — the exact read shape that misbehaved before
   `member-peer-exists-composite-seek-robustness`.
8. **Cross-node visibility** — see the observe-then-require rule below. Woven into steps 3/4/6
   rather than bolted on at the end.
9. **Loud-failure backstop, LAST** (it is a rejected write, so nothing may assert counts after
   it). Register a `MemberPeer` row for the **founder's own** member key, then attempt a bare
   `Strand.Revocation` insert naming that live row's `StampId`, correctly signed, and expect it to
   throw. Build it inline, mirroring `insertRevocation` in the writer:

   ```sql
   insert into Strand.Revocation (TableName, StampId)
     with context MemberKey = ?, Signature = ?
     values (?, ?)
   ```
   with `Signature = signStrandApproval(['Strand.Revocation', 'retire', 'MemberPeer', stampId], founderKeyPair.privateKeyB64)`.
   `Revocation.RowIsGone` rejects retiring a stamp whose row is still visible.

   **Why this is the right stand-in for the untestable case.** The ticket's third expectation — "if
   the exact-key lookup misses, the removal reports a clear failure rather than quietly claiming
   success" — cannot be provoked on demand: the miss is nondeterministic, and there is no
   fault-injection seam (do not add one). But the mechanism that *converts* a missed delete into a
   loud failure is `Revocation.RowIsGone`: the tombstone filed in the same transaction refuses to
   retire a stamp whose row is still there, so a zero-row delete fails at commit instead of
   returning success. Pinning that constraint on a networked strand pins the failure behaviour.
   Note it does not itself depend on the unreliable read: `RowIsGone`'s subquery filters on
   `P.StampId`, which is not a key column of `MemberPeer`, so it is served by a scan.
   The JS re-check in `removeMemberPeer` ("still present after delete") sits behind `RowIsGone` and
   stays unexecuted; say so plainly in the handoff rather than claiming it is covered.

   Also worth stating honestly: if the point-lookup miss *does* occur during a run, this test
   fails loudly instead of passing. That is the real ongoing value — the scenario becomes a
   detector for `debt-composite-pk-point-lookup-unreliable-untracked`.

### Observe-then-require: how to assert cross-node without flake

The file's standing convention is that `Strand.*` replication to the joiner DB is observed and
logged, never gated. The ticket asks for "both nodes see it gone". Reconcile them with a
conditional gate, stated in one sentence: **if the joiner saw the rows appear, it must also see
them disappear.**

- Before the first removal, `waitUntil` (8 s, 250 ms) for `listMemberPeers(joinerDb, M).length === 2`,
  inside a `try/catch` that sets `peersVisibleOnJoiner`. Log the outcome, do not assert it.
- After each removal, **if `peersVisibleOnJoiner`**, `waitUntil` for the joiner's list to match the
  founder's — and let that `waitUntil` throw (i.e. it *is* a gate). Otherwise `console.log` that
  the cross-node check was skipped because the rows never replicated.
- This never flakes on a slow/absent replica, but it does catch the failure that matters: a delete
  that lands on the founder and never propagates.

### Lookup-shape rule for the new assertions (easy to get wrong)

Assertions that something is **gone** must not be served by a read shape that can falsely report
"gone". An equality on *every* primary-key column is exactly that shape (see
`scanMemberPeers`' doc comment and `debt-composite-pk-point-lookup-unreliable-untracked`). So in
the new test:

- `Strand.Revocation` PK is `(TableName, StampId)` — **never** query it as
  `where TableName = ? and StampId = ?`. Scan `select TableName, StampId from Strand.Revocation`
  and match in JavaScript.
- `Strand.Member` PK is the single column `Key` — an equality on it is also a full-PK predicate.
  For the "member is gone" assertion, scan `select Key from Strand.Member` and filter in JS.
  (The existing `it` uses `where Key = ?` for *presence* assertions; a miss there would fail the
  test rather than pass it, so those stay as they are — do not churn them.)
- Peer enumeration always goes through `listMemberPeers`, which already scans.

## Edge cases & interactions

- **Ordering: self-removal must precede the revocation.** `Revocation.Authorized` verifies the
  tombstone filer against `committed.Member`. Once `M` is revoked it can no longer file a
  tombstone, so a self-branch `removeMemberPeer` by `M` after revocation would fail on the
  tombstone, not on the delete. That is correct behaviour, not a bug — but it means the self case
  belongs before step 5.
- **`M` must not be a manager.** `Member.NotAManager` rejects un-membering a key that still holds a
  `Manager` row. If a future edit promotes `M`, `removeManager` must come first.
- **`Member.MinOneMember`.** Founder + `M` = 2 members; revoking `M` leaves 1. Do not revoke the
  founder.
- **Rejection floor.** Exactly one rejected write in the new `it`, and it is last. No enumeration
  or count assertion may follow it.
- **Multi-device.** Removing one of `M`'s two devices must leave the sibling row intact —
  asserted in step 4, and it is what makes the enumeration in step 3 non-trivial.
- **Idempotence / partial failure.** The re-clear in step 7 is the restart path: a cleanup loop
  interrupted halfway and re-run must not throw on the already-cleared entries.
- **Node teardown.** Both the helper's failure path and each `it`'s `finally` must stop both nodes.
  A leaked `CadreNode` will hang or cross-talk with the sibling test in the same file.
- **Distinct identifiers per test.** Party ids, strand ids (the mock provisioner counter is
  per-call, so give each bring-up its own provisioner instance), and member keypairs must not
  collide between the two `it`s.
- **Concurrency is out of scope.** Nothing here drives two writers at one strand; the
  check-then-write race in `removeMemberPeer`/`registerMemberPeer` is already documented as a
  `NOTE:` and is not this ticket's job. Say so in the handoff rather than leaving it implied.

## Expected outcomes

- `packages/integration-tests` scenario file: 2 tests passing, both under the existing 60 s budget
  (expect ~3 s each).
- The founder DB ends the new test with `listMemberPeers(M) === []`, a `Strand.Revocation` row per
  removed binding, no `Member` row for `M`, and the founder's own device row still present.
- Where replication was observed, the joiner DB agrees.
- `docs/architecture.md` no longer claims the networked re-register assertion has never executed.

## TODO

- Read `packages/cadre-core/test/strand-membership-peer-rotation.spec.ts` first — the semantics are
  already pinned there; this ticket adds network, not rules.
- Extract `bringUpClosedStrand(label)` from the existing `it` (steps 1–4, including the bootstrap
  and joiner-empty assertions and the best-effort sync probe). Stop nodes and rethrow on internal
  failure.
- Re-run the existing scenario after the extraction and confirm it still passes unchanged.
- Add the second `it` ("a member clears its own device record and a manager clears a revoked
  member's leftovers") following the step order above.
- Implement the observe-then-require cross-node checks; log the skip path explicitly.
- Add the `Revocation.RowIsGone` rejection as the final step, with a comment saying why it stands
  in for the unprovokable point-lookup miss.
- Apply the lookup-shape rule to every "is gone" assertion (JS-filtered scans, never full-PK
  equality).
- Update `docs/architecture.md` (~line 623): drop the ⚠️ "has not yet executed" sentence, record
  that the scenario now runs green at HEAD, and add one clause that removal — self and
  manager-after-revocation — plus the orphan-survival and restart-safe re-clear cases are now
  covered on a real two-node strand.
- Check `docs/strands.md` → "Removing Members" reads correctly against the new coverage; it
  currently states the behaviour accurately, so change it only if something is actually wrong.
- Run: `yarn lint`, `yarn typecheck`, `yarn workspace @serfab/integration-tests test strand-membership-closed-strand`
  (stream with `| tee`), then the full `yarn workspace @serfab/integration-tests test` to confirm
  no collateral. Report any pre-existing failures per the pre-existing-failure rules — do not skip
  or loosen anything.
- Handoff must state plainly: the `"still present after delete"` JS re-check in `removeMemberPeer`
  remains unexecuted (RowIsGone fires first), concurrency is untested, and the cross-node
  assertions are conditional on replication having been observed.
