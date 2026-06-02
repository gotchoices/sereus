---
description: Review the cross-package integration test that spawns the real cadre-cli authority node from cadre-host's HostProcessOrchestrator and drives it end-to-end through AuthorityNodeClient — closing the 6.7 "real wire" coverage gap. Also unskips the now-unblocked CadrePeer remove-cycle test and exports the authority-delegation surface from cadre-host's package root.
files: packages/integration-tests/src/scenarios/cadre-host-authority-node.integration.ts, packages/cadre-host/src/index.ts, packages/cadre-host/src/auth/__tests__/trust-circle-integration.test.ts
---

## What landed

### New cross-package integration scenario

`packages/integration-tests/src/scenarios/cadre-host-authority-node.integration.ts` — spawns the
**real** `@serfab/cadre-cli` authority node through
`HostProcessOrchestrator.ensureAuthorityNode(...)` (no `spawn.entrypoint` override → the orchestrator
resolves `@serfab/cadre-cli/bin/cadre.js`), waits for readiness, then drives `AuthorityNodeClient`
over the genuine loopback admin channel. This is the first test that exercises cadre-host's
orchestrator + a real cadre-cli child + the real admin contract together; existing suites stop short:
`orchestrator-authority.test.ts` spawns a fake CLI binding the admin port, and
`host-authority.smoke.test.ts` points the client at a stub admin HTTP server.

The node is spawned **once** in `beforeAll` (real libp2p + optimystic control-DB startup is slow), and
the happy-path `it`s run against it in file order. libp2p binds an **ephemeral** port (`libp2pPort: 0`)
so there's no cross-suite TCP collision; health/metrics/admin come from a dedicated `19600–19899`
range. No full-network dial is performed — the node is the founding authority of its own party,
matching the ticket's "tier-appropriate, no full-network dial" guidance.

What it asserts:
- **Identity** — `getPeerId()` returns the real libp2p peer id derived from the host `identity.key`
  (computed independently via `peerIdFromPrivateKey`, asserted equal; `12D3Koo…` prefix).
- **Multiaddrs** — `getMultiaddrs()` returns ≥1 real, parseable `/…/tcp/…` listen address.
- **Invites** — `createInvite()` → `{ invite, encodedInvite }`; `invite.partyId` matches the party,
  and `encodedInvite` base64url-decodes back to the invite (token round-trips).
- **Membership (empty)** — `listMembers()` is `[]` and `isMember(<fresh peerId>)` is `false` on a
  fresh party.
- **Full add → remove cycle** — `createInvite(token)` → `acceptPhone({phonePeerId, token}, invite)` →
  `isMember`/`listMembers` reflect the peer → `removePeer` → membership empty again. This is the cycle
  the `quereus-cadrepeer-delete-no-row-context` fix unblocked (real `CadrePeer` DELETE-with-context
  across the process boundary).
- **Push-model invite addresses** — `pushInviteAddresses([...])` is reflected verbatim in the
  `authorityAddrs` of the next minted invite.
- **Bad bearer** — a client with a wrong token → `AuthorityNodeUnavailableError` with
  `nodeCode === 'not_authorized'`.
- **Not-ready / unavailable window** (separate describe, no node) — endpoint-undefined (pre-spawn) and
  connection-refused (the spawn→admin-bind window) both surface `AuthorityNodeUnavailableError`
  rather than hanging.

### Supporting changes

- `packages/cadre-host/src/index.ts` — exported the authority-delegation surface from the package
  **root** so `@serfab/cadre-host` consumers (here, integration-tests, which imports the built `dist`)
  can reach it: `AuthorityNodeClient`, `AuthorityNodeUnavailableError`, `AuthorityNodeClientOptions`,
  `AUTHORITY_CONTAINER_ID`, and the `AuthorityAdminEndpoint` / `AuthoritySpawnConfig` / `NodePorts`
  types. These previously existed only in the `authority/` and `orchestrator/` sub-indexes, which the
  package's `exports` map does not expose (only `.` is published).
- `packages/cadre-host/src/auth/__tests__/trust-circle-integration.test.ts` — unskipped the
  `removes a member from CadrePeer` test. It was `it.skip`'d pending
  `quereus-cadrepeer-delete-no-row-context`, which has since landed (`tickets/complete/`). The
  in-process issue → redeem → remove cycle now passes.

## How to validate

```
# New cross-package scenario (spawns a real cadre-cli child):
yarn workspace @serfab/integration-tests exec vitest run \
  src/scenarios/cadre-host-authority-node.integration.ts --reporter=verbose

# Type safety of the integration-tests package (vitest's transform does NOT typecheck):
yarn workspace @serfab/integration-tests exec tsc -p tsconfig.build.json --noEmit

# Full cadre-host suite (includes the unskipped remove-cycle test + the index change):
yarn workspace @serfab/cadre-host test
```

Prerequisite: `@serfab/cadre-cli` and `@serfab/cadre-host` must be **built** before running the
scenario — the orchestrator spawns cadre-cli's `dist/bin/cadre.js`, and integration-tests imports
cadre-host's `dist`. Rebuild after editing either:
`yarn workspace @serfab/cadre-cli build && yarn workspace @serfab/cadre-host build:server`.

### Results this pass

| Command | Result |
| --- | --- |
| new scenario (`cadre-host-authority-node.integration.ts`) | 9 passed (≈8s wall) |
| `integration-tests` typecheck (`tsc -p tsconfig.build.json --noEmit`) | clean (exit 0) |
| `yarn workspace @serfab/cadre-host test` | 44 files, 348 passed, 3 skipped (0 failing) |
| `yarn workspace @serfab/cadre-cli build` / `cadre-host build:server` | clean (exit 0) |

The 3 remaining cadre-host skips are platform-specific (`secrets.test.ts` keytar,
`identity.test.ts` POSIX chmod, `orchestrator.test.ts`) and unrelated to this work. The remove-cycle
test that *was* skipped now runs and passes.

## Known gaps / reviewer attention

- **Full integration-tests suite not run as a whole.** Validated the new scenario in isolation
  (9/9) plus a package-wide typecheck; the broader `integration-tests` suite (real-network scenarios
  — `convergence-stress`, `multi-party-sync`, etc.) was **not** run end-to-end here because those are
  slow and environment-dependent (left to CI). The new file is collected per-file by vitest and uses
  only its own temp orchestrator + the shared `waitUntil` harness helper, so it can't perturb other
  scenarios — but a reviewer wanting full confidence should run the whole suite once.
- **Real `not_ready` (503) classification is unreachable here, by construction.** cadre-cli binds the
  admin channel only *after* `node.start()` + authority genesis + seed-bootstrap init, so there is no
  real "admin up but node not ready" window. The test covers the two reachable unavailable states
  (endpoint-undefined and connection-refused). The AdminServer's `not_ready` mapping itself is covered
  by cadre-cli's `admin-server.spec.ts` against a mock node. If the reviewer wants the real
  `not_ready` exercised, it would need a deliberately-crippled child (out of scope here).
- **Public API surface growth.** Exposing the delegation client + ids from the package root is the
  minimal way to let an external consumer drive the contract; confirm that's the intended surface (vs.
  adding a `./authority` subpath export). Nothing else consumes the new root exports yet.
- **Port allocation is range-sequential, not OS-probed.** Health/metrics/admin are handed out from
  `19600–19899` without a bind-probe (cadre-host's `PortAllocator` behaviour). A host with that exact
  range occupied would fail the spawn rather than skip to a free port. This mirrors the existing
  `orchestrator-authority.test.ts` fixed-range approach and is acceptable for v1; flagged in case CI
  reserves that band.
- **Shared-node ordering coupling.** The happy-path `it`s share one node and rely on file order
  (`members-empty` must precede the add/remove cycle; the cycle cleans up after itself). Trading the
  ordering coupling for per-test isolation would mean repeated slow spawns.
- **`STARTUP_MS = 90_000`.** Generous on purpose for cold CI; the node came up near-instantly on the
  dev box (per-test durations were single-digit ms). If CI ever flakes on readiness, the `beforeAll`
  surfaces the child `node.log` tail in the thrown error to aid diagnosis.

## Why (for context)

Surfaced by the 6.7 review (`cadre-host-authority-node-delegation`) as the explicit "cross-package
integration test would close the loop" gap: nothing previously verified cadre-host's orchestrator
spawning a genuine cadre-cli authority child + `AuthorityNodeClient` round-tripping the real admin
contract (envelope shapes, bearer auth, error codes, identity/multiaddrs once libp2p is up).
