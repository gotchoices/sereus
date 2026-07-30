description: A party owner can now remove one of the party's shared networks: a new node-level operation deletes the shared record so every node in the party stops running that network. Review the implementation, tests, and docs.
prereq:
files: packages/cadre-core/src/cadre-node.ts, packages/cadre-core/test/strand-unpublish.spec.ts, packages/cadre-core/test/cadre-node.spec.ts, packages/cadre-core/README.md, docs/architecture.md, docs/STATUS.md
----

## What was built

Two changes in `packages/cadre-core/src/cadre-node.ts`:

- **`CadreNode.removeStrand` renamed `stopStrand`** (~line 3370) — behaviour unchanged:
  local-only stop, the shared `Strand` row survives and the strand is rediscovered as
  `strand:discovered` on the next restart or watcher poll. Doc comment now says exactly
  that and points at `unpublishStrand` for party-wide removal. Both spec call sites in
  `cadre-node.spec.ts` updated; zero `removeStrand` references remain.
- **New `CadreNode.unpublishStrand(strandId)`** (~line 2969, right after `publishStrand`)
  — the owner-signed party-wide inverse of `publishStrand`, and the first caller of
  `ControlDatabase.deleteStrand`. Flow: `requireOwnerSigningKey` → `requireNonBlank` →
  `deleteStrand` (row + `Revocation` tombstone in one transaction) → loud log if
  committed while alone (0 control connections; NOT queued for re-issue — see gaps) →
  `strandWatcher?.forcePoll()` → explicit `stopStrand` if a local instance still runs →
  success log. Sibling nodes converge on their own next watcher poll (default 5 s).

Docs: README API table (`stopStrand` / `publishStrand` / `unpublishStrand` rows);
`docs/architecture.md` Strand Membership Bootstrap item 1 gained a party-wide-removal
paragraph cross-referencing the delete-while-alone durability bullet; `docs/STATUS.md`
gained a `[x]` bullet under "Inviting another user / cross-party strand formation".
Note: the STATUS.md entry the original ticket wanted amended ("nothing calls
`deleteStrand`") never existed — a new bullet was added instead.

## Semantics worth reviewing (all deliberate, doc-commented)

- Owner-only: approval is the node's own owner key; no cross-party agreement. Removing
  the row removes THIS party's participation only — other parties keep their rows.
- Closed strand (`Type='c'`): the row's `MemberPrivateKey` is destroyed with it,
  irreversibly (stored nowhere else). The CLI confirmation gate is sibling ticket
  `feat-strand-removal-cli` (implement/5.1, prereq on this slug).
- The id is NOT blacklisted: owner re-publish re-seats it on a fresh stamp; only the
  unsigned consent re-seat is foreclosed forever (tombstone `RowKey`).
- Absent row: silent no-op (no throw, no tombstone) — but a locally-running instance of
  that id is still stopped.
- Error shapes DIFFER by design: `stopStrand` keeps its pre-existing
  `'CadreNode not running'`; `unpublishStrand` throws
  `must be started before attempting to unpublish strand …` via `requireOwnerSigningKey`,
  which runs BEFORE the blank-id check (matches `removeValidationKey` ordering).

## Test coverage (`test/strand-unpublish.spec.ts`, 7 tests, all green)

Harness copied from `validation-key-enrollment.spec.ts` (self-owner node: libp2p key =
owner key, enrolled in `OwnerKey`). Covers: publish→unpublish removes row + files
`Revocation` tombstone retiring the pre-read stamp; never-published id no-op (no
tombstone); blank/whitespace id rejected `/required/i` before any write; stopped-node
error shapes for both methods; closed-strand row + `MemberPrivateKey` destruction;
re-publish after unpublish on a fresh stamp; local convergence — a running instance
(`addStrand` + `publishStrand`) is stopped by the time `unpublishStrand` resolves (pins
the force-poll + explicit-stop step, no 5 s wait).

Deliberately NOT re-tested (pinned at DB layer by `control-authorization-binding.spec.ts`
and `control-revocation-replay.spec.ts`): non-owner signer refused, add-approval replay
refused, tombstone transactionality, owner re-publish mechanics.

## Validation run

- `yarn build` — green.
- `yarn lint` — exit 0.
- `yarn dep-check` — green (knip unused-export listing pre-existing, exit 0).
- `yarn --cwd packages/cadre-core test` — **74 files / 1162 passed, 1 skipped
  (pre-existing skip, untouched)**; includes the new spec.
- Caveat: a later single-file re-run tripped the stale-build guard because
  `../quereus` (linked sibling workspace) has in-flight human edits newer than its dist.
  Not this repo, not rebuilt from here. If tests fail on stale-build at review time, run
  `yarn workspace @quereus/quereus build` in `C:\projects\quereus` first.

## Known gaps / review focus

- **No multi-node test**: sibling-node convergence (another node's watcher observing the
  missing row and stopping its instance) is asserted only by reasoning over the existing
  watcher path, not by an integration test. `handleStrandRemoved` itself is pre-existing
  code, but nothing end-to-end exercises unpublish across two live nodes.
- **Delete-while-alone**: an unpublish committed with 0 control connections is local-only
  and does not propagate — logged loudly, deliberately NOT queued in `pendingPeerWrites`
  (a physical delete cannot be re-issued; the schema tombstone fix is
  `plan/control-delete-while-alone-tombstone`). This ticket only inherits the known gap.
- **Events not pinned**: the spec asserts instance state, not the `strand:stopped`
  emission on the unpublish path.
- **Non-owner refusal through the node wrapper** untested (DB layer covers it; the
  wrapper always signs with the node's own key, so the only node-level failure mode is
  an unenrolled self key — same shape `validation-key-enrollment.spec.ts` pins for
  enrollment).
- Operator-facing surface (CLI command, confirmation prompt for closed strands) is
  sibling `feat-strand-removal-cli` — not reviewable here.
