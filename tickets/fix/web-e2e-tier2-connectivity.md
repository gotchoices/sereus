description: Tier 2 Playwright suite for @serfab/reference-app-web cannot establish a libp2p connection to the spawned reference-peer; mode flips to distributed but `node.getConnections()` stays at zero
files: packages/reference-app-web/e2e/fixtures/reference-peer.ts, packages/reference-app-web/e2e/distributed/_helpers.ts, ../optimystic/packages/reference-peer/src/cli.ts, packages/reference-app-web/README.md
----

## Symptom

Every Tier 2 spec under `packages/reference-app-web/e2e/distributed/` fails inside `connectToBootstrap` (e2e/distributed/_helpers.ts:56-61). The browser:

1. Boots solo, then receives the bootstrap multiaddr.
2. Restarts the libp2p node with the bootstrap arg — the `mode-badge` flips to `distributed`.
3. Polls Diagnostics for `[data-testid="diag-connection-row"]` for up to 60 s.
4. The connection count stays at `0` for the full window. No errors land in the in-app `diag-errors` ring buffer.

A bare `ws://127.0.0.1:<port>/` dial from a Node script against the same spawned peer **does** open the WebSocket, so the WS server is listening and accepting browser-shaped clients. The libp2p handshake (noise + identify + bootstrap discovery) is what fails to settle.

## Likely root cause

The optimystic `interactive` subcommand does not declare an `--offline` flag (only `service` / `run` do — see `../optimystic/packages/reference-peer/src/cli.ts:658-687` vs the other subcommands that share most options). The fixture therefore spawns the peer without `--offline`, and the peer boots into the multi-node `Distributed (NetworkTransactor)` mode rather than the single-node `Offline (LocalTransactor)` the plan ticket assumed. A single-tab browser cannot join a multi-node distributed cluster of one, so the dial never settles.

## Smallest-credible fix

Patch the optimystic `interactive` command to declare `--offline` (matching what `service`/`run` already do) and pass it through to `session.startNetwork()`. Once that lands, change the fixture spawn in `packages/reference-app-web/e2e/fixtures/reference-peer.ts` back to include `--offline` and rerun the Tier 2 suite. The Tier 2 specs themselves should not need changes — they all funnel through `connectToBootstrap`, which only cares that there is ≥ 1 connection row on Diagnostics.

If patching optimystic is out of scope, an alternative is to rewire the fixture to use the `run --stay-connected` subcommand (which does support `--offline`) and parse the listen-addr line from its output the same way. This is a fallback; preferred fix is the upstream `interactive` patch since the README-level documentation already calls out the `interactive --no-tcp --relay --offline` recipe.

## Out of scope for this fix

- Any of the Tier 1 specs (passing today).
- The storage-backend label minification (separate backlog item).
- CI wiring.

## Reproduction

```bash
yarn workspace @optimystic/reference-peer build
yarn workspace @serfab/reference-app-web test:e2e --grep "Tier 2 / distributed / mode flip"
```

Both tests in `mode-flip.spec.ts` fail at `connectToBootstrap` after waiting 60 s for the first connection row.

## Acceptance

- All 6 Tier 2 specs (mode flip × 2, bootstrap-persistence × 1, two-tab convergence × 1, cross-tab activity × 1, disconnect-mid-session × 1) pass on a clean checkout with the optimystic sibling built.
- `connectToBootstrap` no longer times out at the connection-row poll.
- README "Tier 2 is currently red" callout deleted once green.
