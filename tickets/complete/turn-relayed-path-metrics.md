----
description: Detect TURN-relayed WebRTC connections and count them as "relayed" (transport "webrtc-turn") in connectivity metrics instead of silently reporting them as "direct".
files: packages/cadre-core/src/diagnostics/connection-path.ts, packages/reference-app-web/src/lib/connection-path.ts, packages/cadre-core/src/diagnostics/webrtc-turn-tracker.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/test/connection-path.spec.ts, packages/cadre-core/test/webrtc-turn-tracker.spec.ts, packages/reference-app-web/e2e/solo/connection-path-parity.spec.ts
----

## Summary

A three-layer detection path classifies a TURN-relayed `/webrtc` session as
`relayed`/`webrtc-turn` instead of `direct`/`webrtc`:

1. **Classifier** (`connection-path.ts`, both mirrored copies) — `ConnectionLike`
   gains an externally-set `turnRelayed?` hint; `classifyConnectionPath` promotes
   `webrtc` → `webrtc-turn` when `turnRelayed === true` (guarded so `webrtc-direct`
   is never promoted). `summarizeConnectionPaths` classifies via
   `classifyConnectionPath` so the hint is honoured; `webrtc-turn` is `relayed`,
   so stuck-on-relay and `bytesOverRelay` semantics carry over unchanged.
2. **`TurnRelayTracker`** (cadre-core) — wraps `globalThis.RTCPeerConnection`,
   inspects `getStats()` on settle, and queues a relay/not-relay verdict. Inert on
   Node.js (no `RTCPeerConnection`); failures default to not-relayed (no false
   positives).
3. **`CadreNode` wiring** — installs the tracker before libp2p bring-up, drains it
   on a genuine `/webrtc` `connection:open` to tag the peer, clears on
   `connection:close`, and annotates connections in `getConnectionPaths()`.

TURN is off by default, so the only production-visible change today is the new
(zero-valued, hence omitted-when-zero) `webrtc-turn` series.

## Review findings

### Scope of the review
Read the full implement diff (`20722ae`) with fresh eyes before the handoff. Cross
-checked both mirrored `connection-path.ts` copies (confirmed in sync — drift
parity holds), the `TurnRelayTracker`, the `CadreNode` wiring, all touched specs,
and the consumers of `byTransport` (cadre-cli `health.ts` JSON + Prometheus
exposition, web `Diagnostics.svelte`, web `diagnostics.svelte.ts`). Verified the
plan/implement tickets to separate delivered-vs-deferred scope. Ran lint, the two
target specs, and the full cadre-core suite; typechecked cadre-core.

### Verification results
- **Lint:** `npx eslint` clean on all touched files (incl. my edits).
- **Typecheck:** cadre-core `yarn typecheck` → exit 0.
- **Unit (target):** `connection-path.spec.ts` + `webrtc-turn-tracker.spec.ts` →
  **47 passed** (44 original + 3 added below).
- **Full suite (cadre-core):** `yarn vitest run` → **644 passed, 1 skipped** (47
  files). No regressions (was 641 before my 3 added tests).
- **Not run:** web `typecheck:e2e` / `check:svelte` — I touched no web source
  file, and the parity spec / web classifier are unchanged. The implement handoff
  reports them green.

### Findings & dispositions

**Minor — FIXED inline.** The TURN consume gate in `handleTurnConnectionOpen` used
`addr.includes('/webrtc')`, which is **also true for `/webrtc-direct`**
(`'/webrtc-direct'.includes('/webrtc')`). A `webrtc-direct` open (which can never
be TURN-promoted — the classifier guards on `transport === 'webrtc'`) would
therefore drain a queued settlement meant for a genuine `/webrtc` dial,
mis-attributing or losing a real verdict. Changed the gate to
`classifyTransport(addr).transport === 'webrtc'`, which checks `/webrtc-direct`
first (same ordering the classifier uses). The plan literally specified the
substring form, but its own edge-case section requires `webrtc-direct` never be
promoted, so the precise gate honours documented intent. (`cadre-node.ts`,
imported `classifyTransport`.)

**Minor — FIXED inline (tests).** The tracker spec covered single-entry detection
but not three real behaviours of the FIFO/observer logic. Added:
- `consume` pops most-recent-in-window first, then older (newest→oldest order).
- a flapping/duplicate `connected` event records only once (the `observed`
  `WeakSet` guard).
- `install()` is idempotent — a second install does not re-wrap the wrapper, and a
  single `dispose()` restores the original.

**Major — FILED new ticket** `backlog/web-turn-relayed-path-detection.md`. The web
reference app does not use `CadreNode`; it builds its own libp2p node and calls
`summarizeConnectionPaths(conns)` in `diagnostics.svelte.ts` with connections that
**never carry `turnRelayed`**, and it wires **no `TurnRelayTracker`**. So the web
classifier copy supports the hint but nothing sets it — `webrtc-turn` can never
appear in the browser Diagnostics, even though a NAT'd browser tab is the *primary*
place TURN relaying happens. The plan scoped Layer-3 wiring to `cadre-node.ts`
only and updated the web classifier copy for **parity alone**, so this is
out-of-scope new work rather than a defect in delivered code — hence a backlog
ticket, not an inline fix.

**Latent observation — documented, not changed.** `getConnectionPaths()` rebuilds
each connection into a fresh `ConnectionLike` literal (to inject `turnRelayed`),
enumerating only `remotePeer/remoteAddr/direction/timeline`. This **drops any
`metrics` field**, which `readConnectionBytes`/`bytesOverRelay` would read. Impact
is **zero in practice**: the stock libp2p `Connection` carries no byte counter (the
field is documented best-effort/always-null, and only synthetic tests attach
`metrics`), so production behaviour is identical to before. Not fixed because the
only faithful fixes either widen the shared `ConnectionLike` contract or rely on
spread semantics of an external class — churn unjustified for a path that is dead
in production. Flagged here so a future metrics implementation knows to re-thread
it.

**Observation — documented, not changed.** `TurnRelayTracker.install()` mutates
the process-global `RTCPeerConnection`. Two `CadreNode` instances in one process
would stack wrappers, and out-of-order `dispose()` could leave a dangling wrapper.
No functional impact while TURN is off (the wrapper is a passive observer), and
production runs one node per process; unit tests restore the global per-test.
Worth knowing if multi-node-in-process (e.g. integration harnesses) ever exercises
WebRTC.

**Handoff-listed gaps — reviewed and accepted as documented.** Settlement↔open
timing correlation (best-effort under concurrent dials), the startup-race window
before the `connection:open` listener attaches, and the unconditional per-peer
flag clear on `connection:close` are all acceptable given TURN-off-by-default and
match the ticket spec. The **largest unverified surface remains the absence of a
live TURN-relayed e2e** — detection has only been exercised against a fake
`RTCPeerConnection`, never a real browser `getStats()` report against an actual
coturn/relay. Verifying that needs a coturn harness and is out of scope for an
inline review pass; it should be covered if/when TURN ships enabled.

### Docs
Checked `docs/architecture.md` and `docs/STATUS.md`: neither enumerates the
connectivity-metric transport series, so no doc lists `webrtc-turn` to update. The
`byTransport` consumers (cadre-cli `health.ts` JSON + Prometheus text, web
`Diagnostics.svelte`) all iterate the map dynamically, so the new transport flows
through with no hardcoded-label changes required — confirmed by reading each.
