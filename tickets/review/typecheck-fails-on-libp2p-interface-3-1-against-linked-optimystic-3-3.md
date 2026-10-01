description: This repo's libp2p libraries were a release behind the linked optimystic checkout, so TypeScript saw two copies of every libp2p type and refused to compile four packages. The libraries now sit on the same release line as optimystic; review the version move, the removed type casts and the corrected comments.
prereq:
architecture: docs/testing.md
files: packages/*/package.json, yarn.lock, packages/reference-app-web/src/lib/cadre-web.ts, packages/reference-app-rn/src/cadre-phone.ts, packages/reference-app-ns/src/cadre-phone.ts, packages/cadre-core/test/control-database-offline-peers.spec.ts, packages/cadre-core/src/{cadre-node,peer-dial,strand-formation-protocol,types}.ts, docs/architecture.md, .release-notes.pending.md, tickets/blocked/adopt-optimystic-address-dial-timeout.md, tickets/.pre-existing-known.md
repro: verified
----
# Move this repo's libp2p family to the 3.3 line

## Cause

`yarn workspace @serfab/cadre-core typecheck` gave 36 TS2322/TS2345 errors. Each one compared a type from `sereus/node_modules/@libp2p/interface` (3.1.0) with the same type from `optimystic/packages/db-p2p/node_modules/@libp2p/interface` (3.3.0). optimystic `4d31f936` moved to libp2p ^3.3.11. This repo links optimystic's packages, and TypeScript treats two physical copies of a package as one only when the name and version match.

The same split showed up one level down once `@libp2p/*` moved: `@multiformats/multiaddr` 12 against 13, and `datastore-core` 11 against 12. The NativeScript bundle also broke on `uint8arrays`: libp2p 3.3 imports `uint8arrays/with-array-buffer` (version 6), but the app's webpack resolves from its own top `node_modules` first, where version 5 was hoisted.

## What changed

Ranges match the floors in `../optimystic/packages/db-p2p/package.json` at `249a26b8`:

| package | was | now |
|---|---|---|
| `libp2p` | ^3.1.3 | ^3.3.11 |
| `@libp2p/interface` | ^3.1.0 | ^3.3.0 |
| `@libp2p/identify` (exact) | 4.0.10 | 4.1.14 |
| `@libp2p/webrtc` (exact) | 6.0.14 | 6.0.33 |
| `@libp2p/circuit-relay-v2` | ^4.1.3 | ^4.2.13 |
| `@libp2p/crypto` | ^5.1.13 | ^5.1.23 |
| `@libp2p/peer-id` | ^6.0.4 | ^6.0.15 |
| `@libp2p/peer-record` | ^9.0.5 | ^9.0.16 |
| `@libp2p/logger` | ^6.2.2 | ^6.2.13 |
| `@libp2p/peer-store` | ^12.0.10 | ^12.0.28 |
| `@libp2p/tcp` | ^11.0.10 | ^11.0.28 |
| `@libp2p/websockets` | ^10.1.3 | ^10.1.21 |
| `@multiformats/multiaddr` | ^12.5.1 | ^13.0.3 |
| `datastore-core` (cadre-core dev) | ^11.0.1 | ^12.0.1 |
| `uint8arrays` | ^5.1.0 | ^6.1.1 |

- **The two exact pins** existed only to stay on `@libp2p/interface` 3.1. They are re-pinned exactly to the first releases that declare ^3.3.0: identify 4.1.14 (optimystic's resolution) and webrtc 6.0.33 (npm latest).
- **Lockfile.** Deduped `@libp2p/*`, `@multiformats/*`, `interface-datastore` and `datastore-core`. Every physical `@libp2p/interface` is 3.3.0 and every `@multiformats/multiaddr` is 13.0.3 (`find node_modules packages/*/node_modules -path '*@libp2p/interface/package.json'`). `uint8arraylist` 2.4.8 is still hoisted at the root (from `@chainsafe/libp2p-noise` 17 / yamux 8, both latest, and `cadre-rn`'s test-only devDependency). Typecheck accepts it, so it was left alone.
- **Version-skew casts removed.** The `as unknown as TransportFactory` casts on `webRTC()` / `webRTCDirect()` (`reference-app-web/src/lib/cadre-web.ts`, `reference-app-rn/src/cadre-phone.ts`, `cadre-core/test/control-database-offline-peers.spec.ts`) and the `as unknown as PrivateKey` casts on the stored peer key (`cadre-web.ts`, `reference-app-ns/src/cadre-phone.ts`) are gone, with their comments and the `TransportFactory` aliases.
- **Comments.** Those that said sereus runs libp2p 3.1.3 now say 3.3: `types.ts` (ping deadline pinning), `strand-formation-protocol.ts` (formation dial), `peer-dial.ts` and `cadre-node.ts` (why addresses are dialed one at a time), and the matching paragraph in `docs/architecture.md`. In the implement pass, two comments that cite libp2p code were checked against the 3.3.11 source in `node_modules` and updated:
  - `cadre-node.ts` `resolveControlDialAddrs`: `calculateMultiaddrs` still drops addresses no transport can dial. The comment now cites 3.3.11.
  - `peer-dial.ts` `tryAddrsInTurn`: the dial queue still joins a queued job for the same peer without checking whether it has finished. The comment says the join is unchanged in 3.3.11.
  - Comments that report a measurement taken on 3.1.3 were left alone: `relay-reservation.ts:90`, `relay-reservation.spec.ts:967`, `types.ts:616`, and `docs/reference-app-rn.md:488` (a dated device run).
- **Bookkeeping.** Added a release note. Updated `blocked/adopt-optimystic-address-dial-timeout`: raising sereus's own libp2p range is done, and raising the `@optimystic/*` floors stays blocked on the optimystic release. Removed the typecheck line from `tickets/.pre-existing-known.md`.

## Verified

- `yarn typecheck` (all workspaces plus the three coverage checks) exit 0; `reference-app-web typecheck:e2e` exit 0. After the implement pass's comment edits: cadre-core typecheck and eslint on the two edited files exit 0.
- `yarn lint` and `yarn dep-check` (includes `check:dep-ranges`) exit 0.
- Unit suites on the final tree: cadre-core 2363 passed / 1 skipped plus the one-off below; quereus-plugin-sereus 156 passed.
- Bundle checks over cadre-core's browser graph, all on the final tree: `reference-app-rn test:bundle` (expo export) OK; `reference-app-ns test:bundle` OK (it failed before the uint8arrays move); `reference-app-web build` (vite) OK.
- `../optimystic` was clean at `249a26b8` for every run, and the stale-build guard accepted its dist.

## Integration run

Full `yarn workspace @serfab/integration-tests test`: 65 files passed, 1 failed, 3 skipped; 319 tests passed, 2 failed, 15 skipped (1028 s). Log: `tickets/.logs/libp2p33.integration.test.log`.

Both failures are in `control-write-degraded-cohort-member.integration.ts`: a write against a silent member takes 120–141 s to settle, past the test's 120 s limit. This change did not cause them. With HEAD's `package.json` files and `yarn.lock` restored (libp2p 3.1.3), the same two tests fail with the same settle times (log `tickets/.logs/libp2p33.degraded-at-head.log`). Triage traced the cause to optimystic `7da08dc2`'s derived transaction budget and filed it as `fix/degraded-cohort-stalled-write-outruns-120s-cap`, now `in-flight` in `tickets/.pre-existing-known.md`.

## Known gaps

- **Some suites ran before the last dependency change.** cadre-rn (44), reference-app-rn (302) and reference-app-web (67) passed before the uint8arrays 5→6 move. After it, only typecheck and the bundle checks covered those three packages; their unit suites were not re-run.
- **Integration run relinked partway.** The uint8arrays `yarn install` relinked `node_modules` during the integration run. No file failed on module loading, but the run is not a clean single-tree run of the final state.
- **One-off OS error.** `device-token-registry.spec.ts` failed once with `uv_interface_addresses returned Unknown system error 2`. That comes from Windows `os.networkInterfaces()`, inside optimystic's nested `@libp2p/tcp`. The file then passed 3 of 3 runs on its own.
- **No device run on 3.3.** No phone (React Native or NativeScript) or browser device run was made on 3.3. The runtime change covers the transports and services this repo passes to optimystic (websockets, tcp, circuit-relay, identify, webrtc) and the integration harness's own bare libp2p nodes (`dedicated-relay.ts`, two scenarios). `@optimystic/db-p2p` already built its node from its own nested libp2p 3.3.11 before this change.
- **`ops/` is still on libp2p 3.1.** `ops/docker/libp2p-infra` and `ops/test` are separate npm packages with their own `package-lock.json`, not yarn workspaces, and they still resolve libp2p 3.1. They were left out of scope: nothing there links optimystic, so no type split arises, and libp2p 3.1 and 3.3 peers use the same wire protocols.

## Tests

None added. The change is a dependency move. The type split it fixes is caught by `yarn typecheck`, and behaviour is covered by the existing unit, bundle and integration suites listed above.

## Design constraints kept

- No tsconfig `paths`, no `skipLibCheck` change, no new casts. The existing skew casts were removed instead.
- Nothing in `../optimystic` was touched.

## Review focus

- Confirm the two exact pins (identify 4.1.14, webrtc 6.0.33) should stay exact. Their old reason, holding the interface at 3.1, no longer applies. Exact pins still keep this repo's identify on the same release as optimystic's resolution.
- Spot-check the `yarn.lock` diff (about 1,200 lines) for an accidental second copy of `@libp2p/interface`, `@multiformats/multiaddr` or `uint8arrays` major versions in an app's top `node_modules`.
