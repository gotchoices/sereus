description: Finished moving the last integration-test scenario files off their own private copies of test setup code and onto the shared test harness, so this cleanup pass is now fully done.
prereq:
files: packages/integration-tests/src/harness/node-fixtures.ts, packages/integration-tests/src/harness/control-trio.ts, packages/integration-tests/src/scenarios/strand-addr-seed-convergence.integration.ts, packages/integration-tests/src/scenarios/control-cohort-three-node-isolation.integration.ts, packages/integration-tests/src/scenarios/control-cohort-cold-start-retry.integration.ts, packages/integration-tests/src/scenarios/control-stream-authz.integration.ts, packages/integration-tests/src/scenarios/membership-connection-gater.integration.ts, packages/integration-tests/src/scenarios/push-wake-e2e.integration.ts, packages/integration-tests/src/scenarios/control-write-degraded-cohort-member.integration.ts
difficulty: easy
----

Continuation of the harness-consolidation sweep started by
`integration-test-harness-helper-consolidation`, which covered 10 of the 15 scenario files.

## What landed

Harness (`packages/integration-tests/src/harness/`):

- `node-fixtures.ts` gained a `strandFilter?: 'all' | 'none'` option on `ControlNodeOpts`,
  a `controlAddrs(node)` export, and promoted the previously-private
  `waitForControlConnection` to an export.
- `control-trio.ts`'s file-header note stopped claiming it is a port "awaiting the
  harness-consolidation ticket" — the isolation scenario now calls it.

Scenario files, all converted to import from `../harness/index.js`:

- `membership-connection-gater` — dropped local `wsTransports`, `nodeConfig`,
  `makeOwnOwner`, `waitForConnection`.
- `control-stream-authz` — dropped local `wsTransports`, `makeOwnOwner`,
  `waitForConnection`.
- `strand-addr-seed-convergence` — dropped local `wsTransports`,
  `createSignedSAppConfig`, `nodeConfig`, `makeOwnOwner`, `connectControlNodes`,
  `controlAddrs`; kept the file-local `SIMPLE_SCHEMA` (not a harness concern).
- `control-cohort-three-node-isolation` — dropped its entire private ~150-line
  `bootTrio`/`stopTrio` boot sequence plus `Trio`/`TrioHandles`/`wsTransports`/
  `nodeConfig`/`makeOwnOwner`/`connectionsTo`/`hasOutboundTo`/`peerStoreAddrsFor`;
  now calls `bootControlTrio`/`stopControlTrio`.
- `control-cohort-cold-start-retry` — dropped local `wsTransports`, `nodeConfig`,
  `makeOwnOwner`, `randomPeerId`, `connectionsTo`. Keeps `ed25519KeyPairFromLibp2p`
  imported straight from `@serfab/cadre-core` (one use, for `pinnedKeyTrustPolicy`'s
  owner-key argument — not a harness helper).
- `push-wake-e2e` — dropped its remaining local `controlAddrs` (review pass).
- `control-write-degraded-cohort-member` — dropped its local `nodeConfig` (review pass).

Two one-line local `nodeConfig` wrappers survive on purpose, in
`control-stream-authz` and `membership-connection-gater`: both exist only to pin
`strandFilter: 'none'` across many call sites, and neither duplicates harness logic.

## Review findings

### Fixed in this pass (minor)

- **The sweep stopped two files short of its own stated goal.** The plan ticket's
  expected outcome was "no scenario file defines any helper that the harness already
  provides", and its inventory table listed `control-write-degraded-cohort-member`
  (`nodeConfig`) and `push-wake-e2e` (`controlAddrs`) alongside the five headline
  files. Neither was touched. Both converted here; `push-wake-e2e`'s local
  `controlAddrs` was byte-identical to the new harness export.
- **A stale in-code comment pointing at this very ticket.**
  `control-write-degraded-cohort-member`'s local `nodeConfig` carried a header saying
  it was local "because the shared `controlNodeConfig` has no `trustedOwners` option
  yet — the one open decision in `plan/10-integration-test-harness-helper-
  consolidation-remaining-files`". That option (`pinnedOwnerKeys`) exists, so the
  comment documented a constraint that no longer held and cited a ticket that had
  already moved past `plan/`. Comment deleted with the function; the one substantive
  fact it carried ("unlike the isolation scenario, ALL THREE nodes listen") moved to a
  two-line note at the boot site, since that behavior is now the harness default rather
  than an explicit `listenAddrs`.
- **A pure-passthrough indirection.** `control-stream-authz` kept a local
  `waitForConnection(node, peerId, description)` whose entire body was
  `await waitForControlConnection(node, peerId, description)`. Inlined at all three
  call sites (`membership-connection-gater` had already done this, so the two files
  now match).
- **A hand-copied options type.** `control-stream-authz`'s local `NodeOpts` restated
  four fields of `ControlNodeOpts` and would silently drift from it. Replaced with
  `Omit<ControlNodeOpts, 'strandFilter'>`, and the wrapper got an explicit
  `CadreNodeConfig` return type rather than an inferred one.

### Checked and clean

- **The plan's one unresolved question — `hibernation`.** `membership-connection-gater`'s
  old local builder omitted the `hibernation` key entirely while `controlNodeConfig`
  always emits `hibernation: { enabled: false }`. Confirmed equivalent:
  `packages/cadre-core/src/cadre-node.ts:451` reads
  `config.hibernation ?? { enabled: false }`. The plan explicitly flagged this as the
  one check the previous review ran out of budget before finishing; it is now done, and
  the answer is no-op.
- **Config-shape fidelity at every converted call site.** Each deleted local builder was
  diffed field-by-field against what `controlNodeConfig` emits for the same options.
  The only deltas are intentional and behavior-neutral: `reconcileMs` is now spread on
  `!== undefined` instead of truthiness (so a deliberate `0` survives — no current
  caller passes `0`), and the trio's party-id prefix changed from `cohort3-` to
  `ctrl-trio-` when the boot moved into the shared module (party ids are per-run
  timestamps; nothing asserts on the prefix).
- **No leftover duplicates.** Swept all of `src/scenarios/` for locally-defined
  `wsTransports` / `nodeConfig` / `makeOwnOwner` / `randomPeerId` / `connectionsTo` /
  `hasOutboundTo` / `peerStoreAddrsFor` / `controlAddrs` / `connectControlNodes` /
  `createSignedSAppConfig` / `bootTrio` / `stopTrio`. Only the two deliberate
  `strandFilter: 'none'` wrappers remain. Also swept the package for any surviving
  "copy, don't refactor / until that lands / harness-consolidation" note: none left.
- **Assertion strength across the trio port.** `bootControlTrio` replaces the
  scenario's `expect(...)` ordering checkpoints with explicit `throw new Error(...)`,
  which is correct for a harness module with no `vitest` import. Every checkpoint the
  private `bootTrio` had is still present and still ordered identically, and the thrown
  messages name what was violated.
- **Docs.** Re-checked every `docs/` file that mentions `integration-tests`
  (`architecture.md`, `STATUS.md`, `cadre-host.md`, `strands.md`). None enumerates
  harness helpers or names any moved function, so nothing went stale. Stated explicitly
  rather than left silent — this was verified, not assumed.
- **Resource cleanup.** `stopControlTrio` stops newest-first and swallows-with-logging
  per node, so one failed `stop()` cannot leak the other two nodes' listeners or mask
  the failure that sent the test into `finally`. Both isolation tests call it in
  `finally`; the two files converted in this review pass already stopped their nodes in
  `beforeAll`/`afterAll` and were not restructured.

### Not fixed — out of scope, already tracked elsewhere

- `harness/node-fixtures.ts` and `harness/control-trio.ts` disagree on indentation
  (2-space vs tabs) against `.editorconfig`'s tabs-for-code. Pre-existing, repo-wide,
  and already owned by `backlog/editorconfig-tabs-decision`. Not re-filed.

### Tripwires

None. This diff changes which module a scenario imports its setup from and deletes
duplicate definitions; it introduces no new conditional cost, no new state, and no
dormant path. Saying so explicitly rather than inventing one.

## Validation

- `yarn workspace @serfab/integration-tests typecheck` — clean (exit 0).
- `yarn lint` (repo-wide) — clean (exit 0).
- `npx vitest run --reporter=verbose` over the five headline files: **9 tests, 5 pass,
  4 fail** — identical to the implement pass's result, no drift.
  - `membership-connection-gater` 3/3 pass, `control-stream-authz` 2/2 pass.
  - `strand-addr-seed-convergence` 1 fail, `control-cohort-three-node-isolation` 2 fail,
    `control-cohort-cold-start-retry` 1 fail.
- `npx vitest run --reporter=verbose` over the two files converted during this review
  pass: `push-wake-e2e` 2 pass / 2 fail, `control-write-degraded-cohort-member` fails in
  `beforeAll` ("B self-publishes its CadrePeer record", 45 s) so its 6 tests are skipped.

Every one of those failures is an already-tracked upstream `@optimystic/db-core`
cross-node sync defect, listed in `tickets/.pre-existing-known.md` against blocked
tickets `control-db-cross-node-convergence-halted` and
`transactor-key-network-ignores-network-scoping`. They are timeouts and
`holds committed revision N, but its header block read as absent` errors raised inside
node bring-up and control-DB sync — code this diff does not touch, since it only
changes which module a setup helper is imported from. Not regressions; not re-triaged,
and `tickets/.pre-existing-error.md` was deliberately not written.

One bookkeeping fix to `.pre-existing-known.md`: push-wake-e2e's "wakes a member whose
authorization and address were learned by control-DB replication" test was failing in
the same run and was NOT in the Open list — only its old, genuinely-fixed intermittent
failure appeared, down in the Resolved section. Added to Open under
`control-db-cross-node-convergence-halted` with a note distinguishing the two, so a
future agent does not read the Resolved entry and conclude the test should be green.

A whole-suite run was not attempted: the two batches above took 200 s and 68 s, and the
sibling-workspace stale-build guard needed `../quereus` and `../optimystic/packages/
db-p2p` rebuilt first (both were behind their `src`; `../quereus` had to be rebuilt
twice because a concurrent agent was editing that workspace mid-run). The change surface
— import sources only — makes anything outside the seven touched files very unlikely to
be affected.
