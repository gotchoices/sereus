description: Review — `cadre enroll register` is now an honest offline authority-signature verification (no fake "registered" success) and `cadre status` reports live runtime from the running node's health `/status` endpoint instead of hardcoded `running:false`. Shared `peerAuthorizationDigest`/`verifyPeerAuthorization` helper added to cadre-core and wired into `SeedBootstrapService`.
files: packages/cadre-core/src/peer-authorization.ts, packages/cadre-core/src/seed-bootstrap.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/peer-authorization.spec.ts, packages/cadre-cli/src/commands/enroll.ts, packages/cadre-cli/src/commands/status.ts, packages/cadre-cli/src/commands/status-query.ts, packages/cadre-cli/test/status.spec.ts, packages/cadre-cli/package.json, docs/architecture.md

# What changed

Two CLI commands that previously *claimed* to do network operations while only
validating input shapes were made honest. The unifying invariant: **emitted
messages and the command description must match what the command actually did.**

## Phase 1 — shared peer-authorization helper (cadre-core)

`packages/cadre-core/src/peer-authorization.ts` (new) exports:

- `peerAuthorizationDigest(peerId): string` — the canonical
  `digest(peerId, 'sha256', 'utf8', 'base64url')` an authority signs over to
  authorize a peer. Factored out of `SeedBootstrapService` so the producer
  (authority signing) and the new verifier can never drift.
- `verifyPeerAuthorization(peerId, authorityPublicKey, signature): boolean` —
  the mirror verify (ed25519, base64url×3). **Never throws**: malformed
  base64url / garbage key / empty input → `false` (logged at debug).

`SeedBootstrapService` (`seed-bootstrap.ts`) now signs over
`peerAuthorizationDigest(peerId)` in both `insertCadrePeerRow` (the
`authorizePeer` path) and `removePeer` — **byte-identical** to the previous
inline `digest(...)`. Both re-exported from `index.ts`.

## Phase 2 — `cadre enroll register` is now offline verification

`enroll.ts` `register` action: dropped the "Registering with control
network…" line and the unused `EnrollmentService` instantiation. Description
rewritten to "Verify an authority-signed peer authorization (offline check —
does not contact the control network or register the peer)". It now:
- parses `--peer-id` via `peerIdFromString` (invalid → `✗ Invalid peer ID`, exit 1);
- requires ≥1 `--bootstrap` (kept per spec — **advisory metadata**, echoed back,
  not registered) and non-empty key/sig;
- calls `verifyPeerAuthorization`:
  - valid → `✓ Authority signature is valid for this peer ID` + explicit "did
    NOT register / membership is granted by the running authority node
    (`cadre start --authority`)" (exit 0);
  - invalid → `✗ Authority signature does not match this peer ID (peer is NOT
    authorized)` (exit 1).

`@libp2p/peer-id` moved from devDependencies → **dependencies** in
`cadre-cli/package.json` (it is now imported by runtime command code).

## Phase 3 — `cadre status` queries the live node

New testable seam `status-query.ts`:
- `queryRuntime(fetchImpl, url, timeoutMs)` → discriminated
  `{ reachable:true, status } | { reachable:false, reason }`. Never throws;
  ECONNREFUSED / non-2xx / unparseable body / timeout all map to
  `reachable:false`. The fetch is raced against an AbortController timeout so a
  hung connection still resolves.
- `buildStatusReport(config|null, runtime)` → `{ config, runtime }` JSON object.
  The unreachable branch deliberately carries **no `running` field**.
- `formatStatusReport(report)` → human text labelling **Configuration** vs
  **Runtime (live)**.

`status.ts` rewritten: new options `--health-host` (default `localhost`),
`--health-port` (default `8080`, env `CADRE_HEALTH_PORT`, mirrors `start.ts`),
`--timeout` (default `2000`ms). Missing config is **non-fatal** (warns on
stderr, skips the static section, still runs the live query). `--json` emits
`{ config, runtime:{ reachable, url, … } }`. **Exit code 3** when no node is
reachable (0 when reachable) so scripts/healthchecks can branch.

# How to validate / use cases

Run from repo root:

- `cd packages/cadre-core && yarn build && yarn test` → **288 passed**
- `cd packages/cadre-cli && yarn build && yarn test` → **50 passed**
- `yarn typecheck` in both packages → clean.

Manual CLI smoke (all confirmed during implement):

```
# enroll register — VALID authority signature
cadre enroll register -p <peerId> -b /ip4/1.2.3.4/tcp/4001 -a <authPubB64> -s <validSigB64>
  → "✓ Authority signature is valid…" + "did NOT register" guidance, exit 0
# TAMPERED / wrong signature
  → "✗ Authority signature does not match this peer ID (peer is NOT authorized)", exit 1
# unparseable peer ID
cadre enroll register -p short …  → "✗ Invalid peer ID …", exit 1

# status — no node running
cadre status --health-port 8089 --timeout 800
  → "Runtime: no running node reachable at http://localhost:8089/status", exit 3
  → (NOT "running: false")
cadre status … --json  → { "config": …|null, "runtime": { "reachable": false, … } }, exit 3
```

To exercise the **reachable** path live: `cadre start` a node (default health
port 8080), then `cadre status` in another shell — expect a "Runtime (live)"
section with `running: true`, live peerId, multiaddrs, and strand counts.

### Key behaviors a reviewer should confirm
- `enroll register` valid path NEVER implies the local peer is registered.
- `status` unreachable path NEVER prints a bare `running:false` (JSON has no
  `running` key; human output has no `Running:` line). Covered by
  `test/status.spec.ts`.
- `verifyPeerAuthorization` accepts a signature produced by `authorizePeer`'s
  exact path (digest-drift regression in `peer-authorization.spec.ts`), and the
  unchanged `seed-bootstrap.spec.ts` authorize/round-trip suite still passes.

# Tests added
- `packages/cadre-core/test/peer-authorization.spec.ts` — 10 tests: digest
  canonicality, round-trip, wrong peer/key/tamper → false, malformed/garbage/empty
  → false (no throw), and the inline-construction regression.
- `packages/cadre-cli/test/status.spec.ts` — 10 tests: `queryRuntime`
  reachable / ECONNREFUSED / non-2xx / timeout; `buildStatusReport` live-field
  surfacing + no-bare-`running:false`; `formatStatusReport` labelling.

# Known gaps / honest flags for the reviewer (treat tests as a floor)

- **No unit test drives `status.ts`'s action wiring** (option parse → env
  resolution → exit-code → config-load branch). Only the pure seam
  (`status-query.ts`) and `loadConfigSummary`'s siblings are unit-tested; the
  action's glue was verified only by the manual smoke run above. A
  process-spawning CLI test (à la commander) was deliberately skipped because of
  `process.exit`. Consider whether that glue deserves coverage.
- **`enroll register` keeps `--bootstrap` as a `requiredOption`** per the
  ticket, even though it's now purely advisory for an offline check. It's
  echoed back labelled "advisory; not registered" but a reviewer may judge that
  requiring it for a signature-only check is surprising. `--config` is likewise
  accepted and echoed but unused. Easy to relax to optional if desired.
- **Exit code `3` for "node unreachable"** is a chosen convention (documented in
  `architecture.md` and the command help). Confirm it doesn't collide with any
  container/systemd healthcheck expectation.
- **`@libp2p/peer-id` dep-type move** (dev → runtime) was made in package.json
  but `yarn install` was not re-run (the package was already hoisted in
  node_modules, so build/test pass). CI may want a lockfile sync pass to be safe.
- **`verifyPeerAuthorization`'s try/catch is partly defensive**: the underlying
  crypto `verify` already returns `false` on bad input and `digest` over a utf8
  string won't throw, so the catch is belt-and-suspenders to satisfy the
  "must not throw" contract. Not a bug — just noting it isn't load-bearing today.
- **`status` surfaces strand counts + identity but not `connectionPaths`** from
  the health envelope (not required by the ticket). Trivial to add if wanted.
- **Pre-existing lint warnings** in `seed-bootstrap.ts` (unused type imports
  `PeerId`/`Multiaddr`/`SignedTransaction` at lines 4/6/25) are untouched by this
  diff and remain as warnings (backlogged category). `yarn eslint` on the changed
  files reports **0 errors**.

# Not done (out of scope, by design)
- Neither command grew a real network-registration path — registration is
  authority-driven (`SeedBootstrapService.authorizePeer` via
  `cadre start --authority`; see `authority-self-registration-cadrepeer`).
- `status` reads the unauthenticated health `/status` endpoint, not the
  loopback admin channel (bearer-gated). The admin channel remains a possible
  later enhancement.
