description: Verify-only ticket — confirmed that the optimystic sibling-side commit (`3d50e43 ticket(implement): web-e2e-tier2-connectivity (sibling-side)`) unblocks the sereus Tier 2 connectivity e2e. No sereus source changes were required; the work was purely upstream and the consumer-side verification has now landed green.
files: ../optimystic/packages/db-p2p/src/libp2p-node-base.ts, ../optimystic/packages/reference-peer/src/cli.ts, ../optimystic/packages/db-p2p/dist/src/libp2p-node-base.d.ts, ../optimystic/packages/reference-peer/dist/src/cli.js, packages/reference-app-web/src/lib/optimystic.ts, packages/reference-app-web/e2e/fixtures/reference-peer.ts, packages/reference-app-web/e2e/distributed/mode-flip.spec.ts
----

## Summary

The fix ticket diagnosed two uncommitted upstream patches in `../optimystic` blocking Tier 2 e2e. Those landed in optimystic `3d50e43`, both packages were rebuilt, and the sereus-side consumer verification has now passed.

Upstream surfaces confirmed:
- `@optimystic/db-p2p` — `NodeOptions.connectionGater?: ConnectionGater` present at `dist/src/libp2p-node-base.d.ts:87`. Source change: `packages/db-p2p/src/libp2p-node-base.ts` (commit `3d50e43`).
- `@optimystic/reference-peer` — `--offline` declared on `interactive`, `service`, and `run` subcommands at `dist/src/cli.js:590,627,663`. Source change: `packages/reference-peer/src/cli.ts` (commit `3d50e43`).

The sereus consumer code is unchanged:
- `packages/reference-app-web/src/lib/optimystic.ts` passes `connectionGater: { denyDialMultiaddr: () => false }` to the browser libp2p node (depends on the new optional `NodeOptions` field).
- `packages/reference-app-web/e2e/fixtures/reference-peer.ts` spawns `cli.js interactive --ws-port N --no-tcp --relay --offline` (depends on the new `--offline` commander flag).

## Verification run

```
yarn workspace @serfab/reference-app-web test:e2e --grep "Tier 2 / distributed / mode flip"
```

Result (truncated):

```
[e2e] spawning reference-peer fixture on ws port 9191…
[e2e] reference-peer ready: /ip4/127.0.0.1/tcp/9191/ws/p2p/12D3KooWC7fG1ohnFdbRFk2yFWaSauyCJokG2y3gJY5j9kSnvNC7

Running 2 tests using 1 worker

  ✓  1 [chromium] › Tier 2 / distributed / mode flip › Connect flips solo → distributed and lists the bootstrap peer (6.2s)
  ✓  2 [chromium] › Tier 2 / distributed / mode flip › Disconnect snaps back to solo and empties the connection list (3.8s)

  2 passed (25.2s)
```

Both end-to-end behaviours confirmed at runtime, not just at the type level:
1. Fixture spawned cleanly — proves `--offline` is wired through commander to the LocalTransactor branch.
2. Browser dialed the loopback WS multiaddr — proves the permissive `connectionGater` reached the libp2p node (would otherwise be denied by the default browser gater).
3. `mode-badge` flipped to `distributed` and a `diag-connection-row` for the bootstrap peer id appeared.
4. `btn-disconnect` snapped the badge back to `solo` and the diagnostics connection list drained to zero.

Optimystic working tree status remains clean (`git -C ../optimystic status`); no further uncommitted patches needed.

## What the reviewer should check

This was verification-only — no sereus source changes — so the review surface is narrow:

- **Sanity-check the run was honest.** The full Playwright log is at `/tmp/tier2-e2e.log` (within the agent's tmpfs; not persisted into the repo). A reviewer can re-run the same command and should expect both specs green in ~25–30s. If the run fails on a *fresh* clone, the optimystic dist may not be rebuilt — `yarn workspace @optimystic/db-p2p build && yarn workspace @optimystic/reference-peer build` is the rebuild gesture.
- **Confirm the upstream surfaces are still present** in `../optimystic` HEAD (currently `3d50e43`):
  - `grep -n connectionGater ../optimystic/packages/db-p2p/dist/src/libp2p-node-base.d.ts` should show line 87.
  - `grep -n offline ../optimystic/packages/reference-peer/dist/src/cli.js | head -10` should show `--offline` on three commander options.
- **No sereus-side changes were made or expected.** `git status` should show only the ticket-folder transition (this file moving into `complete/`, the implement file deleted).

## Known gaps / honesty notes

- Only the Tier 2 *mode-flip* spec was run (per ticket scope, `--grep "Tier 2 / distributed / mode flip"`). The broader Tier 2 suite was not exercised under this ticket; if there are other distributed specs gated on the same surfaces, they were not explicitly verified here. A reviewer who wants stronger coverage can drop the `--grep` and run the full `test:e2e`.
- The vite build emits two `dynamic import will not move module into another chunk` warnings against optimystic's `@libp2p/peer-id` and `p2p-fret`. These are pre-existing — they reflect a mix of static and dynamic imports inside the sibling dist and are unrelated to this ticket's surfaces. Worth a separate cleanup ticket if anyone cares about chunking, but they do not affect functionality.
- `../optimystic` is one commit ahead of `origin/main` (the sibling-side commit is not yet pushed). That's fine for local verification but a downstream consumer pulling fresh would need that commit pushed before they could reproduce. Not in scope for this ticket — flagging for awareness.
