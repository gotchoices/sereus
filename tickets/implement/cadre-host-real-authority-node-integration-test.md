---
description: Add a cross-package integration test that spawns the *real* cadre-cli authority node (`cadre-cli start --authority --admin-port …`) from cadre-host's HostProcessOrchestrator and drives it end-to-end through AuthorityNodeClient — closing the loop the 6.7 delegation work left open (current cadre-host tests use a fake CLI binding the admin port, or a stub admin HTTP server).
files: packages/cadre-host/src/__tests__/orchestrator-authority.test.ts, packages/cadre-host/src/authority/authority-node-client.ts, packages/cadre-cli, integration-tests
---

## Why

The 6.7 realignment makes cadre-host spawn the admin's authority node and delegate
authority/membership/identity ops to it over the loopback admin channel via `AuthorityNodeClient`.
Coverage today stops short of the real wire:

- `orchestrator-authority.test.ts` spawns a **fake** CLI (`fake-authority.mjs`) that only writes its
  startup token and binds a minimal `/admin/identity` endpoint.
- `host-authority.smoke.test.ts` points `AuthorityNodeClient` at a **stub** admin HTTP server.
- The real `--authority` / `--admin-port` / `--identity-protobuf` path is exercised only by
  cadre-cli's own 6.6 tests.

Nothing verifies the *integration*: cadre-host's orchestrator spawning a genuine `cadre-cli`
authority child + `AuthorityNodeClient` round-tripping the real admin contract (envelope shapes,
bearer auth, error codes, identity/multiaddrs once libp2p is up).

## Scope / expectations

- A test (in `integration-tests`, or a cadre-host integration suite) that:
  - spawns the real authority node via `HostProcessOrchestrator.ensureAuthorityNode(...)` using the
    resolved `@serfab/cadre-cli` bin (not a fake entrypoint),
  - waits for readiness, then drives `AuthorityNodeClient` end-to-end: `getPeerId` / `getMultiaddrs`
    return real libp2p values; `createInvite` → `encodedInvite`; `listMembers` / `isMember`;
    `pushInviteAddresses` is accepted and reflected in subsequently minted invites,
  - asserts the unhappy paths: bad bearer → not_authorized; not-ready window behaves sanely.
- Keep it tier-appropriate (real libp2p startup is slow) — generous timeouts, no full-network dial.
- Coordinate with the `quereus-cadrepeer-delete-no-row-context` fix before asserting the remove
  cycle end-to-end (that path is currently `it.skip`'d in `trust-circle-integration.test.ts`).

Surfaced by the 6.7 review (`cadre-host-authority-node-delegation`) as the explicit
"cross-package integration test would close the loop" gap.
