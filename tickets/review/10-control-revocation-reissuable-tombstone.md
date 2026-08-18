description: Review the finished feature that lets a node re-broadcast a member-removal record it wrote while it was offline or alone, so the removal actually reaches the rest of the group once other machines come back.
files: schemas/control.qsql (~691-800, table Revocation), packages/cadre-core/src/control-database.ts (~677-860 read paths, ~1589-1640 reissueRevocations), packages/cadre-core/src/cadre-node.ts (~2415-2480 drainPendingRevocations, ~4435-4510 membership read paths), packages/cadre-core/src/control-authorization.ts, packages/cadre-core/test/control-revocation-reissue.spec.ts, packages/cadre-core/test/control-revocation-replay.spec.ts, packages/cadre-core/test/control-constraint-helpers.ts, packages/cadre-core/test/membership-gate-helpers.ts, packages/cadre-core/test/cadre-node-authorized-surface.spec.ts, packages/cadre-core/test/control-stream-authorization.spec.ts, packages/cadre-core/test/membership-connection-gater.spec.ts
difficulty: medium
----

## What the feature is

When an owner removes a member from a party, the removal is recorded as a **tombstone** row in
the `CadreControl.Revocation` table. If that removal commits while the node is alone (no other
machine connected), the row commits locally and is never broadcast — so every other node still
believes the removed member is a member.

The feature makes such a tombstone **re-issuable**: a `ReissuedAt` integer counter on the row
that an owner can bump with a fresh signature. Bumping it is a write, and a write replicates, so
the previously-stranded tombstone reaches the cohort on the next growth edge. The counter itself
carries no meaning — retirement is decided by the tombstone's *existence*, never by its value. It
exists only to give the row something legal to change.

Alongside the write side, the feature **moved the revocation filter into the database read
layer**. `ControlDatabase.queryCadrePeers` now drops rows whose `StampId` is retired before any
caller sees them, so the membership gates inherit the exclusion instead of each re-implementing
it. That relocation is the part most likely to have left a hole: any read path that bypasses
`queryCadrePeers` no longer gets the filter.

The original spec ticket `control-revocation-reissuable-tombstone` was deleted as it moved
through the pipeline — read it from git history at commits `d1aac1c`, `a0b0f82`, `4d470e1`.

## Where the pieces live

**Schema** — `schemas/control.qsql`, `table Revocation` (~691):

- `ReissuedAt integer not null default 0`
- `FreshTombstone check on insert (new.ReissuedAt = 0)` — a tombstone cannot be seated at an
  already-high counter, which would otherwise let an owner freeze its own future re-issues.
  Deliberately NOT folded into the insert-side signed digest.
- `ReissueOnly check on update` — identity triple unchanged and `new.ReissuedAt > old.ReissuedAt`.
  An update may move the counter and nothing else, upward only. Without the identity clause an
  "update" would be a way to re-point a tombstone at a different row, restoring the replay this
  table exists to stop.
- `AuthorizedReissue check on update` — an owner must sign a `reissue`-tagged digest over
  `(TableName, RowKey, StampId, ReissuedAt)`. Distinct action tag from the insert-side `remove`,
  so neither signature replays as the other.
- `NoDelete check on delete (false)` — retirement is permanent.

**Write path** — `ControlDatabase.reissueRevocations` (`control-database.ts:1589`): signs each row
outside the lock (a retry must re-present the exact bytes, never re-mint), then one UPDATE per row
inside a single transaction. Any constraint refusal rolls the whole batch back and propagates.

**Drain** — `CadreNode.drainPendingRevocations` (`cadre-node.ts:~2440`): the first successful pass
per process sweeps every locally-held tombstone (the only cover for a removal made before this
process started); later passes only in-session queued ones. Best-effort — failure leaves the queue
and the sweep flag intact for the next growth edge.

**Read paths** — `queryCadrePeers` / `queryPeerRecord` filter via `queryRevokedStamps`;
`queryRevocations` is deliberately raw, since it is what the drain enumerates.

## Validation state (what I actually ran, 2026-08-18)

From `packages/cadre-core`:

- `yarn test` → **100 files, 1552 passed, 1 skipped, 0 failed**
- `yarn typecheck` → exit 0

From repo root:

- `yarn lint packages/cadre-core` → exit 0

The 1 skipped test is `key-store.spec.ts:231`, gated `skipIf(platform === 'win32')` — a POSIX
file-permission check, unrelated to this feature and skipped by pre-existing design, not by me. No
test in this feature is skipped, `todo`-marked, or has loosened assertions.

The integration suite was NOT run — it belongs to `control-revocation-drain-on-growth` (now in
`complete/`) and several of its scenarios are red upstream for reasons already recorded in
`tickets/.pre-existing-known.md`.

### The engine bug these tests found

The reissue tests initially failed with `UNIQUE constraint failed: Revocation.TableName,
Revocation.StampId` on a counter-only UPDATE that never touched the primary key. That was a real
upstream storage-engine defect, not a test bug — filed and resolved as
`10-revocation-reissue-same-pk-update-unique-collision` (now in `complete/`), cleared by the
`@optimystic/*` 0.24 / `@quereus/quereus` ^4.14 dependency wave. Worth knowing while reading these
specs: several of their comments are shaped by that history.

## Test coverage as it stands (a floor, not a ceiling)

- `control-revocation-reissue.spec.ts` — **9 tests**, new for this feature: happy-path bump;
  identity frozen under `ReissueOnly`; counter strictly monotonic (equal and lower refused);
  wrong-digest and non-owner refused by `AuthorizedReissue`; owner-signed delete refused by
  `NoDelete`; non-zero seat refused by `FreshTombstone`; `reissueRevocations` batch commit plus
  stale-counter rollback; a production removal disappearing from every membership read with
  re-admission minting a fresh stamp; a live row planted at a retired stamp reading as absent from
  the membership queries while staying physically present.
- `control-revocation-replay.spec.ts` — 35 tests. The constraint probes now each isolate a single
  rejector (`NoDelete` / `ReissueOnly` / `AuthorizedReissue`) rather than asserting one blanket
  "immutable". "Unsigned" in these suites means a *present* `with context` clause bound to nulls —
  omitting the clause outright dies at plan time instead, which is fail-closed but not the named
  rejection the probe pins.
- `cadre-node-authorized-surface.spec.ts` (11), `control-stream-authorization.spec.ts` (26),
  `membership-connection-gater.spec.ts` (25) — their fake `queryCadrePeers` now pre-filters revoked
  stamps, mirroring the real database contract. Each keeps a retired-member test whose *meaning*
  changed: the peer is refused because the membership read never surfaces it, not because the node
  re-filters after the read.
- Shared fixtures live in `control-constraint-helpers.ts` (signing/stamp helpers plus
  `reissueMessage`) and `membership-gate-helpers.ts` (row builders plus `inject`).

## Suggested review focus — where I would look first

**Read paths that skip the filter.** The filter moved from the node into
`ControlDatabase.queryCadrePeers`. Every caller that reads member rows some *other* way now
silently lacks it. `queryRevocations` is raw on purpose; the question is whether anything else is
raw by accident. Worth grepping `src/` for direct `CadrePeer` selects and asking of each whether a
retired stamp should be visible there.

**Test fakes drifting from the real contract.** Three suites now hand-mirror `queryCadrePeers`'s
filtering inside a fake. That is a copy of a production invariant with nothing enforcing the copy
stays true — if the real filter changes shape, the fakes keep passing while the gates rot. Whether
that warrants a shared fixture or a contract test is a fair call to make.

**Point-lookup avoidance.** Both `reissueRevocations` and the replay-spec probes key on `StampId`
alone, deliberately, because equality on the full composite primary key has been observed returning
zero rows for a row that provably exists (tracked separately as
`debt-composite-pk-point-lookup-unreliable-untracked`). Comments at both sites say not to "fix"
this by adding `TableName` to the where clause — verify nothing in the diff quietly did.

**Sweep cost.** `drainPendingRevocations`'s first pass is one UPDATE plus one owner signature per
tombstone ever written, in a single transaction, once per process lifetime. `Revocation` is
append-only and unbounded. A comment at the site already records this and names the fix (a
persisted high-water mark of what has been re-issued while connected), plus the `Math.max(...)`
spread's roughly 10^5-argument ceiling. I did not measure any of it — treat the magnitude as
unmeasured.

## Known gaps I am flagging rather than papering over

- **Re-issue success is not proof of broadcast.** A successful `reissueRevocations` exec proves
  only that the local commit landed; the connection that fired the growth edge may not be in the
  affected block's cluster. Pre-existing and tracked as
  `backlog/control-rereplication-broadcast-confirmation` — the drain inherits that gap knowingly,
  and a full disconnect/reconnect (or the next process's sweep) re-covers it.
- **No integration-level proof in this ticket.** Everything above is unit-level. The end-to-end
  claim — a removal made while alone actually reaches a peer that connects later — rests on the
  drain ticket's scenarios, which I did not run.
- **Concurrent owner devices sweeping at once** resolve by the loser failing `ReissueOnly` and
  retrying with a fresh counter on its next sweep. That is asserted at the constraint level (a
  stale counter rolls the batch back) but never exercised with two genuinely concurrent writers.
