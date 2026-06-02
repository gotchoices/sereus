---
description: Tier-2 cluster-tx error-surfacing observability+cleanup. The cluster service returns a structured JSON error envelope (closing the stream normally) instead of aborting on an application throw; ClusterClient rethrows the server's real error with name/code preserved; the dead `/db-p2p/cluster/1.0.0` legacy-protocol fallback is removed; and the e2e fixture forwards spawned service-peer logs to Playwright under OPTIMYSTIC_E2E_DEBUG=1. No consensus-logic changes. Follow-up `web-e2e-tier2-cluster-tx-stream-reset-rootcause` fixes the actual throw.
files: ../optimystic/packages/db-p2p/src/cluster/cluster-error.ts, ../optimystic/packages/db-p2p/src/cluster/service.ts, ../optimystic/packages/db-p2p/src/cluster/client.ts, ../optimystic/packages/db-p2p/test/cluster-error-propagation.spec.ts, ../optimystic/packages/db-p2p/src/protocol-client.ts, packages/reference-app-web/e2e/fixtures/reference-peer.ts, ../optimystic/docs/architecture.md, ../optimystic/packages/db-p2p/readme.md, ../optimystic/packages/db-p2p/docs/cluster.md, ../optimystic/packages/db-p2p/docs/repo.md
---

## Summary of landed work

Made the genuine server-side cluster error observable end-to-end and removed the
misleading secondary noise (bare `StreamResetError` + `ERR_PROTOCOL_SELECTION_FAILED`),
so the follow-up root-cause ticket can fix the real `ClusterMember.update` throw against
a meaningful message. The masking chain was broken in three places:

- **New `optimystic/packages/db-p2p/src/cluster/cluster-error.ts`** — wire contract for a
  structured error envelope (`CLUSTER_ERROR_KEY = '__clusterError'`,
  `toClusterErrorEnvelope` / `isClusterErrorEnvelope` / `clusterErrorFromEnvelope`).
- **`cluster/service.ts`** — extracted `processOperation`; the per-message loop wraps it in
  `try/catch`, logs the throw, and yields a JSON envelope while the stream **closes normally**.
  `stream.abort` is reserved for framing/transport faults (decode/send/close).
- **`cluster/client.ts`** — single network-prefixed dial; the legacy `/db-p2p/cluster/1.0.0`
  second attempt deleted; an envelope is detected **before** the redirect check and rethrown via
  `clusterErrorFromEnvelope`. Redirect-hop logic re-typed off `any`, otherwise unchanged.
- **`cluster-error-propagation.spec.ts`** — 8 tests (helper round-trip, service envelope+close,
  client rethrow, success passthrough).
- **Docs** — protocol-prefix rename `/db-p2p/cluster/1.0.0` → `/{prefix}/cluster/1.0.0` across
  architecture.md / readme.md / cluster.md / repo.md.
- **`packages/reference-app-web/e2e/fixtures/reference-peer.ts` (sereus)** — under
  `OPTIMYSTIC_E2E_DEBUG=1`, inject `DEBUG` into spawned CLI children and forward their
  stdout/stderr to the Playwright console with a `[svc-<port>]` prefix for the child's full
  lifetime. Startup buffer/scan listeners are now named and detached individually on cleanup
  (was `removeAllListeners`) so the debug forwarders survive past startup.

This ticket does **not** by itself turn the Tier-2 sweep green — the three multi-tab specs
still fail, but now with a meaningful server-side error in the capture. Acceptance of green is
the follow-up `web-e2e-tier2-cluster-tx-stream-reset-rootcause` (in `tickets/implement/`).

## Review findings

### Validation run (all green)
- `@optimystic/db-p2p` **build** (`tsc`) — exit 0.
- `@optimystic/db-p2p` **test** — **496 passing / 8 pending / 0 failing** (handoff claimed 493;
  delta is +3 from an unrelated in-flight optimystic ticket's `storage-repo.spec.ts`, not this
  work). The new `cluster-error-propagation.spec.ts` (the +8 over the pre-feature 485 baseline)
  ran and passed.
- sereus `reference-app-web`: **`tsc --noEmit -p tsconfig.e2e.json`** (e2e fixtures) — exit 0;
  **`yarn typecheck`** (app src) — exit 0.
- No standalone ESLint in either package; `tsc` is the type gate and passes. The house no-`any`
  rule is satisfied in the touched code (the redirect-hop logic was de-`any`'d; remaining `any`
  in `recordCoordinatorForRecordIfSupported` and `getPeerAddrs` is pre-existing and untouched).

### Correctness — verified, no bugs found
- **Legacy-fallback removal is safe.** Confirmed `libp2p-node-base.ts` both *registers* the
  cluster service (`:252`) and *dials* the client (`:367-368`) under the same
  `/optimystic/${networkName}` prefix, derived from one `networkName`. The bare
  `/db-p2p/cluster/1.0.0` is therefore never registered by any node, so the deleted second-dial
  fallback was dead code that only ever produced `ERR_PROTOCOL_SELECTION_FAILED`. Grep confirms
  the only remaining `/db-p2p/cluster/1.0.0` string in source is the explanatory comment, and
  zero `ERR_PROTOCOL_SELECTION_FAILED` references remain.
- **Envelope/redirect/record are mutually unambiguous.** `isClusterErrorEnvelope` keys on
  `__clusterError`; a `ClusterRecord` never carries it and the redirect payload is keyed under
  `redirect`. The client checks the envelope **before** the redirect branch. Tests assert the
  guard rejects records, redirects, `null`, and strings.
- **Abort path correctly narrowed.** `JSON.parse`/`lpDecode` failures still escape the generator
  to the outer `try/catch` → `stream.abort` (genuine transport faults); only application throws
  inside `processOperation` become envelopes. Matches the documented intent.
- **protocol-client.ts genuinely untouched** — the envelope rides the existing length-prefixed
  framing as a single decoded object consumed by `first(...)`, identical to the success path.
- **reference-peer.ts e2e change is clean.** The named-listener refactor is actually a latent-bug
  fix: the old `removeAllListeners('data')` would have stripped any forwarders. Non-debug path is
  behavior-identical (pure additive plumbing of `debugPrefix`). At most 2 `data` listeners per
  stream (well under Node's default 10). No resource leak: forwarders persist intentionally and
  die with the child process. Browser-side debug is separately handled in
  `e2e/distributed/_helpers.ts` under the same env var — complementary, not conflicting.

### Findings filed / deferred (no major tickets needed)
- **[minor — folded into existing optimystic ticket] Docs don't describe the new wire contract.**
  `optimystic/packages/db-p2p/docs/cluster.md` "Error Handling → Error Conditions" (~line 585)
  documents *which* errors are thrown but not that they now serialize into a `__clusterError`
  envelope and close the stream normally (vs the old `stream.abort`). The handoff's "cluster.md
  ×4" edits were the protocol-prefix rename only. Because this doc lives in the **optimystic**
  repo — whose cluster-error code is already committed (swept into `ba4a0df`) and whose proper
  landing is owned by the existing `tickets/backlog/land-orphaned-cluster-error-envelope.md` —
  editing it from this sereus ticket would strand an uncommitted optimystic change and recreate
  the very orphaning problem. I appended an explicit doc-the-wire-contract requirement (and a
  current-status note) to that backlog ticket instead.
- **[minor/observation] `clusterErrorFromEnvelope` reconstructs a base `Error`.** `name`/`code`/
  `message` survive, but the original prototype/class does not — any coordinator
  `err instanceof SomeError` check would not match. Strictly more informative than the prior
  `StreamResetError`, and the reputation path keys on message/name, so no regression; flagging for
  the root-cause follow-up if it wants typed branching.
- **[observation, already flagged by implementer] `code` rarely populates today.** Consensus
  throws are plain `Error` (no `.code`); classification (`PenaltyReason.ConsensusTimeout`) sees
  name/message only — no worse than before, now strictly more informative.
- **[observation] Unknown-operation now returns an envelope instead of aborting.** Judged
  application-level; the only caller ever sends `operation:'update'`. A one-line decision in
  `processOperation`/the catch if a reviewer later prefers a protocol-violation abort.
- **[out of scope] Sibling abort sites untouched.** `repo/service.ts`, `dispute/service.ts`,
  `sync/service.ts` still `stream.abort` on handler throws, and `repo/client.ts` still carries the
  dual-dial fallback. Only the cluster path was masking the consensus throw under test; generalizing
  the envelope treatment is a separate, larger effort.
- **[trivial, debug-only] Partial-line forwarding.** A debug line split across two `data` chunks
  forwards as two prefixed partial lines. Cosmetic only (debug output), not worth the buffering
  complexity.

### Provenance note
The optimystic-side code landed under the mislabeled commit `ba4a0df`
(`ticket(review): enable-dcutr-autonat-in-libp2p-node-base`) rather than under this ticket. The
sereus implement commit `1f8ab51` carried only `reference-peer.ts`. Re-attributing/splitting the
optimystic commit is the live action item on `land-orphaned-cluster-error-envelope` — out of this
sereus repo's commit scope, so noted rather than acted on here.

## Honest residual gaps (carried from implement, still open)
- Envelope path is **not exercised over a real libp2p transport** — tested with in-memory
  length-prefixed stubs. A gated `*.integration.spec.ts` would close the loop; not added (and not
  agent-runnable within the idle limit).
- **E2e forwarding verified by typecheck + reasoning only.** A reviewer spot-check remains valuable:
  run one of `cross-tab-activity` / `disconnect-mid-session` / `two-tab-convergence` with
  `OPTIMYSTIC_E2E_DEBUG=1` and confirm `[svc-9192]`/`[svc-9193]` lines and the real cluster error
  reach Playwright stdout.
