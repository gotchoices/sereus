description: Review the new end-to-end test proving a second computer can genuinely join a private group using its own local database, plus the tightening of previously-optional replication checks into required ones.
prereq:
files: packages/integration-tests/src/scenarios/strand-membership-closed-strand-e2e.integration.ts, docs/architecture.md, docs/STATUS.md
difficulty: medium
----

## What landed

Test-only + docs change. **No production code was touched** — `cadre-core`'s writers,
the schema, and the harness are all untouched. The whole diff is three files:

| File | Change |
|---|---|
| `packages/integration-tests/src/scenarios/strand-membership-closed-strand-e2e.integration.ts` | two best-effort probes promoted to throwing gates; one new test; header rewritten |
| `docs/architecture.md` (~lines 630–634) | the two existing paragraphs corrected, one new paragraph for the third test |
| `docs/STATUS.md` (lines 734, 812) | `closed-strand 1/1` → `3/3` |

### Phase 1 — replication observations became gates

Two places in the scenario used to *observe* cross-node replication inside a
`try {} catch {}`, set a boolean, log it, and never assert. Both are now plain
`await waitUntil(...)` that throw on timeout, at `15_000 ms` / `250 ms`:

- `bringUpClosedStrand` — the founder's `Header`/`Member`/`Manager` bootstrap rows
  becoming visible on the joiner. `syncObserved` is gone from `ClosedStrandFixture`
  and from the log line.
- the removal test — M's two `MemberPeer` rows becoming visible on the joiner.
  `peersVisibleOnJoiner` and the skip branch inside `requireJoinerAgrees` are gone;
  it now always requires. Its own `waitUntil` budget was raised `8_000` → `15_000`
  for consistency.

Measured convergence is well under a second, so 15 s is a wide margin, not a hope.

### Phase 2 — the third test

`a joining node runs the join against its OWN database and both nodes converge`,
with its own bring-up labelled `joiner-db` (disjoint party ids / strand ids / member
keys from the two siblings). Sequence — all accepts, then the single reject last:

1. Founder `issueInvite`. The `invitePrivateKey` is handed to the joiner side
   directly, modelling out-of-band delivery of the invite secret to the invitee (a
   comment in the test says so).
2. Gate: that `Strand.Invite` row visible on `joinerDb`.
3. **`consumeInvite(joinerDb, …)`** with a fresh member keypair. The deferred
   constraints — `Member.Authorized`'s invite branch, `ConsumedInvite.ValidUsage` /
   `NotExpired` / `NotCancelled` — all resolve against rows the *founder* authored.
4. Assert `Strand.Member` + `Strand.ConsumedInvite` on `joinerDb` immediately (the
   writer's transaction committed; no wait).
5. **Gate: both rows visible on `founderDb`.** This is the headline — a membership
   write authored on the joiner reached the founder.
6. `registerMemberPeer(joinerDb, …)` binding the joiner's real strand peer id; gate
   it into `listMemberPeers(founderDb, …)`.
7. A signed `App.Items` insert authored on `joinerDb` by the newly-admitted key;
   gate `Name`/`Value`/`CreatedBy` on `founderDb`.
8. LAST: `consumeInvite(joinerDb, …)` against a *second* founder-issued invite with
   a wrong invite private key `rejects.toThrow()`.

Teardown uses the same `try { … } finally { await stopBoth(...) }` shape.

## Verification actually run

From `packages/integration-tests`:

```
yarn test src/scenarios/strand-membership-closed-strand-e2e.integration.ts
```

- **6 consecutive runs, every one 3/3 green.** (5 required; a 6th after the final
  comment-only edits.) Per-test wall clock stayed steady: ~1.6 s / ~1.6 s / ~1.0 s.
  No gate ever came close to its 15 s budget.
- `yarn typecheck` in `packages/integration-tests` — exit 0.
- `yarn lint` at repo root — **exit 0**, 0 errors.

## Known gaps — please probe these

Ordered roughly by how much they'd bother me if I were reviewing.

- **Six runs on one machine is a weak flake sample.** Everything here is libp2p over
  loopback on a fast box; there is no latency, packet loss, or CPU contention. The
  gates are now hard failures, so if convergence is slower than ~15 s under CI load
  this file starts failing the whole suite where it used to log and pass. That is the
  intended tradeoff (the ticket says a timeout is a real convergence defect, not a
  reason to weaken the gate) — but it is the change most likely to bite later, and it
  is worth a reviewer running the file a few more times, ideally under load.
- **"Visible from the founder" is not "physically replicated to the founder."** A read
  on either node resolves one coordinator peer per block; when that resolves to the
  authoring node, the other node's `select` is a remote call against the author's
  storage. Every cross-node assertion in this file, old and new, asserts *visibility*.
  This is stated in the file header and in `docs/architecture.md`, and the stronger
  proof is parked in `backlog/debt-strand-replication-vs-visibility-proof` (which
  already existed). **Do not read the new test as proof of replication.**
- **The sApp write proves convergence, not a second authorization check.** The
  fixture's `AuthorizedWrite` is pure signature RBAC over `Id|Name|Value` and never
  reads `Strand.Member`. Step 7 therefore shows a layer-3 write authored on the joiner
  reaching the founder — it does not re-prove that membership gates sApp writes.
- **The joiner never exercises the manager path.** No `addManager`, `revokeMember`,
  or `removeMemberPeer` is issued from `joinerDb`. Those writers' deferred branches
  read `committed.Manager`, and whether they resolve as cleanly from the second node
  as `consumeInvite` does is *untested*. This was out of the ticket's scope; if the
  reviewer thinks it belongs, it is a new ticket, not an inline fix.
- **No concurrent writes.** The ticket explicitly scoped these out. The sequence is
  strictly ordered (founder issues → joiner consumes). Two nodes writing the same
  table at the same instant remains untested, as does the JavaScript "still present
  after delete" re-check inside `removeMemberPeer` (it sits behind `RowIsGone`).
- **Only this one file was re-run**, not the full integration suite. The diff is
  confined to one test file plus two docs files — no production code — so nothing else
  can be affected, but I did not prove that by running the rest.
- **Pre-existing lint warnings, not mine.** `yarn lint` reports 6 warnings (0 errors,
  exit 0) in `packages/integration-tests/src/scenarios/zz-scratch-delete-alone.integration.ts`
  — unused `eslint-disable` directives. That file is committed and belongs to the
  in-flight `control-delete-while-alone-tombstone` work, not this ticket. Left alone.

## Things worth a second opinion

- The header's `WHERE THE WRITER LIFECYCLE RUNS (and why)` section was rewritten and
  now carries four claims: the first two tests are founder-authoritative *by design*
  (for accept/reject breadth), the third is joiner-authored, replication is gated
  everywhere, and visibility ≠ physical replication. The lookup-shape rule and the
  rejection floor below it are unchanged. Worth checking those four claims still match
  the code after the diff.
- The new test uses full-PK where-equalities for its presence assertions
  (`Strand.Invite where Key = ?`, `Strand.Member where Key = ?`, `App.Items where
  Id = ?`). Per this file's lookup-shape rule that is *allowed* — a point-lookup miss
  on a presence assertion fails the test rather than passing it. But note the
  interaction with the gates: a miss inside a `waitUntil` just retries, so an
  unreliable point lookup would surface as a 15 s timeout rather than an obvious
  wrong-answer failure. Six runs showed no sign of it; flagging the failure *shape* so
  a future timeout isn't misdiagnosed.
- `docs/architecture.md`'s first closed-strand paragraph now says the founder-DB
  choice "buys accept/reject breadth cheaply" rather than implying it was forced by
  unreliable replication. Check that framing reads as intended.
