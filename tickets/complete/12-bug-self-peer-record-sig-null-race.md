description: A node that added itself as a member at the same moment it published its own address record used to leave that record unsigned, so nobody could find it until the next refresh; the publish now notices it lost the race and re-signs.
prereq:
files: packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/seed-bootstrap.ts, packages/cadre-core/src/types.ts, packages/cadre-core/test/peer-record-resolution.spec.ts, packages/cadre-core/test/control-write-lock.spec.ts, packages/cadre-cli/src/commands/start.ts, docs/STATUS.md
difficulty: medium
----

## The defect

`CadreNode.publishSelfRecord` read its own `CadrePeer` row, then branched: row present →
self-signed UPDATE; row absent → owner-signed INSERT. The INSERT funnels into
`SeedBootstrapService.insertCadrePeerRow`, which re-checks row existence *inside* the
control-database write lock so two writers racing the same peer's first row cannot collide on
the unique key — the loser no-ops. It returned `void`, so the caller could not tell "I inserted"
from "someone beat me".

An owner `authorizePeer` of this node's **own** peer id landing in that read-then-insert window
seated the row with a null `Sig` (an owner cannot forge a peer's self-signature) and no
addresses. The self-publish's INSERT silently no-op'd and reported `'inserted'`.
`resolvePeerAddrs` verifies the signature against the stored public key, so the node stayed
unreachable-by-lookup until the next periodic self-registration — up to one heartbeat interval,
about 7.5 minutes in the CLI.

## The fix

**`seed-bootstrap.ts`** — `insertCadrePeerRow` and `insertSelfPeerRecord` return `boolean`:
`true` = this call performed the INSERT, `false` = the in-lock check found the row already
seated. `authorizePeer` ignores it and stays `Promise<void>`.

**`cadre-node.ts`** — the no-row branch falls through to the self-update path when the insert
reports `false`. It **re-reads** the row that actually landed and re-signs against that row's
`UpdatedAt`; the re-read is load-bearing, because the `CadrePeer.AuthorizedUpdate` self-branch
demands a strictly greater `UpdatedAt` than the stored row and the pre-race read is not that
row's stamp. Signing moved into a `signSelfRecord` helper shared by both call sites. A `!current`
guard after the re-read returns `'skipped'` if the row vanished (a concurrent `removePeer`)
rather than signing against nothing.

**`types.ts`** — `SelfRegistrationOutcome`: the raced path reports `'refreshed'` (honest — the
write really was an UPDATE); `'skipped'` now also covers row-vanished.

## Review findings

### Verified the fix is real, not just the label

Independently reproduced the defect against the implementer's test: neutralising the fall-through
(`insertSelfPeerRecord(record) || true`) makes
`carries a valid self-signature when an authorize lands mid-publish` fail at
`expect(verifyPeerRecordSignature(stored!)).toBe(true)` — i.e. the test fails on the *actual*
unresolvable row, not merely on the outcome string. That is the right failure.

### Fixed in this pass (minor)

- **The row-vanished `'skipped'` branch had no test** — the implementer flagged it as an
  untested defensive guard. Added
  `skips rather than self-updating a row that was removed mid-publish`: it wedges an
  `authorizePeer` into the read-then-insert window (so the INSERT loses) and a `removePeer` in
  front of the fall-through's re-read, then asserts `'skipped'` and that no row was left behind.
  Confirmed load-bearing: with the guard neutered the test fails with
  `expected 'refreshed' to be 'skipped'`.
- **DRY: the wedge tests hand-rolled the same `queryPeerRecord` monkeypatch.** Extracted
  `hookSelfReads(node, peerId, hook)` in `peer-record-resolution.spec.ts`; the hook receives the
  read index and a `read()` thunk, so each test chooses whether its concurrent write lands before
  or after the read — the two orderings mean different things and a single rigid helper would
  have obscured that. The old `expect(wedged).toBe(true)` became `expect(wedge.reads()).toBe(2)`,
  which is strictly stronger: it pins that the fall-through's re-read actually happened, not just
  that the wedge fired.
- **A misleading comment.** `// \`existing\` is the pre-race read on the fall-through path` reads
  backwards — on the fall-through `existing` is *null*, which is what makes the `??` re-read.
  Reworded. Also trimmed the 14-line inline comment block above it; the method docblock already
  carries the narrative.
- **CLI skip message asserted a cause it cannot know.** `start.ts` printed
  "(no self-signing key available)" for every `'skipped'`, which was already wrong for the
  no-owner-service skip and is wrong for the new row-vanished skip. Now
  "(see logs for the reason; the heartbeat retries)". Nothing asserts on that string.
- **`docs/STATUS.md`** said the recovery spec covered "both orderings"; it now covers three
  cases. Updated.

### Major findings

None. No new tickets filed. The change is correctly scoped, the boolean threads cleanly through
`mutateCadrePeer<T>`, and the raced UPDATE is genuinely authorized — `authorizePeer` derives
`PublicKey` from the peer id and `getSelfSigningKey` refuses to sign unless its public key equals
`ed25519PublicKeyB64FromPeerId(peerId)`, so the row the fall-through updates verifies against the
key the node signs with.

### Correction to the handoff

The handoff stated "no caller branches on `'inserted'` vs `'refreshed'` for logic — the only
consumer is `packages/cadre-cli/src/commands/start.ts`". Not accurate: three integration
scenarios poll on `(await X.registerSelf()) === 'refreshed'` as a wait predicate
(`control-cohort-three-node-isolation.integration.ts:301,351`,
`control-write-degraded-cohort-member.integration.ts:399,403`). Checked each — all wait on a
*refresh* of an already-seated row, a path this change does not touch, so none is affected. The
conclusion held; the reasoning behind it did not.

### Tripwires parked

- `packages/cadre-core/src/cadre-node.ts`, at the re-read in `publishSelfRecord` — `NOTE:` that
  the **normal** refresh path has no vanish guard: when `existing` is non-null it predates the
  publish, so a `removePeer(self)` racing in leaves the UPDATE matching no rows while still
  reporting `'refreshed'`. Closing it needs `updateSelfPeerRecord` to report rows-affected; only
  worth doing if removing self ever becomes a concurrent operation in practice.
- `packages/cadre-core/src/cadre-node.ts`, at `registerDeviceToken`'s insert — `NOTE:` on why the
  `DeviceToken` twin needs no equivalent recovery (nothing seats a `DeviceToken` row on a peer's
  behalf, and its insert has no in-lock existence check so a lost race throws rather than silently
  dropping), and what would invalidate that: an owner-driven token-seeding path, or two concurrent
  first-publishes — this method has no single-flight guard, unlike `registerSelf`.
- Retained from the implement pass: the `NOTE:` at the fall-through (add a fourth
  `SelfRegistrationOutcome` rather than re-labelling `'refreshed'`) and the `NOTE:` in
  `control-write-lock.spec.ts` (that spec is the lock/uniqueness contract, not end-to-end race
  recovery).

### Checked, nothing found

- **Docs.** Read every file that mentions `registerSelf` / self-publish: `docs/architecture.md`
  (lines 94, 193, 200), `docs/cadre-host.md` (155, 205), `docs/cadre-consistency.md` (no mention
  at all), `docs/STATUS.md`. None describes the read-then-insert sequence or the outcome
  vocabulary, so `STATUS.md` was the only file needing a change — which it got, twice.
- **Other production callers.** `insertSelfPeerRecord` / `updateSelfPeerRecord` / `registerSelf`
  swept across all packages. Outside `cadre-core` the only production caller is the CLI's
  `--owner` branch. `cadre-host` and `integration-tests` reach it through tests/scenarios only.
- **Write-lock semantics.** `mutateCadrePeer<T>` is generic and returns the body's value, so the
  new `boolean` propagates correctly; the in-lock check means a `false` return implies the
  competing insert has already committed, which is what makes the fall-through's re-read see it.

### Not run

`packages/integration-tests` scenarios (real-network, multi-node) were **not executed** — they
exceed a ticket's runtime budget and are the implement pass's stated gap as well. They were
type-checked via the root `yarn typecheck`. The race remains covered only at the unit layer,
against a single node's real Quereus control DB.

## Validation

- `yarn lint` (root) — **0 errors.** 6 warnings, all unused `eslint-disable` directives in
  `packages/integration-tests/src/scenarios/zz-scratch-delete-alone.integration.ts`, a file
  neither the implement nor the review pass touches. Pre-existing.
- `yarn typecheck` (root, all workspaces) — exit 0.
- `packages/cadre-core`: `yarn vitest run` — **78 files, 1217 passed, 1 skipped** (up one test
  from the implement pass). The skip is the pre-existing win32 `skipIf` at
  `test/key-store.spec.ts:231`, unrelated.
- `packages/cadre-cli`: `yarn vitest run` — 11 files, 147 passed.
- `packages/cadre-host`: `yarn vitest run` — 57 files, 465 passed, 4 skipped.

No test failures, pre-existing or otherwise, so no `tickets/.pre-existing-error.md` was written.
