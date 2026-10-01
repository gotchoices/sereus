description: This repo's libp2p libraries were a release behind the linked optimystic checkout, so TypeScript saw two copies of every libp2p type and refused to compile four packages. The libraries have been moved to the same release line as optimystic and every gate has been run; what remains is a last pass over the result and the handoff to review.
prereq:
architecture: docs/testing.md
files: packages/*/package.json, yarn.lock, packages/reference-app-web/src/lib/cadre-web.ts, packages/reference-app-rn/src/cadre-phone.ts, packages/reference-app-ns/src/cadre-phone.ts, packages/cadre-core/test/control-database-offline-peers.spec.ts, packages/cadre-core/src/{cadre-node,peer-dial,strand-formation-protocol,types}.ts, docs/architecture.md, .release-notes.pending.md, tickets/blocked/adopt-optimystic-address-dial-timeout.md, tickets/.pre-existing-known.md
repro: verified
----
# Move this repo's libp2p family to the 3.3 line

## Cause (reproduced)

`yarn workspace @serfab/cadre-core typecheck` gave 36 TS2322/TS2345 errors at HEAD, each comparing a type from `sereus/node_modules/@libp2p/interface` (3.1.0) with the same type from `optimystic/packages/db-p2p/node_modules/@libp2p/interface` (3.3.0). optimystic `4d31f936` moved to libp2p ^3.3.11; this repo links its packages, and TypeScript only merges two physical copies of a package when name and version match.

Moving only `@libp2p/*` was not enough. The first typecheck after that showed the same split one level down:

- `@multiformats/multiaddr` 12 (this repo) against 13 (libp2p 3.3 and optimystic) — `Multiaddr`, `DialTarget`, `AddrDialer` errors across cadre-core.
- `datastore-core` 11 against 12 (`@libp2p/peer-store` 12.0.28) — `MemoryDatastore` in `peer-addr-book.spec.ts`.

And the NativeScript bundle check broke on `uint8arrays`: libp2p 3.3's packages import `uint8arrays/with-array-buffer` (uint8arrays 6), but the app's webpack config resolves from the app's own top `node_modules` first, where uint8arrays 5 was hoisted because this repo's packages declared ^5.1.0.

## What was done (fix stage did the dependency move; it is all in the working tree)

Ranges now match the floors in `../optimystic/packages/db-p2p/package.json` at its HEAD (`249a26b8`):

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

- **The two exact pins.** Both existed only to stay on `@libp2p/interface` 3.1 (`complete/6-strand-transport-identity` for identify, `3-web-webrtc-transport-to-bypass-relay` for webrtc: newer releases required a newer interface). They are re-pinned exactly to the releases that declare `@libp2p/interface` ^3.3.0: identify 4.1.14 (optimystic's resolution) and webrtc 6.0.33 (npm latest).
- **Lockfile.** `yarn dedupe '@libp2p/*'`, `'@multiformats/*'`, `interface-datastore`, `datastore-core` after install. Every physical `@libp2p/interface` is now 3.3.0 and every `@multiformats/multiaddr` 13.0.3 (`find node_modules packages/*/node_modules -path '*@libp2p/interface/package.json'`). `uint8arraylist` 2.4.8 is still hoisted at the root (from `@chainsafe/libp2p-noise` 17 / yamux 8, the latest releases, and `cadre-rn`'s test-only devDep); typecheck accepts it, so it was left.
- **Version-skew casts removed.** With one copy of each type, the `as unknown as TransportFactory` casts on `webRTC()` / `webRTCDirect()` (`reference-app-web/src/lib/cadre-web.ts`, `reference-app-rn/src/cadre-phone.ts`, `cadre-core/test/control-database-offline-peers.spec.ts`) and the `as unknown as PrivateKey` casts on the stored peer key (`cadre-web.ts`, `reference-app-ns/src/cadre-phone.ts`) are gone, along with their comments and the `TransportFactory` aliases. All five packages typecheck without them.
- **Comments that said sereus runs libp2p 3.1.3** were corrected: `types.ts` (ping deadline pinning), `strand-formation-protocol.ts` (formation dial NOTE), `peer-dial.ts` and `cadre-node.ts` (why addresses are dialed one at a time; 3.3 adds a per-address `addressDialTimeout`, but optimystic sizes it for a cold relayed open, so the design reason still holds), and the same paragraph in `docs/architecture.md`. Comments that report a measurement taken on 3.1.3 were left as measurements.
- Release note added; `blocked/adopt-optimystic-address-dial-timeout` updated (the "raise sereus's own libp2p range" half is done; raising `@optimystic/*` floors stays blocked on the optimystic release); the typecheck line removed from `tickets/.pre-existing-known.md`.

## Verified

- `yarn typecheck` (all workspaces + the three coverage checks) exit 0; `reference-app-web typecheck:e2e` exit 0.
- `yarn lint`, `yarn dep-check` (includes `check:dep-ranges`) exit 0.
- On the final tree: cadre-core 2363 passed / 1 skipped plus the one-off below; quereus-plugin-sereus 156 passed. Before the uint8arrays 5→6 move: cadre-core 2364 passed, cadre-rn 44, reference-app-rn 302, reference-app-web 67 passed.
- Bundle checks over cadre-core's browser graph: `reference-app-rn test:bundle` (expo export) OK on the final tree; `reference-app-ns test:bundle` OK on the final tree (it failed before the uint8arrays move); `reference-app-web build` (vite) OK on the final tree.
- Integration suite: see "Integration run" below.

## Integration run

Full `yarn workspace @serfab/integration-tests test`: 65 files passed, 1 failed, 3 skipped; 319 tests passed, 2 failed, 15 skipped (1028 s). Log: `tickets/.logs/libp2p33.integration.test.log`. A `yarn install` (the uint8arrays change) relinked `node_modules` partway through that run; no file failed on module loading.

Both failures are in `control-write-degraded-cohort-member.integration.ts` ("fails with a named super-majority error when a member stalls past the response deadline", "a control read answers locally while a write is stalled"): a write against a silent member settles after 120–141 s, past the test's 120 s cap. **Not caused by this change:** with HEAD's `package.json` files and `yarn.lock` restored and reinstalled (libp2p 3.1.3), the file fails the same two tests with the same settle times (141147 / 133164 / 120461 ms; log `tickets/.logs/libp2p33.degraded-at-head.log`). The likely cause is optimystic `7da08dc2`'s derived transaction budget (44 round trips, about 154 s at sereus's declared 3.5 s). Written up in `tickets/.pre-existing-error.md` for triage; it is the "derived transaction timeout still fits" check in `blocked/adopt-optimystic-address-dial-timeout`.

One cadre-core rerun on the final tree failed `device-token-registry.spec.ts` once with `uv_interface_addresses returned Unknown system error 2` (Windows `os.networkInterfaces()`, inside optimystic's nested `@libp2p/tcp`); the file then passed 3 of 3 alone. Treated as a one-off OS error.

## Design constraints kept

- No tsconfig `paths`, no `skipLibCheck` change, no new casts; the existing skew casts were removed instead.
- Nothing in `../optimystic` was touched. The stale-build guard accepted optimystic's dist throughout (its tree was clean at `249a26b8`).
- Runtime note: `@optimystic/db-p2p` already built its libp2p node from its own nested libp2p 3.3.11 before this change. What changed at runtime here is the transports and services this repo passes in (websockets, tcp, circuit-relay, identify, webrtc, noise/yamux unchanged) and the integration harness's own bare libp2p nodes (`dedicated-relay.ts`, two scenarios).

## TODO

The dependency move, typecheck, lint, dep gates, suites and bundle checks are done (above). Remaining:

- [ ] Read the diff once more for anything the fix pass missed: other comments or docs that state sereus runs libp2p 3.1 (`grep -rn "3\.1\.3" packages/*/src docs`; measurements taken on 3.1.3 stay as they are).
- [ ] Hand off to review with this ticket's "Verified" and "Integration run" sections. Do not chase the degraded-cohort failure here; it is pre-existing and handed to triage.
