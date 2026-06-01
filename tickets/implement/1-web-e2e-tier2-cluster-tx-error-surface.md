---
description: The cluster-tx stream-reset failures in the Tier-2 e2e sweep are unfixable as-shipped because the true error is hidden three times over — the service handler aborts the stream on any `cluster.update` throw (opaque `StreamResetError` to the coordinator), the `ClusterClient` legacy-protocol fallback buries it under a misleading `ERR_PROTOCOL_SELECTION_FAILED`, and the spawned service peers emit no debug logs. Make the real server-side error visible by propagating it as a structured response, delete the dead legacy fallback, and pipe service-peer logs in the e2e fixture. This is the observability+cleanup half of `web-e2e-tier2-cluster-tx-stream-reset`; the underlying consensus throw is fixed in the follow-up `web-e2e-tier2-cluster-tx-stream-reset-rootcause`.
files: ../optimystic/packages/db-p2p/src/cluster/service.ts, ../optimystic/packages/db-p2p/src/cluster/client.ts, ../optimystic/packages/db-p2p/src/protocol-client.ts, packages/reference-app-web/e2e/fixtures/reference-peer.ts
---

## Background

Under the sequential Tier-2 e2e full-sweep, three multi-tab specs
(`cross-tab-activity`, `disconnect-mid-session`, `two-tab-convergence`) fail
with `StreamResetError` on a cluster update, followed by noisy
`Protocol selection failed - could not negotiate /db-p2p/cluster/1.0.0`.
The same specs pass in isolation. See the parent fix ticket for the full
reproduction recipe.

### What the symptom actually is

Code tracing established the real topology and masking chain:

  - **The browser tab is the cluster coordinator.** `createLibp2pNode`
    (`libp2p-node-base.ts:355-365`) builds a `coordinatorRepo` +
    `createClusterClient` on *every* node, browser included. The
    `cluster-tx:*` and `dial:fail` lines in the e2e capture carry the
    `[browser …]` prefix and originate from the `optimystic:db-p2p:cluster`
    namespace — only the browser enables `optimystic:*` debug
    (`_helpers.ts` `maybeEnableBrowserDebug`). So the browser dials the
    three service-peer cluster members **directly over ws** (they are in
    the bootstrap list) and runs the 2-phase commit itself. These cluster
    streams are **not circuit-relayed.**

  - **The service handler turns any application throw into an opaque
    reset.** `ClusterService.handleIncomingStream`
    (`cluster/service.ts:138-154`) runs `this.cluster.update(record)`
    (→ `ClusterMember.processUpdate`) inside a `try/catch` whose catch does
    `stream.abort(err)`. On the wire that is a yamux RST, which the
    coordinator's `ProtocolClient` surfaces as a bare `StreamResetError`
    with **no message** — the real reason (`validateRecord` /
    `mergeRecords` / signature / consensus throw) is logged *only* on the
    service peer under the libp2p `db-p2p:cluster` namespace.

  - **The service peers log nothing.** `reference-peer.ts` `spawnSingleNode`
    launches the CLI with `env: { ...process.env, FORCE_COLOR: '0' }` —
    no `DEBUG` — and stops forwarding child stdout/stderr to the parent
    console once startup scanning resolves. So the service-side
    `this.log.error('error handling cluster protocol message …')` never
    reaches the e2e capture.

  - **The legacy fallback is dead code that adds noise.**
    `ClusterClient.update` (`cluster/client.ts:15-51`) computes
    `preferred = (protocolPrefix ?? '/db-p2p') + '/cluster/1.0.0'`. Every
    node sets `protocolPrefix = /optimystic/<networkName>`
    (`libp2p-node-base.ts:322`), so `preferred` is always
    `/optimystic/<network>/cluster/1.0.0` and the
    `clusterService` registers exactly that (`libp2p-node-base.ts:238-251`).
    The hard-coded fallback `/db-p2p/cluster/1.0.0` is **never registered by
    any node** (grep: only docs/README mention the bare string). So on the
    reset it always fails with `ERR_PROTOCOL_SELECTION_FAILED`, then
    rethrows the *original* opaque reset — pure noise plus a wasted dial.

### Why hypothesis #1 (relay caps) is ruled out here

The relay reservation-lifetime wiring is intact: `cli.ts:369-371` passes
`relayServerInit: { reservations: { applyDefaultLimit: false } }` whenever
`effectiveRelay` is true, and `effectiveRelay` is true for the e2e service
peers (they pass `--ws-port`, so `wsPortConfigured` ⇒ inbound listen ⇒ relay
on; `cli.ts:215-222`). More fundamentally, the failing cluster-tx streams are
browser-coordinator → service-member **direct ws** dials, not relayed
circuits, so the per-circuit 128 KiB/2 min cap cannot be the cause. The
relay-only contribution would be if a browser-tab peer-id leaked *into* a
cluster's `peers` set — but the parent ticket explicitly rules that out (the
dial target in the capture is a service peer, and that inclusion bug was
fixed by `web-e2e-tier2-exclude-relay-only-peers-from-clusters`).

## Goal

Make the genuine server-side cluster error observable end-to-end and remove
the misleading secondary noise, so the follow-up root-cause ticket can fix
the actual `ClusterMember.update` throw against a real error message instead
of an opaque reset. No consensus-logic changes here.

## Design

**Structured error propagation (primary).** Instead of aborting the stream
on a handler exception, the cluster service should serialize an error
envelope as its response and close the stream normally. The coordinator's
`ClusterClient.update` detects the envelope and throws a real `Error`
carrying the server's message (and a stable `code`/`name` so the
coordinator's promise/commit accounting and reputation hooks can still
classify it). This surfaces the true cause in the *existing* browser capture
(`optimystic:*` is already enabled), with no dependency on service-peer
debug. Choose an envelope shape that cannot collide with a valid
`ClusterRecord` (a record never has a top-level `error`/`__clusterError`
field) and keep the wire format JSON, consistent with the existing
length-prefixed `it-pipe` framing in `protocol-client.ts` and `service.ts`.

Keep the service-side `this.log.error(...)` for local diagnostics, but the
abort path should be reserved for genuinely unrecoverable framing/transport
faults — not application-level `update` rejections.

**Remove the legacy fallback.** Delete the `/db-p2p/cluster/1.0.0` second
attempt in `ClusterClient.update`; let the single prefixed dial's error
propagate. This satisfies the parent ticket's acceptance item ("either the
legacy fallback is removed … or it is justified") — it is removed, justified
by: the bare protocol is never registered, the prefix is always set, and the
fallback only ever produced misleading `ERR_PROTOCOL_SELECTION_FAILED` noise
before rethrowing the original error. Preserve the redirect-hop logic
(`client.ts:36-49`) unchanged.

**E2e diagnostics (secondary).** In `reference-peer.ts`, when
`OPTIMYSTIC_E2E_DEBUG=1`, pass `DEBUG` through to the spawned CLI children
(optimystic + libp2p namespaces) and forward their stdout/stderr to the
parent console with a `[svc-<port>]` prefix even after startup resolves, so
the service-side view is available when the structured response is
insufficient. This is belt-and-suspenders; the structured response is the
load-bearing change.

## Acceptance for this ticket

  - A cluster member that throws inside `update` causes the coordinator's
    `ClusterClient.update` to reject with the **server's actual error
    message**, not a bare `StreamResetError`.
  - The `/db-p2p/cluster/1.0.0` fallback no longer appears in the code or in
    the e2e capture; no `ERR_PROTOCOL_SELECTION_FAILED` from cluster updates.
  - With `OPTIMYSTIC_E2E_DEBUG=1`, the spawned service peers' logs reach the
    Playwright stdout.
  - `@optimystic/db-p2p` builds and its existing cluster tests
    (`test/cluster-coordinator*.spec.ts`, plus any cluster-service /
    protocol-client coverage) pass — adjust them for the new error path
    rather than reverting it.
  - Note: this ticket does **not** by itself make the sweep green
    (16/16) — that is the follow-up's acceptance. It is expected that after
    this lands, the three specs still fail, but now with a *meaningful*
    error in the capture.

## TODO

### Phase 1 — structured error response (db-p2p)
- [ ] In `cluster/service.ts`, wrap the per-message `cluster.update` call so
      an application throw yields a JSON error envelope (e.g.
      `{ error: { message, name, code } }`) as the stream response and the
      stream closes normally; reserve `stream.abort(...)` for
      decode/framing faults outside the `update` call.
- [ ] In `cluster/client.ts` `ClusterClient.update`, after
      `processMessage`, detect the error envelope and `throw` a real `Error`
      (carry `name`/`code` so `ClusterCoordinator` reputation/penalty
      classification in `repo/cluster-coordinator.ts` still works). Ensure a
      normal `ClusterRecord` response is never misclassified as an error.
- [ ] Confirm `protocol-client.ts` framing tolerates the envelope (it
      returns the first decoded JSON object as-is — no change expected, but
      verify the `first(...)` "No response received" path is untouched).

### Phase 2 — remove dead fallback (db-p2p)
- [ ] Delete the `/db-p2p/cluster/1.0.0` fallback branch in
      `cluster/client.ts` (lines ~22-35); keep the redirect-hop handling.
- [ ] Grep the repo to confirm nothing registers or depends on the bare
      `/db-p2p/cluster/1.0.0` protocol; update `docs/architecture.md:152`,
      `docs/cluster.md`, and `README.md` references to the current prefixed
      protocol id while here.

### Phase 3 — e2e diagnostics (sereus)
- [ ] In `packages/reference-app-web/e2e/fixtures/reference-peer.ts`, when
      `process.env.OPTIMYSTIC_E2E_DEBUG === '1'`, add
      `DEBUG=optimystic:*,db-p2p:*,libp2p:circuit*,libp2p:dial*` (or the
      minimal set that captures `db-p2p:cluster`) to the child `env`, and
      forward child stdout/stderr to `console.log` with a `[svc-<port>]`
      prefix for the lifetime of the child (not only during startup scan).

### Phase 4 — validate
- [ ] `yarn workspace @optimystic/db-p2p build && yarn workspace @optimystic/db-p2p test 2>&1 | tee /tmp/db-p2p-test.log`
      (stream output; do not silently redirect).
- [ ] `yarn workspace @optimystic/reference-peer build` so the e2e fixture
      picks up the new dist.
- [ ] Type-check the sereus web e2e change
      (`yarn workspace @serfab/reference-app-web typecheck` or equivalent).
