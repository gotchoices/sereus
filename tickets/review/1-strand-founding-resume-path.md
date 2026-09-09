description: Setting up a shared network took two steps, and an app killed between them could never attach that network again. The first step is now safe to repeat, both steps are available as one call, and the sample apps were moved onto it.
files: packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/types.ts, packages/cadre-core/test/publish-strand.spec.ts, packages/reference-app-rn/src/chat-strand.ts, packages/reference-app-rn/src/use-cadre.ts, packages/reference-app-rn/test/chat-strand.spec.ts, packages/reference-app-web/src/lib/cadre-web.ts, docs/architecture.md
difficulty: medium

# Review: founding a strand is resumable

Implements `tickets/implement/1-strand-founding-resume-path.md` (upstream report
**gotchoices/sereus#12**). All three parts of that ticket's Direction landed. Diff is
+747/−80 across 9 files, ~330 of the additions being tests.

## What shipped

**`CadreNode.publishStrand` is idempotent for identical content** (`cadre-node.ts:4078`).
It now reads the row first; a live row whose `(Type, MemberPrivateKey)` match the arguments
is logged and returned instead of re-inserted. Mismatching content throws an error naming
the differing columns instead of surfacing `UNIQUE constraint failed: Strand.Id`. The
read/insert pair is not atomic, so the insert's uniqueness rejection is also caught,
re-read, and resolved the same way (no-op on a content match, rethrow otherwise) — that is
the concurrent-founding race, two machines of one party on the same id. Never an overwrite
on either path.

**`CadreNode.foundStrand` is the single founding entry point** (`cadre-node.ts:4164`):
read-or-publish, then `addStrand(..., founder: true)`. On an already-published strand it
adopts the STORED row — including its `MemberPrivateKey`, so a caller that mints a key per
attempt (both reference apps do) stops presenting a key that does not match the membership
already seated in the strand. Always founds, never merely attaches, which is what closes the
headerless-strand arm. A `Type` disagreement with the published row throws.

**Reference apps moved onto it**: RN `createChatStrand` + `createClosedChatStrand`
(`reference-app-rn/src/chat-strand.ts`) and web `createClosedChatStrand`
(`reference-app-web/src/lib/cadre-web.ts`). Both closed-strand callers now return the
RESOLVED membership key rather than the one they minted.

**Support pieces**: `isStrandIdConflict` (`control-database.ts:322`) classifies the
uniqueness rejection by message text — the typed engine error does not survive the trip out
of optimystic, same constraint the retry classifiers already document. `FoundStrandConfig` /
`FoundStrandResult` in `types.ts`. Founding contract documented in `docs/architecture.md`
(the founder-bootstrap section, new "Entry point" bullet).

### Return-shape decision (the ticket asked for this to be recorded)

`publishStrand` changed from `Promise<void>` to **`Promise<StrandRow>`** — the live row,
freshly inserted or the matching one already there. Without it the idempotent branch's
outcome is unobservable, and a closed-strand caller cannot learn which key won.

`foundStrand` returns **`{ instance, strandRow }`**, not a bare `StrandInstance`. The
resolved row is the thing callers actually need on a resume, and `StrandInstance.memberKey`/
`memberPrivateKey` are populated by `StrandInstanceManager` from the row it was launched
with — reachable, but an indirection through plumbing that could change, and typed
`string | undefined` where the row's column is honestly `string | null`. Reviewer may
disagree; it is a one-line change at three call sites if so.

## Use cases to exercise

The failure this fixes only appears across a process boundary, so the interesting cases are
"do X, kill, redo X":

- **The reported brick.** Publish a strand, then attempt the whole founding again on the
  SAME id. Before: `UNIQUE constraint failed: Strand.Id`, permanently, with no way for the
  caller to tell "already done" from "genuine conflict". Now: no-op + attach.
- **The headerless strand.** Publish only (no `addStrand`), then `foundStrand` the same id.
  `Strand.Header` must be 1 — not 0, which is what attaching as a joiner leaves and what the
  RN app's `strand:discovered` auto-join still produces (see Gaps).
- **Closed-strand key reuse.** Publish `type:'c'` with key A, then `foundStrand` with a
  freshly minted key B. The strand must run under A, and `Strand.Member.Key` must be A's
  derived public key. Getting this wrong mints invitations that cannot read the strand.
- **Genuine conflicts still fail.** Same id, different `Type` → throws naming the type.
  Same id, different `MemberPrivateKey` → throws naming the column. Neither may overwrite.
- **A closed strand is not silently reopened.** `foundStrand({type:'o'})` over a published
  `'c'` row must throw.
- **Tombstoned strands are not resurrected.** `unpublishStrand` then republish must re-seat
  through the ordinary path (row absent → no idempotent branch to hit).
- **Secret hygiene.** The mismatch error must not contain the stored `MemberPrivateKey`.
  Pinned by a test; worth re-checking if the message is ever reworded.

## Validation actually run

Green, in the foreground:

- `yarn lint` (clean), `yarn build` (all workspaces), `yarn typecheck` (all workspaces + the
  three coverage guards).
- `packages/cadre-core`: full suite, **1795 passed / 1 skipped, 109 files**.
  `test/publish-strand.spec.ts` grew from 12 to 26 tests.
- `reference-app-rn` 192, `reference-app-web` 66, `cadre-cli` 232, `cadre-host` 608 (+4
  skipped), `cadre-provider` 201, `quereus-plugin-sereus` 108, `reference-app-ns` 103 — all
  passing.

No pre-existing failures surfaced anywhere, so no `.pre-existing-error.md` was written.

**Not run: `packages/integration-tests`.** It exceeded 10 minutes of wall clock with no
output and was abandoned per the agent-runnable rule — this is a deferral, not a pass. It is
the highest-value thing a reviewer with more budget can add. Reasoning about what it does
touch, in lieu of running it: `harness/strand-join.ts:92` publishes AFTER `addStrand` and
ignores the return, `strand-late-cadre-join.integration.ts:263` and
`strand-unpublish-sibling-convergence.integration.ts:130,177` likewise. The last one
re-publishes an id after `unpublishStrand`, which lands on the row-absent path (unchanged).
Nothing in the tree asserts that a duplicate publish throws, so no assertion should have
flipped — but that is an argument, not a run.

## Test floor — where coverage is thin

- **The race branch is simulated, not concurrent.** `blindOneStrandRead` in
  `publish-strand.spec.ts` makes one `queryStrand` report the row absent so the insert really
  collides against the live engine, which is what pins `isStrandIdConflict` against the real
  rejection text. It does NOT run two founders at once. A true two-machine race belongs in
  `integration-tests` and is not written.
- **The `landed === null` rethrow is uncovered** (collision, then the re-read finds nothing).
  Constructing it needs a delete interleaved between rejection and re-read.
- **`foundStrand`'s "instance already tracked" path** is covered only via `stopStrand`
  between the two calls, which also drops the sApp config. A real app restart is a different
  shape (new process, `sAppConfigs` empty) and is not simulated.
- **Nothing exercises `foundStrand` across a genuine process restart** with persistent
  storage. The specs use the default in-process node.

## Gaps and things deliberately left

- **RN auto-join still produces headerless strands** — the real field path for the second
  arm. `use-cadre.ts`'s `strand:discovered` handler attaches (no `founder`) any open strand
  the control network reports, including the app's own orphan after a restart. It cannot be
  fixed there: nothing in the `Strand` row records who published it, so the handler cannot
  distinguish our orphan from another party's strand, and founding another party's strand
  would write a second `Strand.Header` before sync delivered theirs. Recorded as a `NOTE:` at
  that site. Root cause if someone wants to close it: founder-ness is not persisted anywhere
  local, so a resume cannot know to re-found — that is a representation change (a persisted
  per-strand founder marker), not a patch to the handler. Left unfiled deliberately; the
  reviewer should decide whether it earns a `debt-` ticket.
- **Local-only founding sites untouched**, as the implement ticket scoped:
  `reference-app-ns/src/chat-strand.ts:73` and web `addChatStrand`
  (`cadre-web.ts:750`) pass `founder: true` and never publish — local islands, no brick
  possible, separate concern.
- **`reference-app-web/e2e/fixtures/formation-responder.ts:213`** still hand-rolls
  `publishStrand` + `addStrand`. A Playwright fixture, not app code; it works unchanged
  (publish's return is ignored), but it is now the only in-repo copy of the discouraged
  pattern.
- **`integration-tests/src/harness/strand-join.ts`** keeps its `addStrand`-then-publish
  order. Migrating it would change which lifecycle events fire, which several scenarios
  assert on; not worth the churn inside this ticket.
- **Tripwire, parked at the code site** (`cadre-node.ts`, in the no-op branch):
  `queryStrand` does not filter rows whose `StampId` a `Revocation` has retired, so on a
  sibling still physically holding a row deleted elsewhere while ALONE (the delete-while-alone
  gap in `docs/architecture.md`), an owner-signed republish now no-ops onto that doomed row
  instead of re-seating under a fresh stamp. Both behaviours end at the same unconverged
  state today; if delete-while-alone ever gains real replay, filter retired stamps there.

## Needs a human: reply on gotchoices/sereus#12

The reporter is carrying a local patch, so this needs answering. **Do not post from an agent
run** — draft only:

> Fixed. `publishStrand` is now idempotent: it reads the `Strand` row first and returns it
> unchanged when `(Type, MemberPrivateKey)` already match, so a founding interrupted after
> the publish committed can simply be repeated. A row with the same id but different content
> throws an error naming the columns that differ instead of `UNIQUE constraint failed:
> Strand.Id` — the two cases that error could not distinguish ("already done, carry on" vs.
> "genuine conflict") are now distinct. The concurrent case is covered too: if another
> founder wins the insert race, the rejection is caught, the landed row re-read, and the call
> no-ops only when the content matches.
>
> There is also a new `CadreNode.foundStrand({ strandId, type, memberPrivateKey, sAppConfig })`
> that does the whole founding — publish the row, then `addStrand(..., founder: true)` — and
> is safe to re-run. Prefer it over hand-rolling the pair. It matters most for closed
> strands: on a resume it adopts the STORED `MemberPrivateKey` and returns the resolved row,
> because a caller that mints a fresh key per attempt would otherwise present a key that
> cannot read the strand. Both reference apps now use it.
>
> Your `queryStrand` pre-check keeps working — it is a coarser version of the same guard. It
> skips the publish whenever a row exists, without comparing content, so it silently
> tolerates a mismatched row where `publishStrand` now throws. Nothing about it becomes
> wrong; you can drop it once you are on a build with this change.
>
> If anyone is already stuck: no app-data wipe is needed. The `Strand` row is already
> published, so attach instead of republishing — `addStrand` (or `foundStrand`) with the id
> and, for a closed strand, the `MemberPrivateKey` read back off the row. `unpublishStrand`
> plus a fresh publish also clears it for an OPEN strand, but is destructive for a closed one:
> that row's `MemberPrivateKey` is stored nowhere else. This recovery note is also in the
> `publishStrand` docstring.

## Reviewer's checklist

- Is text-matching the engine's `UNIQUE constraint failed: Strand.Id` acceptable as the race
  discriminator? It fails closed (a reword resurfaces the raw error rather than doing
  anything unsafe) and the read-first path means a reword degrades only the rare race, but it
  is still coupling to another repo's error wording.
- `strandRowMismatches` treats `(Type, MemberPrivateKey)` as the whole of "identical
  content". Confirm against `control-schema.ts:141` that `StampId` is the only other column
  and that treating it as a nonce rather than content is right.
- The mismatch error text tells the caller to `unpublishStrand` and re-seat. Is steering a
  stuck caller toward a destructive operation for closed strands the right default, given the
  same sentence warns about it?
- `foundStrand` and `publishStrand` deliberately disagree about a key mismatch:
  `publishStrand` throws (it is being asked to WRITE that key), `foundStrand` adopts the
  stored one and logs (it is resuming onto what exists). Confirm that split is the one you
  want; it is the single most surprising thing in the change.
