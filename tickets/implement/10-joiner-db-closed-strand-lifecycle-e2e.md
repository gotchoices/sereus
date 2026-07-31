----
description: Prove that a second node can genuinely join a private group by running the join against its own local database, and that both nodes end up agreeing — instead of the current test, which does all the work on the first node's database.
prereq:
files: packages/integration-tests/src/scenarios/strand-membership-closed-strand-e2e.integration.ts, packages/cadre-core/src/strand-membership-writer.ts, docs/architecture.md, docs/STATUS.md
difficulty: medium
----

## Background

`strand-membership-closed-strand-e2e.integration.ts` is the capstone end-to-end test
for closed-strand membership (invite issue/consume, member device records, manager
rotation, signed sApp write) across two real `CadreNode`s over libp2p.

Today **every** writer call in that file runs against the **founder's** strand
database. The "joiner" node contributes only its real libp2p peer id; the joining
member is a keypair admitted into the founder's database. Cross-node replication of
the founder's bootstrap rows is *observed and logged*, never asserted — the file
calls this "best-effort" because deferred-constraint-bearing `Strand.*` rows were
suspected of replicating unreliably under the manual-wire setup.

**That suspicion is now disproven.** Research done during planning (see *Evidence*
below) stood up the full joiner-authored flow against a scratch probe and ran it
repeatedly: bootstrap rows replicate, the joiner can consume an invite against its
own database, and every resulting row is visible from the founder — 9 consecutive
green runs, each finishing in ~2 s against 15 s waits. The work below turns that
observation into gated coverage.

Note on naming: the plan-stage ticket used the old table name `Authority`. The
schema calls it **`Manager`** (renamed by `2-rename-strand-authority-to-manager`).
Use `Manager` throughout.

## Evidence gathered during planning

A throwaway probe (written, run, then deleted — it is not in the tree) exercised
this exact sequence and passed **9/9 consecutive runs**:

1. Bring up the two-node closed strand exactly as `bringUpClosedStrand` does.
2. **Gate** (not observe) the founder's `Header`/`Member`/`Manager` replicating to
   the joiner — succeeded every run, well inside a 15 s budget.
3. Founder `issueInvite`; wait until the `Strand.Invite` row is visible on the
   joiner's database.
4. **Joiner** runs `consumeInvite(joinerDb, …)` — succeeded. The deferred
   constraints (`Member.Authorized`'s invite branch, `ConsumedInvite.ValidUsage`,
   `NotExpired`, `NotCancelled`) all resolved against rows the founder authored.
5. The new `Strand.Member` and `Strand.ConsumedInvite` rows became visible on the
   **founder's** database.
6. **Joiner** runs `registerMemberPeer(joinerDb, …)` binding its own real strand
   peer id — succeeded, and became visible on the founder.
7. **Joiner** authors a signed `App.Items` insert with the newly-admitted key —
   succeeded, and the row became visible on the founder. (The sApp fixture's
   `AuthorizedWrite` constraint is pure signature RBAC over
   `Id|Name|Value`; it does not read `Strand.Member`, so this proves layer-3
   write convergence, not a second membership check.)
8. A `consumeInvite` on the joiner with the **wrong** invite private key was
   rejected.

The existing file also ran green in the same session (`sync=true` on both tests).

## Important honesty caveat — keep it in the file header

"Visible on the founder" is **not** the same as "the block physically replicated to
the founder". A read on either node resolves one coordinator peer per block; when
that resolves to the authoring node, the other node's `select` is a remote call
against the author's storage and nothing needs to live locally. The existing file
already states this (see its `requireJoinerAgrees` note) and the new coverage
inherits it verbatim. Visibility is the property an application actually observes,
and it is what this ticket asserts. Proving physical replication needs a different
technique (stop the authoring node first) and is parked as
`backlog/debt-strand-replication-vs-visibility-proof`.

## What to build

### Phase 1 — promote the replication observations to gates

In `bringUpClosedStrand`:

- Replace the `try { await waitUntil(…) } catch { syncObserved = false }` block
  around the founder-bootstrap-rows probe with a plain `await waitUntil(…)` that
  throws. Use `timeoutMs: 15_000`, `intervalMs: 250` (measured actual: sub-second).
- Drop `syncObserved` from `ClosedStrandFixture` and from the log line; keep a log
  line stating the bootstrap rows replicated.

In the `MemberPeer` removal test:

- Replace the `peersVisibleOnJoiner` observe-then-require dance with a plain gated
  `waitUntil` for M's two device rows on the joiner, and simplify
  `requireJoinerAgrees` to always require (drop the skip branch and its log).

If gating turns out to flake (see *Verification* — any failure inside 5 consecutive
runs counts), that is a **real convergence defect**, not a reason to restore the
best-effort path. Stop, leave the gate in place, and file a `fix/` ticket with the
failing output rather than weakening the assertion.

### Phase 2 — a third test: the joiner drives the join on its own database

Add one new `it(...)` to the same `describe`, with its own bring-up
(`bringUpClosedStrand('joiner-db')` — the label keeps party ids, strand ids and
member keys disjoint from the other two tests). Suggested title:

> `a joining node runs the join against its OWN database and both nodes converge`

Sequence (accept cases first, the single rejected write LAST — this file's
rejection floor forbids any count or enumeration assertion after a rejected write):

- Founder `issueInvite` with `founderKeyPair`. The returned `invitePrivateKey` is
  handed to the joiner side directly; that models the real flow, where the invite
  secret travels out of band to the invitee. Say so in a comment.
- `waitUntil` the `Strand.Invite` row is visible on `joinerDb`.
- `consumeInvite(joinerDb, { inviteKey, invitePrivateKey, memberKey })` with a
  fresh keypair for the joining member.
- Assert the new `Strand.Member` and `Strand.ConsumedInvite` rows on `joinerDb`
  immediately (local, no wait needed — the writer's transaction committed).
- `waitUntil` both rows are visible on `founderDb`. **This is the ticket's headline
  assertion**: a membership write authored on the joiner reached the founder.
- `registerMemberPeer(joinerDb, { memberKeyPair: joinerMember, peerId })` using the
  joiner's real `joinerStrand.libp2pNode!.peerId.toString()`; `waitUntil`
  `listMemberPeers(founderDb, joinerMember.publicKeyB64)` contains it.
- A signed `App.Items` insert authored on `joinerDb` by the newly-admitted member
  (reuse the file's existing `signItem` helper); `waitUntil` the row is visible on
  `founderDb` with the expected `Name`/`Value`/`CreatedBy`.
- LAST: `consumeInvite(joinerDb, …)` against a **second** founder-issued invite
  using a wrong invite private key `rejects.toThrow()` — proving the deferred
  constraints reject on the joiner's database too, not only on the founder's.
  Wait for that second invite to be visible on the joiner before attempting it.

Timeouts: `60_000` on the test (matching its siblings); `15_000`/`250 ms` on each
convergence `waitUntil`.

### Phase 3 — docs

- Rewrite the file's header section **"WHERE THE WRITER LIFECYCLE RUNS (and why)"**.
  It currently says the lifecycle runs founder-side and that cross-node replication
  is best-effort. Both statements become wrong. State instead: the first two tests
  are founder-authoritative by design (they exercise accept/reject breadth against
  the bootstrap-seated rows); the third test is joiner-authored and gates
  bidirectional convergence; replication of `Strand.*` is now **gated everywhere**
  in the file. Keep the lookup-shape rule, the rejection floor, and the
  visibility-vs-replication caveat — all three still apply unchanged.
- `docs/architecture.md` line ~630 (the paragraph describing this scenario) —
  replace "cross-node replication … is observed best-effort (and, in practice,
  observed reliably)" with the gated reality plus the new joiner-authored test.
- `docs/STATUS.md` — the `strand-membership-closed-strand-e2e` counts (lines ~734
  and ~812 say `1/1`; the file has held 2 tests for a while and will hold 3).
  Update to `3/3` once green.

## Edge cases & interactions

- **Lookup shape.** The file's rule stands: an assertion that a row is GONE must
  never use a full-primary-key where-equality (the optimystic module serves that as
  a point lookup that can MISS on a networked strand —
  `debt-composite-pk-point-lookup-unreliable-untracked`), so absence is scanned and
  filtered in JavaScript. Presence assertions may use an equality — a miss there
  fails the test instead of passing it. The new test is all-presence except the
  final rejection, so it may use equalities; the existing `memberKeys`,
  `memberPeerStamp`, `revocationExists` scan helpers are already there for reuse.
- **Rejection floor.** Rejected writes assert only `rejects.toThrow()`; no
  post-state rollback assertion, and no count/enumeration assertion after one.
- **`Strand.Invite` visibility before consume.** Do not skip the wait and rely on
  the constraint's own read — a not-yet-visible invite fails
  `ConsumedInvite.ValidUsage` at commit and would look like an authorization bug.
  The wait makes the precondition explicit.
- **Same member key admitted twice.** Do not reuse a member keypair across the
  three tests; each bring-up is a separate strand, but a shared keypair makes a
  cross-test leak invisible. Mint fresh per test (the existing `freshKeyPair`).
- **Bring-up fault path.** `bringUpClosedStrand` already stops both nodes and
  rethrows if anything inside fails. Turning the sync probe into a throwing gate
  routes a replication failure down that same path — verify the nodes still stop
  (a leaked live libp2p node hangs the whole run).
- **Teardown.** The new test must use the same `try { … } finally { await
  stopBoth(founderNode, joinerNode) }` shape. Three two-node bring-ups now run per
  file; confirm the file still exits cleanly.
- **Invite expiry.** `consumeInvite` canonicalises "now" via `canonicalDatetime`
  against the joiner's database. The founder issued the invite against its own.
  Both go through the same transform, so the comparison stays byte-comparable —
  but if a future default expiry is added, a slow test could straddle it. Leave
  the default (no expiry) alone; do not pass `nowMs`.
- **Cross-test ordering.** Vitest runs the three tests sequentially in one file.
  The new test must not depend on either sibling having run, and must not leave
  live nodes behind for them.
- **Concurrent writes are NOT in scope.** Nothing here has both nodes writing the
  same table at the same instant; the sequence is strictly ordered
  (founder issues → joiner consumes). Genuine concurrent membership writes from two
  nodes are a separate concern — do not add them here.

## Verification

Run from `packages/integration-tests`, streaming output:

```
yarn test src/scenarios/strand-membership-closed-strand-e2e.integration.ts 2>&1 | tee /tmp/closed-strand.log
```

- All **3** tests green.
- Repeat the whole file **5 consecutive times**; every run must be green. Any
  failure is a convergence defect — see Phase 1's note, do not weaken the gate.
- `yarn typecheck` in `packages/integration-tests` — exit 0.
- `yarn lint` at the repo root — exit 0.

## TODO

- Promote `bringUpClosedStrand`'s bootstrap-replication probe from best-effort to a
  throwing `waitUntil` (15 s / 250 ms); drop `syncObserved` from
  `ClosedStrandFixture`.
- Promote the removal test's `peersVisibleOnJoiner` probe to a gate; simplify
  `requireJoinerAgrees` to always require.
- Add the third test: founder issues invite → joiner sees it → joiner
  `consumeInvite` on `joinerDb` → assert locally → assert convergence to
  `founderDb`.
- Extend it with `registerMemberPeer` on `joinerDb` (real joiner peer id) and a
  signed `App.Items` write on `joinerDb`, each asserted to converge to the founder.
- Finish with the single rejected write: wrong-invite-key `consumeInvite` on
  `joinerDb` rejects.
- Rewrite the file header's "WHERE THE WRITER LIFECYCLE RUNS" section; keep the
  lookup-shape rule, rejection floor, and the visibility-vs-physical-replication
  caveat.
- Update `docs/architecture.md` (~line 630) and `docs/STATUS.md` test counts.
- Run the file 5× green, plus `yarn typecheck` and `yarn lint`.
