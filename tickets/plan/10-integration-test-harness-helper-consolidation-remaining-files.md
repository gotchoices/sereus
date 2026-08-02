description: Three more integration-test scenario files still keep their own private copies of test setup code that now lives in the shared test harness, so a cleanup pass started on this file set is only partway done.
prereq:
files: packages/integration-tests/src/harness/node-fixtures.ts, packages/integration-tests/src/harness/control-trio.ts, packages/integration-tests/src/scenarios/strand-addr-seed-convergence.integration.ts, packages/integration-tests/src/scenarios/control-cohort-three-node-isolation.integration.ts, packages/integration-tests/src/scenarios/control-cohort-cold-start-retry.integration.ts
difficulty: easy
----

## Background

This is a continuation of `10-integration-test-harness-helper-consolidation-remaining-files`
(same slug, re-filed after a run stopped partway through on a token-budget warning). That
ticket found five scenario files still defining private copies of helpers that had already
been moved into the shared harness (`packages/integration-tests/src/harness/node-fixtures.ts`,
re-exported through `packages/integration-tests/src/harness/index.ts`).

**Two of the five are already done** — do not re-touch them:
- `packages/integration-tests/src/scenarios/membership-connection-gater.integration.ts`
- `packages/integration-tests/src/scenarios/control-stream-authz.integration.ts`

Both now import `controlNodeConfig`, `makeOwnOwner`, `waitForControlConnection` (and, for the
stream-authz file, `waitUntil`) from `../harness/index.js` and no longer define local
`wsTransports`/`nodeConfig`/`makeOwnOwner`/`waitForConnection`. Verified clean (no leftover
references to `ed25519KeyPairFromLibp2p`, `MemoryRawStorage`, `CadreNodeConfig`, `webSockets`,
`circuitRelayTransport` in either file — those imports were all removed along with the local
helpers they supported). Neither file's tests were re-run after the edit (stopped on the
budget warning before validation) — worth a quick typecheck/test pass early in this ticket to
confirm they're actually green, since that wasn't verified.

**The harness itself already gained what the remaining three files need:**
- `ControlNodeOpts` (`node-fixtures.ts`) now has a `strandFilter?: 'all' | 'none'` option
  (default `'all'`); `controlNodeConfig` passes it through as `strandFilter: { mode: ... }`.
- `node-fixtures.ts` now exports `controlAddrs(node): string[]` (was missing before; added
  for the strand-addr-seed-convergence file below).
- `node-fixtures.ts` now exports `waitForControlConnection` (was a private helper before).
- `connectionsTo`, `hasOutboundTo`, `peerStoreAddrsFor`, `randomPeerId`, `makeOwnOwner`,
  `connectControlNodes`, `createSignedSAppConfig`, `wsTransports` were already exported (from
  earlier ticket passes) and need no further changes.
- `bootControlTrio` / `stopControlTrio` already exist in
  `packages/integration-tests/src/harness/control-trio.ts` and are exported through
  `harness/index.ts`.

## What's left

| File | Local copies it still has |
| --- | --- |
| `strand-addr-seed-convergence` | `wsTransports`, `createSignedSAppConfig`, `nodeConfig`, `makeOwnOwner`, `connectControlNodes`, `controlAddrs` |
| `control-cohort-three-node-isolation` | `wsTransports`, `nodeConfig`, `makeOwnOwner`, `connectionsTo`, `hasOutboundTo`, `peerStoreAddrsFor`, and its whole private `bootTrio` |
| `control-cohort-cold-start-retry` | `wsTransports`, `nodeConfig`, `makeOwnOwner`, `randomPeerId`, `connectionsTo` |

All five swap-in helpers above (`wsTransports`, `createSignedSAppConfig`, `makeOwnOwner`,
`randomPeerId`, `connectControlNodes`) are character-identical to the shared versions already
in the harness (modulo `makeOwnOwner`'s return type: some local copies return nothing, the
shared one returns the owner public key — source-compatible, callers may discard it).

`strand-addr-seed-convergence.integration.ts` ALSO carries a stale in-file note (near its local
helpers, around the "NOTE: copied verbatim from push-wake-e2e..." comment) saying its helpers
are copied on purpose "until [the harness-consolidation ticket] lands" — remove that note as
part of swapping the helpers in, since it will no longer be true.

### `strand-addr-seed-convergence.integration.ts`

Its local `nodeConfig` already uses `strandFilter: { mode: 'all' }` and
`hibernation: { enabled: opts.hibernation ?? false }` — both already match
`controlNodeConfig`'s defaults, so this is a straight swap, no new harness option needed.
Replace the local `wsTransports`, `createSignedSAppConfig`, `nodeConfig`, `makeOwnOwner`,
`connectControlNodes`, and `controlAddrs` with harness imports (`controlNodeConfig`,
`createSignedSAppConfig`, `makeOwnOwner`, `connectControlNodes`, `controlAddrs` from
`../harness/index.js`), and delete the stale "copy, don't refactor" note.

### `control-cohort-three-node-isolation.integration.ts`

This file's private `bootTrio` (~150 lines, roughly lines 181-320) is a byte-for-byte twin of
`bootControlTrio` in `harness/control-trio.ts` — the latter is a **port** made by a different
ticket (`debt-cohort-edge-carries-data-coverage`) specifically so this file could be migrated
later without that other ticket touching it. That migration is this ticket's job:

- Delete the local `bootTrio`, `Trio`/`TrioHandles` interfaces, `stopTrio`, `wsTransports`,
  `nodeConfig`, `makeOwnOwner`, `connectionsTo`, `hasOutboundTo`, `peerStoreAddrsFor`.
- Import `bootControlTrio`, `stopControlTrio`, `ControlTrioHandles`, `hasOutboundTo`,
  `connectionsTo`, `peerStoreAddrsFor` from `../harness/index.js`.
- Both call sites (`bootTrio({ reconcileMsB, handles })`) become
  `bootControlTrio({ reconcileMsB, handles })` — the isolation scenario never needs `gaterB`,
  so that option is simply omitted (it's optional on `ControlTrioOptions`).
- `bootControlTrio` returns `{ A, B, C, aPeerId, bPeerId, cPeerId }` (the local `bootTrio`
  returned only `{ B, C, cPeerId }`) — destructure only what each test body uses.
- `control-trio.ts`'s file header currently says it's "a port of the private `bootTrio` in
  `control-cohort-three-node-isolation.integration.ts` (which deliberately keeps its own copy
  until the harness-consolidation ticket lands there)" — update or remove that note once the
  isolation scenario calls the shared version instead of keeping its own.

Note: this scenario is currently a known pre-existing failure (blocked ticket
`transactor-key-network-ignores-network-scoping`, see `tickets/.pre-existing-known.md`) for
reasons unrelated to this refactor. It will very likely still fail after this change — that is
expected and NOT a regression to chase here. Confirm with a git stash / pre-change run if you
need a baseline, but do not attempt to fix the underlying failure in this ticket.

### `control-cohort-cold-start-retry.integration.ts`

Its local `nodeConfig` uses `strandFilter: { mode: 'all' }` and
`hibernation: { enabled: false }`, both matching the shared defaults. Replace local
`wsTransports`, `nodeConfig`, `makeOwnOwner`, `randomPeerId`, `connectionsTo` with harness
imports.

Note: this scenario is ALSO a currently known pre-existing failure (blocked ticket
`control-db-cross-node-convergence-halted`) for reasons unrelated to this refactor — same
caveat as above, do not chase it here.

## Edge cases & interactions

- `makeOwnOwner`'s shared version returns `Promise<string>` (the owner public key) where some
  local copies returned `Promise<void>`. Every call site in these three files already discards
  the return value (`await makeOwnOwner(A, aKey);` with no destructuring), so this is a no-op
  swap — but grep each file's call sites to confirm none was relying on `void`-typed inference
  before you swap the import.
- `control-cohort-three-node-isolation`'s `bootTrio` and the harness's `bootControlTrio` must
  stay behaviorally identical for the isolation proof's ordering claims to still hold — diff
  them side by side before deleting the local copy, not just at the type level. Pay particular
  attention to the ordering comments (steps 1-6) in both files; they encode a real invariant
  (see the file headers), not just documentation.
- After deleting `control-cohort-three-node-isolation`'s local `Trio`/`TrioHandles` types,
  check nothing else in that file still references them by name (e.g. a leftover type
  annotation) — the shared `control-trio.ts` names its equivalents `ControlTrio` /
  `ControlTrioHandles`.
- `strand-addr-seed-convergence`'s local `connectControlNodes` uses `expect(...)` internally
  (via vitest) for one of its assertions (`expect(writerAddrs.length).toBeGreaterThan(0)`);
  the shared harness version in `node-fixtures.ts` throws a plain `Error` instead (harness
  modules have no `vitest` import, per `control-trio.ts`'s header convention). Confirm the
  test still fails informatively if that precondition is ever violated — an `Error` throw is
  the intended shared-harness pattern, not a regression.

## Expected outcome

No scenario file in `files:` above defines any helper that the harness already provides — all
three import from `../harness/index.js`. Behavior must be unchanged — every node config these
files produce must be byte-for-byte the same object shape as before the swap.

## Validation

```
cd packages/integration-tests && npx vitest run --reporter=dot
```

Also run `yarn workspace @serfab/integration-tests typecheck` and `yarn lint`.

Two scenarios in this file set (`control-cohort-three-node-isolation`,
`control-cohort-cold-start-retry`) are pre-existing failures unrelated to this refactor — see
`tickets/.pre-existing-known.md`. Do not re-triage them; a continued failure with the SAME
fingerprint after your change is expected. A NEW failure mode (different error, different
scenario) means the refactor broke something and needs to be fixed before handoff.

Note: the suite's stale-build guard checks the sibling `C:\projects\quereus` workspace. If it
trips, rebuild with `cd C:\projects\quereus\packages\quereus && npx tsc` — the
`yarn workspace @quereus/quereus build` form silently no-ops from some shells.

## TODO

- Sanity-check the two already-converted files (`membership-connection-gater.integration.ts`,
  `control-stream-authz.integration.ts`) actually typecheck and pass — they were edited but
  not re-validated before this handoff.
- Swap `strand-addr-seed-convergence.integration.ts`'s local helpers for harness imports;
  remove the stale "copy, don't refactor" note.
- Migrate `control-cohort-three-node-isolation.integration.ts` off its private `bootTrio` onto
  `bootControlTrio`/`stopControlTrio` from `harness/control-trio.ts`; update or remove
  `control-trio.ts`'s "port, awaiting this ticket" header note.
- Swap `control-cohort-cold-start-retry.integration.ts`'s local helpers for harness imports.
- Run the validation commands above and confirm no new failures (the two listed pre-existing
  ones are expected to persist).
