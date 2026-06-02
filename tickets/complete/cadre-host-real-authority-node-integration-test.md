---
description: Cross-package integration test that spawns the real cadre-cli authority node from cadre-host's HostProcessOrchestrator and drives it end-to-end through AuthorityNodeClient — closing the 6.7 "real wire" coverage gap. Also unskips the now-unblocked CadrePeer remove-cycle test and exports the authority-delegation surface from cadre-host's package root. Reviewed + completed.
files: packages/integration-tests/src/scenarios/cadre-host-authority-node.integration.ts, packages/cadre-host/src/index.ts, packages/cadre-host/src/auth/__tests__/trust-circle-integration.test.ts, docs/cadre-host.md
---

## What landed

### New cross-package integration scenario

`packages/integration-tests/src/scenarios/cadre-host-authority-node.integration.ts` — spawns the
**real** `@serfab/cadre-cli` authority node through `HostProcessOrchestrator.ensureAuthorityNode(...)`
(no `spawn.entrypoint` override → the orchestrator resolves `@serfab/cadre-cli/bin/cadre.js` via
`createRequire`), waits for readiness, then drives `AuthorityNodeClient` over the genuine loopback
admin channel. First test that exercises cadre-host's orchestrator + a real cadre-cli child + the real
admin contract together (prior suites stop short: `orchestrator-authority.test.ts` spawns a fake CLI,
`host-authority.smoke.test.ts` points the client at a stub admin server).

Node spawned **once** in `beforeAll` (real libp2p + optimystic control-DB startup is slow); happy-path
`it`s run against it in file order. libp2p binds an **ephemeral** port (`libp2pPort: 0`
→ `CADRE_LISTEN_ADDRS=/ip4/0.0.0.0/tcp/0`); health/metrics/admin come from a dedicated `19600–19899`
range. No full-network dial — the node is the founding authority of its own party.

Asserts: identity (peer id derived independently from the host `identity.key`, asserted equal),
multiaddrs (≥1 parseable `/…/tcp/…`), invite mint + base64url round-trip, empty membership on a fresh
party, the full add→remove cycle (the cycle `quereus-cadrepeer-delete-no-row-context` unblocked),
push-model invite addresses, bad-bearer → `not_authorized`, and the two reachable unavailable states
(endpoint-undefined and connection-refused) surfacing `AuthorityNodeUnavailableError` rather than
hanging.

### Supporting changes

- `packages/cadre-host/src/index.ts` — exported the authority-delegation surface from the package
  **root**: `AuthorityNodeClient`, `AuthorityNodeUnavailableError`, `AuthorityNodeClientOptions`,
  `AUTHORITY_CONTAINER_ID`, and the `AuthorityAdminEndpoint` / `AuthoritySpawnConfig` / `NodePorts`
  types (previously only in the `authority/` and `orchestrator/` sub-indexes, which the `exports` map
  does not publish — only `.`).
- `packages/cadre-host/src/auth/__tests__/trust-circle-integration.test.ts` — unskipped the
  `removes a member from CadrePeer` test (its blocker `quereus-cadrepeer-delete-no-row-context` has
  landed in `tickets/complete/`).

## Review findings

Adversarial review of the implement-stage diff (`f6ddca2`) read first, before the handoff summary.
Every orchestrator/client method and type the new test consumes was verified against source
(`ensureAuthorityNode`, `getAuthorityAdminEndpoint`, `stopAuthorityNode`, `removeContainer`,
`listNodes`, `getLogs`, `init`; `AuthoritySpawnConfig`/`ManagedNodeInfo`/`AuthorityAdminEndpoint`/
`NodePorts` shapes; the `AuthorityNodeClient` `EndpointSource` ctor + every delegated route). The
readiness harness (`waitUntil`) was confirmed to swallow transport errors so the admin-bind window is
retried, not fatal. cadre-cli's admin routes and error codes (`not_authorized` / `not_ready`) match
the contract the client and test exercise. Dependency resolution checked: `@serfab/cadre-cli` is a
declared dep of cadre-host and resolved relative to it; integration-tests declares cadre-host + the
libp2p deps the test imports. vitest config includes `*.integration.ts`, and the `beforeAll` per-hook
timeout (100s) correctly overrides the config's 30s `hookTimeout`.

**Correctness / SPP / DRY / resource cleanup / error handling / type safety** — clean. `afterAll`
stops the node, removes containers, and rms the temp root with retries (Windows-friendly). No `any`,
no swallowed exceptions beyond best-effort cleanup, no type laxity.

**Minor — fixed inline this pass:**
- *Redundant round-trip in the bad-bearer test.* It called `getPeerId()` twice (once for
  `.rejects.toBeInstanceOf`, once in a try/catch to read `nodeCode`). Collapsed to a single call that
  asserts both the error type and `nodeCode` — one fewer HTTP round-trip, same coverage.
- *Stale docs.* `docs/cadre-host.md` still described the signed `CadrePeer` delete as "blocked
  upstream" / "the one remaining gap" (lines 281, 327). This change unskips the remove-cycle test and
  adds end-to-end coverage proving the delete works, so both passages were rewritten to reflect the
  landed fix and the new scenario. No other doc (`architecture.md`, `STATUS.md`, `api.md`) carried the
  stale claim.

**Considered, no action (acceptable design tradeoffs, all flagged by the implementer):**
- Shared-node ordering coupling among the happy-path `it`s (trades isolation for one slow spawn).
- Range-sequential port allocation (`19600–19899`, no OS bind-probe) — mirrors
  `orchestrator-authority.test.ts`; acceptable for v1.
- Real `not_ready` (503) is unreachable by construction (admin binds only after node readiness); the
  two reachable unavailable states are covered, and `not_ready` mapping is covered by cadre-cli's
  `admin-server.spec.ts` against a mock node.
- Public-API surface growth (root exports vs. a `./authority` subpath) — root export is consistent
  with how `HostProcessOrchestrator` etc. are already published; reasonable.

**Major findings:** none. No new fix/plan/backlog tickets filed.

**Lint:** neither `@serfab/cadre-host` nor `@serfab/integration-tests` defines a `lint` script (root
`lint` only fans out to packages that have one), so typecheck is the operative static check — clean.

### Validation (this pass)

| Command | Result |
| --- | --- |
| `@serfab/cadre-cli build` + `@serfab/cadre-host build:server` | clean (exit 0) |
| new scenario (`cadre-host-authority-node.integration.ts`), pre- and post-edit | 9/9 passed (~5.6s) |
| `integration-tests` typecheck (`tsc -p tsconfig.build.json --noEmit`) | clean (exit 0) |
| `yarn workspace @serfab/cadre-host test` | 44 files, 348 passed, 3 skipped (the unskipped remove-cycle test now runs + passes) |

The 3 remaining cadre-host skips are platform-specific (keytar, POSIX chmod, orchestrator) and
unrelated to this work. The broader real-network integration-tests suite (convergence-stress,
multi-party-sync, etc.) was not run end-to-end here — slow and environment-dependent, left to CI; the
new file is collected per-file and uses only its own temp orchestrator + the shared `waitUntil`
helper, so it can't perturb other scenarios.

## Why (for context)

Surfaced by the 6.7 review (`cadre-host-authority-node-delegation`) as the explicit "cross-package
integration test would close the loop" gap: nothing previously verified cadre-host's orchestrator
spawning a genuine cadre-cli authority child + `AuthorityNodeClient` round-tripping the real admin
contract (envelope shapes, bearer auth, error codes, identity/multiaddrs once libp2p is up).
