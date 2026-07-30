description: Device-record removal is now tested on two real networked machines — a member deleting its own record, and a manager clearing the leftovers of a member it removed. Reviewed and shipped.
files: packages/integration-tests/src/scenarios/strand-membership-closed-strand-e2e.integration.ts, docs/architecture.md (~line 623, "End-to-end coverage"), packages/cadre-core/test/strand-membership-peer-rotation.spec.ts (unchanged), packages/cadre-core/src/strand-membership-writer.ts (unchanged), schemas/strand.qsql (unchanged)
----

# Networked coverage for `MemberPeer` removal — complete

## What shipped

No production code changed. One integration-test file plus one docs paragraph.

`strand-membership-closed-strand-e2e.integration.ts` now holds two independent tests,
each bringing up its own two-node closed strand via the extracted
`bringUpClosedStrand(label)` helper:

- the pre-existing admission/rotation lifecycle test (verbatim apart from consuming the
  helper), and
- a new device-record removal test: admit a plain member through the real
  `issueInvite` → `consumeInvite` flow, register two devices (one of them the joiner
  node's actual strand peer id), enumerate them, self-remove one, revoke the member,
  watch its remaining device record survive as an orphan, clear it through the manager
  branch, re-clear it harmlessly, and finish on a rejected bare `Strand.Revocation`
  insert pinned to `/RowIsGone/`.

Cross-node checks are **observe-then-require**: the joiner is watched (not gated) for
the rows to appear, and only if they did is it required to see each removal. On every
run so far it took the gating path.

`docs/architecture.md` → *End-to-end coverage* dropped the stale "that assertion has not
yet executed" claim and gained a paragraph describing the removal coverage.
`docs/strands.md` → *Removing Members* was re-read this pass and is accurate as written.

## Review findings

### Verification run (all green)

| Command | Result |
|---|---|
| `yarn lint` | exit 0 |
| `yarn typecheck` | exit 0 |
| `yarn workspace @serfab/integration-tests test` (**full suite**) | **31 files / 144 tests passed**, 212 s |
| `yarn workspace @serfab/cadre-core test` (**full suite**) | **76 files / 1198 passed, 1 skipped**, 65 s |
| target file, after this pass's edits | 2 passed; console line reads `cross-node removal checks GATE` |

The two suites the implementer flagged as NOT RUN were both run here and are clean. The
one `cadre-core` skip is the pre-existing win32 `skipIf` in `key-store.spec.ts:231`,
already recorded in `tickets/.pre-existing-known.md`. No new
`tickets/.pre-existing-error.md` was written — nothing failed.

### Fixed in this pass (minor)

- **Teardown could leak a live libp2p node.** All three teardown sites ran
  `await joinerNode.stop(); await founderNode.stop()` sequentially, so a rejection from
  the first left the second running — and a surviving libp2p node hangs the vitest run.
  Replaced with a shared `stopBoth(founderNode, joinerNode)` that settles both and logs
  (rather than rethrows) a teardown fault, so it cannot mask the failure that triggered
  it. Applied to `bringUpClosedStrand`'s rollback `catch` and both tests' `finally`.

### Checked and left alone (with reasons)

- **`requireJoinerAgrees` comparing sorted arrays via `JSON.stringify`.** Flagged by the
  implementer. `listMemberPeers` is typed `Promise<string[]>`, so the inputs are always
  strings and the comparison is exact; a non-string element cannot arrive without a type
  error first. Not changed.
- **Identifier collision between the two tests.** `bringUpClosedStrand` scopes the party
  id (`closed-<label>-<Date.now()>`), gets a fresh provisioner instance per call (so
  strand ids are `strand-lifecycle-1` vs `strand-removal-1`), and every member keypair is
  minted per test. Nothing is shared but the `describe` block. Confirmed disjoint.
- **`expect` called inside `bringUpClosedStrand`, outside an `it` body.** A failed
  assertion throws, the helper's `catch` stops both nodes, and the error rethrows into
  the awaiting test — vitest attributes it to the calling test. The control flow is
  correct by construction; not re-verified by deliberately breaking one, since the
  rollback path is now also exercised by the `stopBoth` change.
- **The rejection floor holds.** The removal test contains exactly one rejected write and
  it is the last statement; every count and enumeration assertion precedes it. The
  lifecycle test was unchanged in this respect.
- **Test-side `memberPeerStamp` duplicating the writer's private `memberPeerStampId`.**
  Not a DRY violation worth collapsing: the writer's version is unexported, and a test
  that computed its expected stamps by calling the code under test would assert nothing.
  The test's copy is also strictly more conservative (fully unfiltered scan).
- **Manager-clears-a-still-present-member's-binding is absent from the new test.** That
  branch is covered in `cadre-core/test/strand-membership-peer-rotation.spec.ts:434`
  under bootstrap mode, and this file's stated scope is "adds network, not rules".
  Correctly not duplicated.
- **`docs/strands.md` → *Removing Members*.** Re-read in full against the schema and the
  writer; the device-record clearing, non-cascade, and no-edit rules all match the code.
  Unchanged.

### Parked as a tripwire (not a ticket)

- **"The joiner sees the row" proves visibility, not replication.** A read on either node
  resolves one coordinator peer per block; when that resolves to the founder, the
  joiner's `select` is a remote call against the founder's storage and no block need live
  on the joiner at all. The cross-node checks are therefore evidence that each removal is
  visible from a second node's database — which is the property this test wants — but not
  evidence that the block replicated. Recorded as a `NOTE:` on `requireJoinerAgrees` in
  the test file, naming the two ways a future ticket could prove replication itself (read
  the joiner's raw storage, or stop the founder before the `select`). Conditional, so no
  ticket filed.

### No new tickets filed

Nothing major surfaced. The gaps the implementer listed honestly — the unexecuted
JavaScript re-check behind `Revocation.RowIsGone`, the un-provokable point-lookup miss,
and untested concurrency — were each re-examined and are already tracked where they
belong (`debt-composite-pk-point-lookup-unreliable-untracked`, and the `NOTE:` on
`removeMemberPeer` in `strand-membership-writer.ts`). None is a latent defect this ticket
introduced.

## Environment note (not a defect)

The stale-build guard blocked every test run in this package until `../quereus` was
rebuilt, and the rebuild itself failed for a while: a concurrent worker had uncommitted,
non-compiling edits in `C:\projects\quereus\packages\quereus\src\planner\building\`, and
that package sets `noEmitOnError: true`, so `tsc` refused to emit and the guard kept
reporting stale. It cleared on its own once that worker's edits compiled — no
intervention, and deliberately no touching of their working tree. The guard's
mtime-vs-content tradeoff is argued at length in `test-harness/build-freshness.ts` and is
working as designed.
