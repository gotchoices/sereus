---
description: Review the observability+cleanup half of the Tier-2 cluster-tx stream-reset work. The cluster service now returns a structured JSON error envelope (closing the stream normally) instead of aborting on an application throw; ClusterClient rethrows the server's real error with name/code preserved; the dead `/db-p2p/cluster/1.0.0` legacy-protocol fallback is removed; and the e2e fixture forwards spawned service-peer logs to Playwright under OPTIMYSTIC_E2E_DEBUG=1. No consensus-logic changes. The follow-up `web-e2e-tier2-cluster-tx-stream-reset-rootcause` fixes the actual throw.
files: ../optimystic/packages/db-p2p/src/cluster/cluster-error.ts, ../optimystic/packages/db-p2p/src/cluster/service.ts, ../optimystic/packages/db-p2p/src/cluster/client.ts, ../optimystic/packages/db-p2p/test/cluster-error-propagation.spec.ts, ../optimystic/packages/db-p2p/src/protocol-client.ts, packages/reference-app-web/e2e/fixtures/reference-peer.ts, ../optimystic/docs/architecture.md, ../optimystic/packages/db-p2p/README.md, ../optimystic/packages/db-p2p/docs/cluster.md, ../optimystic/packages/db-p2p/docs/repo.md
---

## What this ticket did

Made the genuine server-side cluster error observable end-to-end and removed
the misleading secondary noise, so the follow-up root-cause ticket can fix the
real `ClusterMember.update` throw against a meaningful message instead of an
opaque `StreamResetError`. The masking chain (service aborts → coordinator sees
bare reset → `ERR_PROTOCOL_SELECTION_FAILED` fallback noise → service peers
silent) is broken in three places.

### Changes (db-p2p — `../optimystic`)

- **New `src/cluster/cluster-error.ts`** — the wire contract for a structured
  error response, shared by service and client:
  - `CLUSTER_ERROR_KEY = '__clusterError'` (top-level marker; a `ClusterRecord`
    never has this field, and the redirect payload uses `redirect`, so the three
    response shapes are mutually unambiguous).
  - `toClusterErrorEnvelope(err)` → `{ __clusterError: { message, name, code? } }`
    (`code` only when the source error carries a non-empty string `.code`).
  - `isClusterErrorEnvelope(value)` type guard.
  - `clusterErrorFromEnvelope(env)` → reconstructs a real `Error`, preserving
    `name` and `code`.

- **`src/cluster/service.ts`** — extracted `processOperation(message)`; the
  per-message loop now wraps it in `try/catch`. An application throw (validation
  / signature / merge / consensus) is logged (`this.log.error` kept) and yielded
  as a JSON envelope, then the stream **closes normally**. `stream.abort(...)`
  is now reserved for the outer framing/transport faults (decode error, send
  failure) — not application-level `update` rejections.

- **`src/cluster/client.ts` `ClusterClient.update`** — single network-prefixed
  dial; the `/db-p2p/cluster/1.0.0` second attempt is **deleted** (the bare
  protocol is never registered by any node, so it only ever produced
  `ERR_PROTOCOL_SELECTION_FAILED` before rethrowing the original error). After
  `processMessage`, an error envelope is detected **before** the redirect check
  and rethrown via `clusterErrorFromEnvelope`. Redirect-hop logic is unchanged
  (only re-typed off `any` to satisfy the no-`any` house rule).

- **`src/protocol-client.ts`** — unchanged. Verified the envelope rides the
  existing length-prefixed `it-pipe` framing and that `first(...)`'s
  "No response received" path is untouched (envelope is a single decoded object,
  same as the success path).

- **Docs** — `docs/architecture.md` (table row + mermaid), `db-p2p/README.md`
  (mermaid + service comment + integration example), `db-p2p/docs/cluster.md`
  (×4), `db-p2p/docs/repo.md` updated from the bare `/db-p2p/cluster/1.0.0` to
  the network-prefixed `/optimystic/<network>/cluster/1.0.0` form.

### Changes (sereus — `packages/reference-app-web/e2e/fixtures/reference-peer.ts`)

- When `OPTIMYSTIC_E2E_DEBUG=1`: inject
  `DEBUG=optimystic:*,db-p2p:*,libp2p:circuit*,libp2p:dial*` into the spawned CLI
  children (respecting an explicit parent `DEBUG` if already set), and forward
  child stdout/stderr to the parent console with a `[svc-<port>]` prefix for the
  **full lifetime** of the child. The startup buffer/scan listeners are now named
  and detached individually on `cleanup()` (was `removeAllListeners`), so the
  debug forwarders survive past startup resolution.

## How to validate

From `../optimystic` (sibling repo, linked into sereus via root `resolutions`):

```
yarn workspace @optimystic/db-p2p build
yarn workspace @optimystic/db-p2p test            # 493 passing, 8 pending, 0 failing
yarn workspace @optimystic/reference-peer build   # e2e fixture spawns this CLI
```

From `packages/reference-app-web` (sereus):

```
yarn tsc --noEmit -p tsconfig.e2e.json            # e2e fixtures (NOT covered by default `typecheck`)
yarn typecheck                                    # app src
```

All of the above were run green during implement. The new spec
`test/cluster-error-propagation.spec.ts` (8 tests) covers: envelope round-trip
(message/name/code), `code` omission, non-`Error` coercion, the guard rejecting
records / redirects / null / strings; the **service** producing an envelope and
closing (not aborting) on a throwing `update`, and returning the record on
success; the **client** rethrowing the server error and passing a normal record
through. Existing `cluster-service-redirect` and `cluster-coordinator*` specs
still pass unmodified (they drive `checkRedirect` directly and mock
`ClusterClient`, so neither the abort→envelope change nor the fallback removal
touches them).

### Use cases / scenarios worth probing

- **Primary acceptance:** a member whose `update` throws → coordinator's
  `ClusterClient.update` rejects with the server's *actual* message (not a bare
  `StreamResetError`). Covered by the service+client specs in-memory.
- **No fallback noise:** grep confirms the only remaining `/db-p2p/cluster/1.0.0`
  string in code is the explanatory comment in `client.ts`; no
  `ERR_PROTOCOL_SELECTION_FAILED` can originate from a cluster update anymore.
- **E2e visibility:** with `OPTIMYSTIC_E2E_DEBUG=1`, `[svc-<port>]`-prefixed
  libp2p/optimystic lines (including the service-side `db-p2p:cluster` update
  error) should appear in the Playwright stdout for the child's whole lifetime.

## Honest gaps — please scrutinize

- **Not exercised over a real libp2p transport.** The envelope path is tested
  with in-memory length-prefixed stream stubs, not a real yamux stream/socket.
  The framing is identical to the existing success path (single `send` +
  `close`, consumed by `first(...)`), so I expect it to hold — but a gated
  `*.integration.spec.ts` confirming the envelope survives the actual transport
  would close the loop. Not added here.
- **E2e forwarding verified by typecheck + reasoning only.** The multi-tab sweep
  is not agent-runnable within the idle limit (it's the follow-up's domain), so
  `OPTIMYSTIC_E2E_DEBUG=1` was not run end-to-end under Playwright. A reviewer
  spot-check: run one of `cross-tab-activity` / `disconnect-mid-session` /
  `two-tab-convergence` with that env var and confirm `[svc-9192]`/`[svc-9193]`
  lines and the real cluster error reach stdout.
- **`code` rarely populates today.** Consensus throws in `ClusterMember` are
  plain `Error` (no `.code`), so the coordinator's reputation classification
  (`collectPromises`/`commitTransaction` `.catch` → `PenaltyReason.ConsensusTimeout`)
  sees `name`/`message` only. This is no worse than before (the reset produced a
  generic error too) and is now strictly more informative — but confirm there's
  no penalty-path regression. The follow-up may want to attach stable `code`s to
  the real throws so classification can branch on them.
- **Unknown-operation now returns an envelope instead of aborting.** I judged it
  application-level; the only caller ever sends `operation:'update'`. If the
  reviewer prefers a genuine protocol violation to remain an abort (or map to
  `PenaltyReason.ProtocolViolation`), that's a one-line decision in
  `processOperation`/the catch.
- **Sibling abort sites untouched.** `repo/service.ts`, `dispute/service.ts`,
  `sync/service.ts` still `stream.abort` on handler throws — out of scope; only
  the cluster path was masking the consensus throw under test. Flagging in case
  the reviewer wants the same envelope treatment generalized later.

## Expected post-landing state

This ticket does **not** by itself make the Tier-2 sweep green (16/16). The
three multi-tab specs are expected to still fail after this lands — but now with
a *meaningful* server-side error in the capture instead of an opaque reset plus
`ERR_PROTOCOL_SELECTION_FAILED`. Turning the sweep green is the acceptance of the
follow-up `web-e2e-tier2-cluster-tx-stream-reset-rootcause`.
