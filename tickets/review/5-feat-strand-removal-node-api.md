description: Finish reviewing the new "owner removes a shared network party-wide" operation — the first review pass fixed a misleading warning message and ran out of budget before closing a handful of smaller consistency and test-coverage items.
prereq:
files: packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/test/strand-unpublish.spec.ts, packages/cadre-core/test/publish-strand.spec.ts, packages/cadre-core/test/control-authorization-binding.spec.ts, packages/cadre-core/README.md, docs/architecture.md, docs/STATUS.md
difficulty: easy
----

<!-- resume-note -->
Continuation of the review of `feat-strand-removal-node-api`. The first pass ran out of
token budget after landing two fixes. Everything below is what is left.

## What the first pass already did

**Read** the implement diff (`git show 2578979` and `git show 00d6647`), the surrounding
code (`CadreNode.publishStrand` / `unpublishStrand` / `stopStrand`, `StrandWatcher.poll` +
`forcePoll`, `CadreNode.handleStrandRemoved`, `StrandInstanceManager.stopStrand` /
`releaseRuntime`, `ControlDatabase.deleteGuardedRow`, and the `Strand` / `FormationUsage` /
`Revocation` constraints in `schemas/control.qsql`), plus every doc the change touched.

**Fixed inline (already in the working tree):**

- `ControlDatabase.deleteGuardedRow` now returns `Promise<boolean>` — `true` when a row was
  actually deleted, `false` for the absent-row no-op — and all four wrappers
  (`deleteStrand` / `deleteValidationKey` / `deleteCadrePeer` / `deleteDeviceToken`)
  propagate it. Reason: `unpublishStrand` logged its "committed while ALONE, the deletion is
  local-only and cannot be replayed" warning unconditionally, so unpublishing a
  never-published id from a node with no control connections printed a durability warning
  about a deletion that never happened. It now logs only when `removed` is true. Two
  assertions in `control-authorization-binding.spec.ts` moved from
  `.resolves.toBeUndefined()` to `.resolves.toBe(false)`.

**Verified green after those edits:** `yarn build`, `yarn lint` (exit 0), and
`yarn --cwd packages/cadre-core test` → **74 files / 1162 passed, 1 skipped** (the
pre-existing win32 `skipIf` in `key-store.spec.ts`). The stale-build guard tripped first on
the linked sibling workspace; `yarn workspace @quereus/quereus build` run from
`C:\projects\quereus` cleared it (same build drift already recorded in
`tickets/.pre-existing-known.md`) — expect to need that again.

**Checked and found sound — do not re-derive:**

- The rename `removeStrand` → `stopStrand` is complete: zero `removeStrand` references
  remain in `src/`, tests, or docs (the `removeStrand` hits in
  `control-revocation-replay.spec.ts` are that file's own local test helper, unrelated).
- The double-stop path is safe. `forcePoll()` drives `handleStrandRemoved` for a strand the
  watcher tracked (deletes the sApp config, untracks hibernation, stops the instance, emits
  `strand:stopped`); the explicit `getInstance(...)` + `stopStrand(...)` afterwards covers a
  strand the watcher's filter never admitted. `StrandInstanceManager.stopStrand` no-ops on
  an unknown id, and `handleStrandRemoved` deletes the instance before the explicit branch
  reads it, so `strand:stopped` fires exactly once either way.
- Deleting a `Strand` row cannot orphan or break `FormationUsage`: its `StrandExists` CHECK
  is evaluated at insert time only, and the formation recorder already resolves an absent
  host strand as missing.
- The error-shape asymmetry between `stopStrand` (`'CadreNode not running'`) and
  `unpublishStrand` (`requireOwnerSigningKey`'s started-guard message) is deliberate,
  documented, and matches `removeValidationKey`'s ordering.
- The delete-while-alone log text overlaps `noteControlWrite`'s remove branch, but the two
  say genuinely different things (peer removal is queued in `pendingPeerWrites` for a
  best-effort re-issue; a strand unpublish deliberately is not). Deliberately NOT merged — a
  shared helper would have to erase that distinction. No action wanted.

## What is left

- **`publishStrand` / `unpublishStrand` input-validation asymmetry.** `unpublishStrand` runs
  `requireNonBlank(strandId, 'strand id')` and writes the *trimmed* id; `publishStrand`
  validates nothing and writes the raw id. So a strand published as `' foo '` can never be
  unpublished by passing the same string back (the trimmed lookup misses and the call
  silently no-ops), and a blank id reaches the database as an opaque constraint error on
  publish but an actionable one on unpublish. Add `requireNonBlank` to `publishStrand` for
  symmetry with the `enrollValidationKey` / `removeValidationKey` pair, and cover it with a
  blank-id test in `publish-strand.spec.ts`. No back-compat concern.

- **Three test gaps in `test/strand-unpublish.spec.ts`.** The spec is otherwise solid; these
  are claims the code and its doc comment make that nothing pins:
  - The doc says an absent row is a no-op "but a locally-running instance of that id is
    still stopped". Untested — the existing no-op test never starts an instance. Add
    `addStrand` *without* `publishStrand`, then `unpublishStrand`, and assert the instance is
    gone. This is the branch the explicit `getInstance` + `stopStrand` step exists for, so
    without it that step could be deleted and every test would still pass.
  - The `strand:stopped` emission on the unpublish path is asserted nowhere — the
    running-instance test checks instance state only.
  - `unpublishStrand` throws if the local stop fails *after* the control-plane delete has
    already committed, so a rejection does not mean the row survived. Not documented in the
    method's `@throws`; add a sentence.

- **`unpublishStrand` leaves the strand's local durable storage in place.** `stopStrand` →
  `StrandInstanceManager.releaseRuntime` closes the `StrandDatabase` and stops the libp2p
  node; nothing purges the on-disk blocks. Defensible (removal is a control-plane
  operation), but a party owner "removing a shared network" plausibly expects the local copy
  to go, and for a closed strand the content stays readable on disk. Not a defect — record
  it as a `NOTE:` tripwire in the `unpublishStrand` doc comment stating explicitly that
  local storage is retained, and index it in `## Review findings`. Do not file a ticket.

- **File a `backlog/debt-` ticket for the duplicated self-owner-node test harness.** Five
  copies of the same "boot a node whose libp2p key is its own enrolled owner key" helper now
  exist: `publish-strand.spec.ts` (twice — `startSelfOwnerNode` and `startNode`),
  `publish-formation-invite.spec.ts`, `validation-key-enrollment.spec.ts`, and the new
  `strand-unpublish.spec.ts`. This is a *different* duplication from the existing
  `backlog/debt-strand-spec-helpers-duplicated` (that one covers strand-database setup
  helpers), so it needs its own ticket — mention the relationship. The package convention for
  the fix already exists (`test/control-constraint-helpers.ts`,
  `test/membership-gate-helpers.ts`).

- **Multi-node convergence remains untested** — the implementer flagged this and it stands:
  no test exercises a sibling node's watcher observing the missing row and stopping its
  instance. Decide the disposition (most likely a `backlog/debt-` ticket for a two-node
  integration test, alongside the existing `plan/10-joiner-db-closed-strand-lifecycle-e2e`)
  rather than attempting it inline.

## Closing out

Write `complete/5-feat-strand-removal-node-api.md` with a `## Review findings` section
folding in **both** passes: the two items already fixed above, whatever this pass fixes, the
tripwires parked in code comments, and the tickets filed. Empty categories are fine if
stated with a reason. Re-run `yarn build`, `yarn lint`, and
`yarn --cwd packages/cadre-core test` before handing off; delete this ticket.
