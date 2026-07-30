description: Added and reviewed the owner-signed operation that lets a party owner remove a shared network party-wide, so every node of the party stops running it.
files: packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/test/strand-unpublish.spec.ts, packages/cadre-core/test/publish-strand.spec.ts, packages/cadre-core/test/control-authorization-binding.spec.ts, packages/cadre-core/README.md, docs/architecture.md, docs/STATUS.md
----

# Strand removal node API — completed

## What shipped

`CadreNode.unpublishStrand(strandId)` — the owner-signed, party-wide inverse of
`publishStrand`. It deletes **this party's** `Strand` row from the shared control database
(via `ControlDatabase.deleteStrand`, which also files the `Revocation` tombstone retiring the
row's stamp); every node of the party stops its local instance once its watcher observes the
missing row, and the calling node converges immediately by forcing a watcher poll and
stopping any still-running local instance before resolving.

Alongside it, the pre-existing local-only stop was renamed `removeStrand` → `stopStrand`, so
the two operations no longer read as variants of the same thing: `stopStrand` stops the
strand on THIS node and leaves the row intact for rediscovery; `unpublishStrand` removes the
row for the whole party.

Semantics documented on the method and in `docs/architecture.md`: unpublishing a closed
strand destroys its `MemberPrivateKey` (stored nowhere else — irreversible); the strand id is
not blacklisted for an owner re-publish, only for unsigned consent re-seats; a removal
committed with zero control connections is local-only and cannot be replayed (the existing
delete-while-alone durability gap, tracked by `plan/10-control-delete-while-alone-tombstone`).

## Review findings

Reviewed across two passes (the first ran out of token budget mid-way; the second resumed
from its notes). Both passes' results are folded in below.

### Checked and found sound — no action

- **Rename completeness.** Zero `removeStrand` references remain in `src/`, tests, or docs.
  (The `removeStrand` hits in `control-revocation-replay.spec.ts` are that file's own local
  test helper, unrelated.)
- **Double-stop safety.** `forcePoll()` drives `handleStrandRemoved` for a strand the watcher
  tracked; the explicit `getInstance` + `stopStrand` afterwards covers a strand the watcher's
  filter never admitted. `StrandInstanceManager.stopStrand` no-ops on an unknown id, and
  `handleStrandRemoved` deletes the instance before the explicit branch reads it, so
  `strand:stopped` fires exactly once on either path. Now pinned by tests (below).
- **Referential integrity.** Deleting a `Strand` row cannot orphan or break `FormationUsage`:
  its `StrandExists` CHECK is evaluated at insert time only, and the formation recorder
  already resolves an absent host strand as missing and rejects cleanly.
- **Error-shape asymmetry** between `stopStrand` (`'CadreNode not running'`) and
  `unpublishStrand` (`requireOwnerSigningKey`'s started-guard message) is deliberate,
  documented, and matches the `enrollValidationKey` / `removeValidationKey` ordering.
- **Overlapping delete-while-alone log text** with `noteControlWrite`'s remove branch:
  deliberately NOT merged. The two say genuinely different things (a peer removal is queued
  in `pendingPeerWrites` for best-effort re-issue; a strand unpublish deliberately is not),
  and a shared helper would erase that distinction.

### Minor — fixed in this review

- **Misleading durability warning.** `unpublishStrand` logged its "committed while ALONE …
  cannot be replayed" warning unconditionally, so unpublishing a never-published id from a
  node with no control connections printed a durability warning about a deletion that never
  happened. `ControlDatabase.deleteGuardedRow` now returns `Promise<boolean>` (`true` when a
  row was actually deleted, `false` for the absent-row no-op) and all four wrappers
  (`deleteStrand` / `deleteValidationKey` / `deleteCadrePeer` / `deleteDeviceToken`)
  propagate it; the warning is gated on that. Two assertions in
  `control-authorization-binding.spec.ts` moved from `.resolves.toBeUndefined()` to
  `.resolves.toBe(false)`.
- **`publishStrand` / `unpublishStrand` input-validation asymmetry.** `unpublishStrand`
  validated and trimmed its id; `publishStrand` validated nothing and stored the raw string.
  A strand published as `' foo '` could therefore never be unpublished by passing the same
  string back — the trimmed lookup missed and the call silently no-opped. `publishStrand` now
  runs the same `requireNonBlank` and stores the trimmed id, matching the
  `enrollValidationKey` / `removeValidationKey` pair. Covered by two new tests in
  `publish-strand.spec.ts`: blank/whitespace ids rejected before any write, and a padded id
  round-tripping through publish → unpublish.
- **Undocumented post-commit throw.** `unpublishStrand`'s local stop runs *after* the
  control-plane delete has committed, so a rejection does not mean the row survived. Said so
  explicitly in the method's `@throws`.
- **Three test gaps in `strand-unpublish.spec.ts`**, all now closed:
  - The doc's claim that an absent row is a no-op "but a locally-running instance of that id
    is still stopped" was untested — the existing no-op test never started an instance. New
    test does `addStrand` *without* `publishStrand`, then `unpublishStrand`, and asserts the
    instance is gone. This is the only branch the explicit `getInstance` + `stopStrand` step
    exists for; without it that step could have been deleted with every test still passing.
  - `strand:stopped` was asserted nowhere on the unpublish path. Both running-instance tests
    now assert the event fires exactly once, which also pins the no-double-stop reasoning.

### Major — filed as tickets

- `backlog/debt-self-owner-node-test-harness-duplicated` — five copies of the same "boot a
  node whose libp2p key is its own enrolled owner key" helper now exist across
  `publish-strand.spec.ts` (twice), `publish-formation-invite.spec.ts`,
  `validation-key-enrollment.spec.ts`, and the new `strand-unpublish.spec.ts`. Distinct from
  the existing `backlog/debt-strand-spec-helpers-duplicated` (strand-*database* setup, a
  non-overlapping set of files); the ticket notes the relationship.
- `backlog/debt-strand-unpublish-multi-node-convergence-test` — no test exercises a *sibling*
  node's watcher observing the missing row and stopping its instance. Flagged by the
  implementer and confirmed here; the party-wide half of the contract rests on inspection
  only. Likely belongs in `packages/integration-tests`, possibly hosted by the harness
  `plan/10-joiner-db-closed-strand-lifecycle-e2e` builds.

### Tripwires (conditional; parked, not ticketed)

- **Local durable storage is retained on unpublish.** Stopping the instance closes the
  `StrandDatabase` and its libp2p node but purges no blocks, so a closed strand's content
  stays readable on disk to anyone with the data directory. Defensible — removal is a
  control-plane operation — but an owner "removing a shared network" may expect otherwise.
  Parked as a `NOTE:` in the `unpublishStrand` doc comment in
  `packages/cadre-core/src/cadre-node.ts`, plus a clause in `docs/architecture.md` where
  party-wide removal is described (the doc is where a reader forms the wrong expectation).

### Blocked / decisions for a human

None — nothing in this change needed a call only a human could make.

### Pre-existing failures

None new. The stale-build guard tripped on the linked sibling workspace and was cleared by
running `yarn workspace @quereus/quereus build` from `C:\projects\quereus` — the same build
drift already recorded in `tickets/.pre-existing-known.md`, not re-reported.

## Validation

`yarn build` ✓, `yarn lint` ✓ (exit 0), `yarn --cwd packages/cadre-core test` ✓ —
**74 files / 1165 passed, 1 skipped** (the pre-existing win32 `skipIf` in `key-store.spec.ts`).
