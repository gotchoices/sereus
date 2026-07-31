description: A node that added itself as a member at the same moment it published its own address record used to leave that record unsigned, so nobody could find it until the next refresh; the publish now notices it lost the race and re-signs.
prereq:
files: packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/seed-bootstrap.ts, packages/cadre-core/src/types.ts, packages/cadre-core/test/peer-record-resolution.spec.ts, packages/cadre-core/test/control-write-lock.spec.ts, docs/STATUS.md
difficulty: medium
----

## What was wrong

`CadreNode.publishSelfRecord` did a read-then-branch:

```
existing = queryPeerRecord(self)        <-- read
existing ? updateSelfPeerRecord(...)    <-- self-signed UPDATE
         : insertSelfPeerRecord(...)    <-- owner-signed INSERT
```

`insertSelfPeerRecord` funnels into `SeedBootstrapService.insertCadrePeerRow`, which
re-checks row existence *inside* the control-database write lock so two writers racing the
same peer's first row don't collide on the unique-key constraint — the loser no-ops. It
returned `void`, so the caller could not tell "I inserted" from "someone beat me".

If an owner `authorizePeer(self)` landed in the window between the read and the insert, the
authorize seated the row with a null signature (an owner cannot forge the peer's own
signature) and no addresses. The self-publish's insert then silently no-op'd and reported
`'inserted'` — but the row that existed was the authorize's. `resolvePeerAddrs` verifies the
signature against the stored public key, so the node was unreachable-by-lookup until the next
periodic self-registration (up to one heartbeat interval, ~7.5 min in the CLI).

## What changed

**`seed-bootstrap.ts`** — `insertCadrePeerRow` and `insertSelfPeerRecord` now return
`boolean`: `true` = this call performed the INSERT, `false` = the in-lock check found the row
already seated. `authorizePeer` ignores the value and stays `Promise<void>`.

**`cadre-node.ts`** — `publishSelfRecord` restructured. The no-row branch now falls through
to the self-update path when the insert reports `false`: it **re-reads** the row that actually
landed and **re-signs** against that row's `UpdatedAt`. The re-read matters — the
`CadrePeer.AuthorizedUpdate` self-branch demands a strictly greater `UpdatedAt` than the
stored row, and the pre-race read is not that row's stamp. Signing was lifted into a
`signSelfRecord` helper so both call sites share the monotonic-stamp rule. A `!current` guard
after the re-read returns `'skipped'` if the row vanished (a concurrent `removePeer`) rather
than signing against nothing. `PeerAddressRecord` added to the `./types.js` type import.

**`types.ts`** — `SelfRegistrationOutcome` doc updated: the raced path reports `'refreshed'`
(honest — the write really was an UPDATE), and `'skipped'` now also covers row-vanished.

**Docs** — `docs/STATUS.md` "Control DB local write serialization" now says the write-lock
spec pins the lock/uniqueness contract only, and points at where the recovery is covered.

## How to validate

Run in `packages/cadre-core`:

- `yarn typecheck` — exit 0 (also `yarn typecheck` at the repo root, all workspaces, exit 0).
- `yarn vitest run` — **78 files, 1216 passed, 1 skipped** (the skip is the pre-existing
  win32 `skipIf` at `test/key-store.spec.ts:231`, unrelated).
- `packages/cadre-cli`: `yarn vitest run` — 11 files, 147 passed.
- `yarn lint` at the root — exit 0. (6 warnings, all in
  `packages/integration-tests/src/scenarios/zz-scratch-delete-alone.integration.ts`, a file
  this ticket never touches — unused `eslint-disable` directives, pre-existing.)

### The two new tests

Both in `packages/cadre-core/test/peer-record-resolution.spec.ts`, driving a real Quereus
control DB via the file's existing `bootOwnerNode` fixture:

- **`carries a valid self-signature when an authorize lands mid-publish`** — the failing case.
  Deterministic, no timing luck: it wraps `ControlDatabase.queryPeerRecord` so the owner
  `authorizePeer(self)` is wedged into the exact window after the "does my row exist?" read
  returns null and before the INSERT. Asserts `wedged === true` (so a refactor that stops
  reading through that method fails loudly rather than silently passing), then that the stored
  row's signature verifies, that `resolvePeerAddrs(self)` is non-empty, and finally that the
  outcome is `'refreshed'`. The wrapper is restored before the assertions so a later read
  can't re-trigger it.
- **`keeps the self-signature when the authorize lands after the publish`** — the reverse
  order, which already worked. Cheap regression guard.

**Verified the first test actually catches the bug**: with the fall-through neutralized
(`insertSelfPeerRecord(record) || true`) it fails —
`AssertionError: expected 'inserted' to be 'refreshed'`. Note the assertion order was then
changed so the *signature* check fires first; against genuinely unfixed code
`verifyPeerRecordSignature(stored)` is what fails, which is the real defect.

### Changed existing test

`packages/cadre-core/test/control-write-lock.spec.ts` — the two first-row race orderings now
also assert the new `insertSelfPeerRecord` return value (`true` when self-publish wins,
`false` when authorize wins). Its docblock previously said the empty `sig` was "documented
behaviour ... tracked as `bug-self-peer-record-sig-null-race`"; that wording is replaced with
a `NOTE:` explaining that spec covers the lock/uniqueness contract only and pointing at
`peer-record-resolution.spec.ts` for the recovery. The `sig === ''` assertion itself is
unchanged and still correct — at that layer a bare `insertSelfPeerRecord` genuinely does not
self-update; only `CadreNode.publishSelfRecord` recovers.

## Known gaps / things a reviewer should push on

- **No integration-tests / multi-node coverage was added or run.** The race is reproduced only
  at the unit layer against a single node's real control DB. `packages/integration-tests` was
  type-checked (root `yarn typecheck`) but its scenarios were not executed — they are
  real-network and outside this ticket's budget.
- **The reproducing test wedges through `queryPeerRecord`.** That is a white-box hook on the
  production read path, not a natural race. It is deterministic and that is the point, but it
  couples the test to `publishSelfRecord` reading the row through that exact method. The
  `expect(wedged).toBe(true)` assertion is the mitigation; judge whether it's enough.
- **The raced path returns `'refreshed'`, not a new outcome.** Confirmed no caller branches on
  `'inserted'` vs `'refreshed'` for logic — the only consumer is
  `packages/cadre-cli/src/commands/start.ts:294`, which maps the outcome to a console string.
  On the raced path the owner now sees "Owner CadrePeer record refreshed" instead of "row
  inserted". Accurate about the write; arguably surprising on a first boot. A fourth
  `SelfRegistrationOutcome` variant was considered and rejected as unearned — a `NOTE:` at the
  fall-through site says so.
- **The CLI's `skipped` message** (`start.ts:298`) reads "(no self-signing key available)",
  which no longer covers every skip reason — the new row-vanished-mid-publish skip is not that.
  Left alone: it was already inaccurate for the pre-existing "no owner service" skip, and the
  vanished-row path needs a concurrent `removePeer` of self during startup, which the CLI's
  `--owner` branch cannot reach. Flagging rather than fixing.
- **The row-vanished `'skipped'` branch has no test.** It requires an owner `removePeer(self)`
  landing between the failed insert and the re-read. It is a defensive guard against signing
  a null row; exercising it would need a second wedge.
- **`insertSelfDeviceToken` (the `DeviceToken` twin) was checked and left alone.** It has no
  in-lock existence check — it would *throw* on a conflict rather than silently no-op — and
  there is no owner-driven path that seats a `DeviceToken` row on a peer's behalf. No
  analogous silent-drop race. Worth a second opinion that no such owner path is planned.
- **No `docs/cadre-consistency.md` or `docs/architecture.md` change.** Confirmed neither spells
  out the read-then-insert self-publish sequence, so there was nothing to correct. Only
  `docs/STATUS.md` described the write-lock spec's race coverage and it was updated.

## Tripwires parked

- `packages/cadre-core/src/cadre-node.ts` — `NOTE:` at the fall-through in
  `publishSelfRecord`: the raced path reports `'refreshed'`; if a caller ever needs "this was
  the row's first publish", add a fourth `SelfRegistrationOutcome` rather than re-labelling.
- `packages/cadre-core/test/control-write-lock.spec.ts` — `NOTE:` in the authorize-wins race
  docblock: that spec is the lock/uniqueness contract, not end-to-end coverage of the race.
