description: The sereus web-e2e-tier2-connectivity work depends on two uncommitted changes in `../optimystic` (the `--offline` flag on the reference-peer CLI and the `connectionGater?: ConnectionGater` field on `db-p2p`'s `NodeOptions`); the sereus runner's commit pass does not touch the sibling repo, so a fresh checkout of both repos cannot build or run Tier 2 e2es.
files: ../optimystic/packages/db-p2p/src/libp2p-node-base.ts, ../optimystic/packages/reference-peer/src/cli.ts, ../optimystic/packages/reference-peer/dist/src/cli.js, packages/reference-app-web/src/lib/optimystic.ts, packages/reference-app-web/e2e/fixtures/reference-peer.ts
----

## Symptom

After `tickets/review/web-e2e-tier2-connectivity` is complete on the sereus side, `git -C ../optimystic status` reports:

```
Changes not staged for commit:
  modified:   packages/db-p2p/src/libp2p-node-base.ts
  modified:   packages/reference-peer/src/cli.ts
```

These are the exact patches the sereus implement commit (`ab09554`) depends on — the browser node config passes `connectionGater: { denyDialMultiaddr: () => false }` (needs the new `connectionGater?` field on `NodeOptions`), and the Playwright fixture spawns `interactive --offline` (needs the new commander option).

On a fresh `git clone` of both repos:
1. `yarn --cwd ../optimystic workspace @optimystic/db-p2p build` produces a `dist/` whose `NodeOptions` lacks `connectionGater`.
2. `yarn workspace @serfab/reference-app-web typecheck` then fails on `packages/reference-app-web/src/lib/optimystic.ts:158` (extra `connectionGater` property not in type).
3. Even if the sereus typecheck were relaxed, `node ../optimystic/.../cli.js interactive --offline` would fail with `unknown option '--offline'`, causing every Tier 2 spec to fail at fixture spawn.

## Diff to land (already authored, just not committed)

```diff
# packages/db-p2p/src/libp2p-node-base.ts
-import type { PrivateKey } from '@libp2p/interface';
+import type { ConnectionGater, PrivateKey } from '@libp2p/interface';
 ...
 	privateKey?: PrivateKey;
+
+	/**
+	 * Optional libp2p connection gater. The libp2p browser default denies
+	 * dialing insecure WebSockets and private/loopback addresses; callers
+	 * that need to dial local or unsecured bootstraps (web reference dev,
+	 * Playwright e2e, RN simulators) supply a permissive gater here.
+	 */
+	connectionGater?: ConnectionGater;
 ...
 		dialQueue: { concurrency: 2, attempts: 2 }
 	},
+	...(options.connectionGater ? { connectionGater: options.connectionGater } : {}),
 	transports,
```

```diff
# packages/reference-peer/src/cli.ts — repeat on `interactive`, `service`, `run`
 	.option('--storage-capacity <bytes>', 'Override storage capacity in bytes (for ring selection)')
+	.option('--offline', 'Run as single-node LocalTransactor (no distributed consensus)')
 	.option('--bootstrap-file <path>', 'Path to JSON containing bootstrap multiaddrs or node list')
```

## Action

Commit the working-tree changes in `../optimystic` with a message in the project's `ticket(implement): ...` style (e.g. `ticket(implement): web-e2e-tier2-connectivity (sibling-side)` or split into a standalone optimystic-side ticket — the upstream project's convention takes precedence). Rebuild the two packages so `dist/` lands fresh:

```bash
yarn --cwd ../optimystic workspace @optimystic/db-p2p build
yarn --cwd ../optimystic workspace @optimystic/reference-peer build
```

## Acceptance

- `git -C ../optimystic status` reports a clean tree (after `dist/` is regenerated and gitignored as usual).
- A second machine, after `git pull` on both repos and a clean `yarn install` + build, can run `yarn workspace @serfab/reference-app-web typecheck` and `yarn workspace @serfab/reference-app-web test:e2e --grep "Tier 2 / distributed / mode flip"` without re-applying patches.

## Risk notes

- This is purely a packaging / version-control hygiene fix — no design tradeoffs.
- If the optimystic project wants the change reshaped before landing (different option grouping, additional tests, etc.), defer to its conventions; the sereus consumer's contract is just "the `connectionGater?` field exists on `NodeOptions` and `--offline` is declared on the three commander subcommands."
