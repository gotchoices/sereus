description: Cleaned up duplicated test setup code across integration-test scenario files by moving the shared pieces (network transports, node config, authority bootstrap, peer-connection helpers) into the shared test harness, so there's one copy to maintain instead of near-identical copies scattered across a dozen files.
prereq:
files: packages/integration-tests/src/harness/test-network.ts, packages/integration-tests/src/scenarios/push-wake-e2e.integration.ts, packages/integration-tests/src/scenarios/control-db-two-node-convergence.integration.ts, packages/integration-tests/src/scenarios/control-write-while-alone-convergence.integration.ts, packages/integration-tests/src/scenarios/control-cohort-auto-convergence.integration.ts, packages/integration-tests/src/scenarios/strand-formation-e2e.integration.ts, packages/integration-tests/src/scenarios/rbac-signed-write.integration.ts, packages/integration-tests/src/scenarios/multi-party-workflows.integration.ts, packages/integration-tests/src/scenarios/strand-membership-closed-strand-e2e.integration.ts, packages/integration-tests/src/scenarios/convergence-stress.integration.ts, packages/integration-tests/src/scenarios/websocket-chat.integration.ts
difficulty: easy
----

## What changed

`packages/integration-tests/src/harness/test-network.ts` gained 8 new exports
(re-exported automatically through `harness/index.ts`'s existing `export *`):

- `wsTransports()` — WebSocket + circuit-relay transport list, used by every scenario
  that stands up its own `CadreNode`(s).
- `createSignedSAppConfig(schema, version)` — a properly owner-signed sApp config with
  `latencyHint: 'interactive'` (required for any hibernation/wake scenario — realtime
  strands never hibernate).
- `ControlNodeOpts` / `controlNodeConfig(opts)` — unifies what used to be 4 separate
  near-identical `NodeOpts`/`nodeConfig()` pairs (one per control-scenario file) into a
  single `CadreNodeConfig` builder. Supports `privateKey`, `hibernation`, and
  `reconcileMs` (the control-cohort proactive-reconcile cadence override).
- `makeOwnOwner(node, key)` — makes a freshly-started node its own control-network
  genesis owner. Returns the owner's public key (base64url) now, in all 4 call sites
  (previously 3 of 4 returned `void`) — source-compatible, unused-return is legal.
- `randomPeerId()` — a real Ed25519 peer id for a peer that's never started (a pure row
  subject in convergence assertions).
- `connectControlNodes(reader, writer)` — establishes + confirms a direct control-network
  connection between one specific pair of peers. Two of the four sites this replaces had
  a LOOSER check (`getConnections().length > 0` on both sides, i.e. "any connection at
  all"); the hoisted version is the STRICTER, pair-scoped check
  (`getConnections().some(c => c.remotePeer.toString() === expectedPeerId)`) that was
  already load-bearing in `push-wake-e2e`'s 3-node full-mesh scenario. This is a
  deliberate behavioral tightening, not a regression — see "What to verify" below.
- `bootPair(tag, partyIdPrefix = 'ctrl')` — boots a disconnected owner+reader node pair
  on a fresh party, with the owner vouching the reader. `partyIdPrefix` defaults to
  `'ctrl'` (control-db-two-node-convergence's existing party-id shape);
  control-write-while-alone-convergence's two call sites now pass `'ctrl-alone'`
  explicitly to keep its existing party-id strings unchanged.

All 10 scenario files (see `files:` above, minus the harness file itself) had their
local duplicate of whichever of these helpers they defined deleted, and now import the
shared version from `../harness/index.js`. Two files
(`convergence-stress.integration.ts`, `websocket-chat.integration.ts`) previously
imported `waitUntil`/`sleep` directly from `../harness/wait-utils.js`; those imports
were switched to the barrel `../harness/index.js` so `wsTransports` could be added
alongside without a second import statement. Deliberately left local (per design,
not touched): `strand-formation-e2e.integration.ts`'s
`createUnsignedSAppConfig`/`createTamperedSAppConfig`/`createWrongKeySAppConfig`
(deliberately-invalid config variants used nowhere else), and every strand-scenario-family
`createTestNodeConfig`/`createNodeConfig`-shaped helper in the 4 non-control scenario
files (a distinct options shape from the control-network `controlNodeConfig`).

## How this was executed

Work was done by the harness file being edited directly, then one subagent per scenario
file (10 total) running in parallel, each given only its own file path and the exact
per-file edit list. Every subagent independently verified its own file with grep before
finishing; several also ran their own `tsc`/`eslint` pass. One lint error surfaced across
the whole set (a `CadreNode` import in `control-write-while-alone-convergence.integration.ts`
that became type-only once its value-position use — inside the now-deleted local
`bootPair` — was removed); fixed directly (`import type { CadreNode }`).

## Verification performed

- `yarn workspace @serfab/integration-tests typecheck` — clean, no errors.
- `yarn eslint` scoped to all 11 touched files (harness + 10 scenarios) — clean, no
  errors, no warnings.

## Known gap — the actual test suite was NOT run

**This is the main thing for the reviewer to close.** These are long-running
real-libp2p integration tests, and this session hit its token budget before getting to
them. Typecheck + lint passing proves the refactor is *syntactically* a pure hoist, but
does NOT prove runtime behavior is unchanged. Please run, at minimum:

```
yarn workspace @serfab/integration-tests test
```

or, if the full suite risks the 10-minute idle-timeout window, the individual touched
scenario files (stream output, don't redirect silently — a silent redirect can let the
idle timer expire and lose the run).

Priority order, because these are the ones where the hoist changed behavior or is
structurally load-bearing, not just a mechanical copy:

1. **`control-db-two-node-convergence.integration.ts`** and
   **`control-write-while-alone-convergence.integration.ts`** — these are the landed
   network-backing regression anchors, and both now use the STRICTER pair-scoped
   `connectControlNodes` instead of their original loose "any connection" check. In
   their current 2-node topology there's only ever one possible connection either way,
   so this should be a no-op — but that assumption needs an actual test run to confirm,
   not just code-reading. Watch for new hangs or timeout-window regressions.
2. **`push-wake-e2e.integration.ts` scenario 4** (the 3-node full-mesh case:
   `connectControlNodes(S, A)`, `connectControlNodes(Rx, A)`, `connectControlNodes(Rx, S)`)
   — this is the one call site where pair-scoping is actually load-bearing (three
   independent pairwise connections must each be confirmed separately). It already used
   the pair-scoped version locally before the hoist, so this should be unaffected, but
   it's the highest-value scenario to confirm still passes.
3. The remaining 8 touched scenario files, as a sanity pass that nothing else broke.

## Use cases / what a reviewer should look for

- Diff each deleted local helper against the shared harness version it replaced —
  especially `createSignedSAppConfig` (5 call sites; confirm none had a subtly
  different `latencyHint` or field that got silently dropped) and `controlNodeConfig`
  (4 call sites; confirm the `hibernation`/`reconcileMs` optional-field defaults
  produce identical `CadreNodeConfig` output to what each file had before).
- Confirm `control-write-while-alone-convergence.integration.ts`'s two `bootPair` call
  sites still produce party ids prefixed `ctrl-alone-...` (not `ctrl-...`) — this was
  the one place a call-site argument had to change (adding the explicit
  `'ctrl-alone'` second argument) rather than just deleting a local function.
- `harness/index.ts` needed no changes — checked for export-name collisions against
  every other harness module before adding the 8 new names; none found.

No tripwires were identified during this pass — the divergences called out above
(loose-vs-pair-scoped `connectControlNodes`, `bootPair`'s prefix default) were resolved
in the hoist itself, not deferred.
