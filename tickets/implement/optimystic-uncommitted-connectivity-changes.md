description: Verify the sibling-side commit (optimystic `3d50e43 ticket(implement): web-e2e-tier2-connectivity (sibling-side)`) actually unblocks a clean Tier 2 e2e run on the sereus side. The two upstream surfaces (`NodeOptions.connectionGater?` on `@optimystic/db-p2p`, `--offline` flag on `@optimystic/reference-peer`'s `interactive`/`service`/`run` commands) have been committed and the `dist/` outputs rebuilt; this ticket closes out the consumer-side verification.
files: ../optimystic/packages/db-p2p/src/libp2p-node-base.ts, ../optimystic/packages/reference-peer/src/cli.ts, ../optimystic/packages/db-p2p/dist/src/libp2p-node-base.d.ts, ../optimystic/packages/reference-peer/dist/src/cli.js, packages/reference-app-web/src/lib/optimystic.ts, packages/reference-app-web/e2e/fixtures/reference-peer.ts
----

## Context

The fix ticket diagnosed that the sereus `web-e2e-tier2-connectivity` work (sereus commit `ab09554`) depended on two uncommitted upstream patches in `../optimystic`. Those patches have now been committed (optimystic `3d50e43`) and both packages rebuilt:

- `@optimystic/db-p2p`: `NodeOptions.connectionGater?: ConnectionGater` is present in `dist/src/libp2p-node-base.d.ts` (line 87).
- `@optimystic/reference-peer`: `--offline` declared on all three commander subcommands in `dist/src/cli.js` (lines 590, 627, 663).

`yarn workspace @serfab/reference-app-web typecheck` already passes against the rebuilt sibling `dist/` (exit 0).

## What remains

Run the actual Tier 2 e2e to confirm end-to-end behaviour, not just types:

```
yarn workspace @serfab/reference-app-web test:e2e --grep "Tier 2 / distributed / mode flip"
```

The fixture (`packages/reference-app-web/e2e/fixtures/reference-peer.ts`) spawns `node ../optimystic/.../cli.js interactive --offline ...`; the browser config (`packages/reference-app-web/src/lib/optimystic.ts:158`) passes `connectionGater: { denyDialMultiaddr: () => false }`. With the rebuilt sibling dist, both should resolve at runtime rather than failing fixture spawn / NodeOptions type-rejection.

## Acceptance

- The Tier 2 connectivity spec passes locally against the rebuilt `../optimystic/packages/{db-p2p,reference-peer}/dist`.
- `git -C ../optimystic status` remains clean (no further uncommitted patches needed).
- No sereus-side source changes are required — this ticket is verification only.

## TODO

- Run `yarn workspace @serfab/reference-app-web test:e2e --grep "Tier 2 / distributed / mode flip"` and confirm green.
- If the Tier 2 spec fails for any reason other than the two surfaces above (e.g. flaky port allocation, browser context teardown), spawn a fresh `fix/` ticket with the failure trace — don't expand scope here.
- Otherwise produce the review handoff.
