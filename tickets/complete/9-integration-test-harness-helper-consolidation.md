description: Cleaned up duplicated test setup code across integration-test scenario files by moving the shared pieces into the shared test harness, so there is one copy to maintain instead of near-identical copies scattered across a dozen files.
prereq:
files: packages/integration-tests/src/harness/node-fixtures.ts, packages/integration-tests/src/harness/test-network.ts, packages/integration-tests/src/harness/index.ts, packages/integration-tests/src/scenarios/*.integration.ts
difficulty: easy
----

## What landed

Eight scenario-setup helpers were hoisted out of 10 integration-test scenario files
into the shared harness and are re-exported through `harness/index.ts`:
`wsTransports`, `createSignedSAppConfig`, `ControlNodeOpts` / `controlNodeConfig`,
`makeOwnOwner`, `randomPeerId`, `connectControlNodes`, `bootPair`.

Behavioral notes carried over from the implement pass, both confirmed by the test run
below:

- `connectControlNodes` is the stricter, peer-pair-scoped connection check
  (`getConnections().some(c => c.remotePeer === expected)`), replacing a looser
  "any connection at all" check in two of its four call sites. In their 2-node
  topologies only one connection is ever possible, so this is a no-op there, and it is
  load-bearing in `push-wake-e2e`'s 3-node full-mesh scenario.
- `bootPair`'s `partyIdPrefix` defaults to `'ctrl'`;
  `control-write-while-alone-convergence` passes `'ctrl-alone'` explicitly at both call
  sites, preserving its existing party-id strings.

## Review findings

### Fixed in this pass (minor)

- **Single responsibility / file size.** The implement pass appended all 8 helpers to
  `harness/test-network.ts`, whose stated job is the `TestCadreNetwork` multi-party
  orchestrator; the file reached ~450 lines spanning three unrelated concerns. Moved
  the helpers into a new `harness/node-fixtures.ts` (scenario-level `CadreNode`
  building blocks) and added it to the barrel. `test-network.ts` is back to 305 lines
  and its import list is back to what it was before the ticket. No scenario file needed
  editing — every one of them already imports from `../harness/index.js`.
- **`reconcileMs: 0` was silently dropped.** `controlNodeConfig` spread the
  `controlCohort` override behind a truthiness test, so a deliberate `0` would have
  been discarded. Changed to `!== undefined`.
- **Duplicated wait block.** `connectControlNodes` inlined the same 6-line `waitUntil`
  twice; extracted a `waitForControlConnection(node, peerId, description)` local.

### Found, NOT fixed — filed as a follow-up ticket (major)

- **The consolidation covers only 10 of the 15 scenario files that carry these
  helpers.** `membership-connection-gater`, `strand-addr-seed-convergence`,
  `control-cohort-three-node-isolation`, `control-cohort-cold-start-retry` and
  `control-stream-authz` still define private copies of `wsTransports`, `nodeConfig`,
  `makeOwnOwner` and friends. `strand-addr-seed-convergence` even carries an in-file
  note naming this ticket and saying "copy, don't refactor, until that lands" — so the
  ticket's own stated purpose is half-met and that note is now stale. Not fixable as a
  minor inline edit: three of those local builders differ from the shared one
  (`strandFilter: 'none'`, a `trustedOwners.pinnedKeys` option, and one that omits the
  `hibernation` key entirely), so absorbing them needs the shared options type widened
  and each difference checked. Filed as
  `plan/integration-test-harness-helper-consolidation-remaining-files` with the full
  per-file inventory and the three open questions.

### Checked and clean

- **Diff fidelity.** Every deleted local helper was compared against the shared version
  that replaced it. All five `createSignedSAppConfig` copies were character-identical
  (same `latencyHint: 'interactive'`, no dropped fields). All four `controlNodeConfig`
  call-site files produce the same `CadreNodeConfig` shape as their deleted local
  builders. `makeOwnOwner`'s return-type widening (three call sites previously returned
  nothing) is source-compatible and no caller reads the value where it did not before.
- **Barrel collisions.** No export-name conflict between `node-fixtures.ts` and the
  other harness modules.
- **Docs.** Every `docs/` file mentioning `integration-tests` was checked
  (`STATUS.md`, `architecture.md`, `cadre-host.md`, `reference-app-rn.md`). None
  enumerates harness helpers or names any of the moved functions, so nothing went out
  of date — no doc edit was needed. Stated explicitly rather than left silent.
- **Resource cleanup / error handling.** `bootPair` documents that the caller owns
  shutdown, and every call site already stops both nodes in a `finally`.
  `connectControlNodes` now throws a real `Error` on a writer with no listen addresses
  instead of relying on a vitest `expect`, which is correct for harness code that may
  run outside a test body.

### Tripwires

None. The two divergences the implement handoff flagged (loose-vs-pair-scoped
connection check, `bootPair`'s prefix default) were resolved inside the hoist itself
and confirmed green, so neither is a conditional concern worth parking as a note.

## Verification

The implement pass explicitly left the test suite unrun. It has now been run.

- `packages/integration-tests`, full suite: **32 files / 146 tests passed**, 220s.
  The 10 touched scenarios were also run first in three smaller batches (31 tests) in
  the priority order the handoff asked for — all green, including
  `push-wake-e2e` scenario 4's 3-node full mesh and both control-convergence anchors.
- `yarn workspace @serfab/integration-tests typecheck` — clean.
- `yarn lint` (whole repo) — exit 0.
- `yarn workspace @serfab/cadre-core test` — 78 files / 1214 passed, 1 skipped.
- `yarn workspace @serfab/quereus-plugin-sereus test` — 7 files / 68 passed, 1 todo.

No pre-existing failures to report; `tickets/.pre-existing-error.md` was not written.

One incidental note for the next agent: the suite's stale-build guard trips on the
sibling `C:\projects\quereus` workspace. `yarn workspace @quereus/quereus build`
silently no-ops from some shells here; `cd C:\projects\quereus\packages\quereus &&
npx tsc` works.
