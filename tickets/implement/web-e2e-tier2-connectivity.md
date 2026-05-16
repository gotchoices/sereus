description: Add `--offline` flag to optimystic `interactive` (and sibling) commands, then thread it through the Tier 2 Playwright fixture so reference-peer boots as a single-node LocalTransactor the browser can dial
files: ../optimystic/packages/reference-peer/src/cli.ts, packages/reference-app-web/e2e/fixtures/reference-peer.ts, packages/reference-app-web/README.md, packages/reference-app-web/e2e/distributed/_helpers.ts
----

## Background

Tier 2 specs (`packages/reference-app-web/e2e/distributed/*`) all stall in `connectToBootstrap` (e2e/distributed/_helpers.ts:56-61): the mode badge flips to `distributed` but `node.getConnections()` never reaches 1. Root cause: the spawned reference-peer comes up in `Distributed (NetworkTransactor)` mode — a single-node distributed cluster — which a single browser tab cannot meaningfully join.

The peer's option-handling code already supports `offline?: boolean` (`../optimystic/packages/reference-peer/src/cli.ts:186, 288, 345-371`) but **no commander subcommand declares `--offline`**. Adding `--offline` to `interactive` (and ideally `service`/`run` for symmetry — same option list, same plumbing) makes `session.startNetwork({ offline: true })` reachable, which flips the transactor to `LocalTransactor`. A LocalTransactor peer accepts the browser's libp2p dial without needing a cluster-consensus quorum.

## Approach

Single tightly-coupled change spanning two repos:

1. **Upstream (optimystic):** declare `--offline` on the three subcommands that already type the option (`interactive`, `service`, `run`). Camel-case mapping in commander makes it land on `options.offline` automatically, so no other code paths need to change. Then rebuild the package.

2. **This repo (sereus):** add `--offline` to the spawn argv in `packages/reference-app-web/e2e/fixtures/reference-peer.ts`, drop the multi-line "the optimystic interactive command does not declare that flag today" comment, fix the corresponding callout in `packages/reference-app-web/README.md` (lines 258-262 and the parenthetical at line 275-276), and run the Tier 2 suite to confirm green.

The Tier 2 specs and `connectToBootstrap` poll loop should not need code changes — they only assert `≥ 1` connection row.

## TODO

Phase 1 — optimystic patch
- Edit `../optimystic/packages/reference-peer/src/cli.ts` to add `.option('--offline', 'Run as single-node LocalTransactor (no distributed consensus)')` to the `interactive`, `service`, and `run` command definitions (around lines 657-687, 690-721, 724-744). Place it adjacent to the other mode-shaping options (e.g. after `--storage-capacity` or near `--bootstrap`).
- Rebuild: `yarn --cwd ../optimystic workspace @optimystic/reference-peer build` and verify `dist/src/cli.js` reflects the new flag (e.g. `node dist/src/cli.js interactive --help | grep offline`).

Phase 2 — fixture + docs
- Update `packages/reference-app-web/e2e/fixtures/reference-peer.ts:34-42` argv array to include `'--offline'` (insert after `'--relay'`).
- Replace the stale doc-comment block at `packages/reference-app-web/e2e/fixtures/reference-peer.ts:14-27` with a short single-line description (e.g. "Spawn args: `interactive --ws-port N --no-tcp --relay --offline` — single-node LocalTransactor so the browser can dial without a quorum."). Don't preserve the "the upstream command does not declare that flag today" wording.
- Update `packages/reference-app-web/README.md` lines 258-262 (delete the "Tier 2 is currently red" block) and line 275-276 (drop the "The plan asked for `--offline` too — see the known-issue note above." parenthetical; replace with confirmation that `--offline` is passed).

Phase 3 — validate
- Run the targeted reproduction first: `yarn workspace @serfab/reference-app-web test:e2e --grep "Tier 2 / distributed / mode flip" 2>&1 | tee /tmp/tier2-modeflip.log`. Both `mode-flip.spec.ts` cases must pass.
- Then the full Tier 2 sweep: `yarn workspace @serfab/reference-app-web test:e2e --grep "Tier 2" 2>&1 | tee /tmp/tier2.log`. All 6 specs (mode flip × 2, bootstrap-persistence, two-tab convergence, cross-tab activity, disconnect-mid-session) must pass.
- Confirm Tier 1 still passes: `yarn workspace @serfab/reference-app-web test:e2e --grep "Tier 1" 2>&1 | tee /tmp/tier1.log`.

## Risk notes

- If after `--offline` lands the browser still fails to connect, the next-likeliest cause is the noise handshake or `/ws` multiaddr selection — re-check that the fixture is still picking the `127.0.0.1` loopback candidate (reference-peer.ts:103-108) rather than a LAN-address sibling, and inspect the diag-errors ring buffer in the Playwright trace.
- The optimystic build is on the sibling `../optimystic` checkout; if it's missing or out of date the Tier 2 fixture will fall back to "not available" and tests will skip rather than fail — re-run `yarn --cwd ../optimystic workspace @optimystic/reference-peer build` if `e2e/.fixture-state.json` reports unavailable.
- Adding `--offline` to `service`/`run` is symmetric and harmless (the handler code already branches on `options.offline`) but if the optimystic checkout is shared with other consumers, verify nothing depends on `--offline` being un-declared (very unlikely — it's purely additive).

## Acceptance

- All 6 Tier 2 specs pass on a clean checkout with the optimystic sibling rebuilt.
- `connectToBootstrap` resolves the connection-row poll within its 60s window (typically well under 5s).
- README "Tier 2 is currently red" callout removed; fixture-state resolution paragraph updated to reflect `--offline` is passed.
- Fixture-file comment block trimmed to a single timeless line.
