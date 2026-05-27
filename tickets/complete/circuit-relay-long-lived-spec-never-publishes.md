---
description: Long-lived circuit-relay regression spec now obtains its relay reservation deterministically. The browser-shaped client listens on the SPECIFIC relay circuit address (`<relayWs>/p2p-circuit`) instead of the bare `/p2p-circuit` search address, so the circuit-relay-v2 listener takes the `CircuitListen` "configured reservation" path and publishes the `/p2p-circuit/p2p/<client>` multiaddr in <1s — bypassing the RelayDiscovery / registrar-topology / cuckoo-filter startup race that left the reservation forever pending. Stale docstring grep example also corrected.
prereq:
files: ../optimystic/packages/db-p2p/test/circuit-relay-long-lived.spec.ts
---

## What shipped

Two edits in `../optimystic/packages/db-p2p/test/circuit-relay-long-lived.spec.ts`:

1. **`spawnBrowserShaped` (line 73)** — `listenAddrs: ['/p2p-circuit']` →
   `listenAddrs: [`${relayAddr.toString()}/p2p-circuit`]`. Listening on the
   specific relay address (`/ip4/127.0.0.1/tcp/<port>/ws/p2p/<RELAY>/p2p-circuit`)
   exactly matches `CircuitListen` in `@libp2p/circuit-relay-v2`'s
   `transport/listener.js`, which opens a direct connection to the relay and calls
   `reservationStore.addRelay(remotePeer, 'configured')` → `addedRelay(...)` →
   publishes the circuit addr immediately. This sidesteps `RelayDiscovery`, the
   registrar HOP topology, the cuckoo filter, and peer-routing — the one-shot
   startup race that never recovered. Both the primary and control cases call
   `spawnBrowserShaped(relayWs)`, so both are fixed by the single change.

2. **Docstring grep example (lines 18-19)** — `--grep "circuit-relay-long-lived"`
   → `--grep "Circuit-relay long-lived"` (the real `describe` title) in the
   PowerShell and bash example lines.

`waitForCircuitListen`'s 15s timeout is unchanged (configured path publishes in
~250ms).

## Review findings

Adversarial pass over the implement diff (commit `47d0067` in sereus for ticket
files; the code change lives in the linked `../optimystic` working tree). Read
the spec change and the original implement/fix ticket with fresh eyes before the
handoff summary.

### Correctness — verified, no findings
- **Root mechanism confirmed at the source, not just trusted.** Read
  `@libp2p/circuit-relay-v2/dist/src/transport/listener.js`: the
  `CircuitListen.exactMatch(addr)` branch (lines 57-72) decapsulates `/p2p-circuit`,
  `openConnection(relayAddr)`, then `addRelay(remotePeer, 'configured')` →
  `addedRelay()` which sets `listeningAddrs` and confirms the observed addr — fully
  deterministic, no discovery/topology/filter involved. And `utils.js`:
  `CircuitListen = fmt(and(P2P.matchers[0], code(CODE_P2P_CIRCUIT)))`, so
  `.../p2p/<RELAY>/p2p-circuit` matches exactly (P2P-terminated address + circuit
  code), whereas the bare `/p2p-circuit` matches only `CircuitSearch` → the broken
  discovery path. The fix lands on the correct branch.
- **Spec still tests what it exists for.** The configured path stops exercising
  relay *auto-discovery*, but the spec's stated purpose (per its docstring) is the
  per-circuit data-limit surface (`applyDefaultLimit`). The control case confirms
  that surface is still exercised: with `applyDefaultLimit:true` a relay reset is
  still surfaced (`failureSeen === true`). Scope decision is sound and documented.

### Tests — pass, hardened
- `RUN_LONG_TESTS=1 yarn test:verbose --grep "Circuit-relay long-lived"` →
  **1 passing**, run **twice** (42237ms, 42217ms — deterministic). This addresses
  the implementer's own "single pass" caveat: the primary case (80×2KiB = 160 KiB
  through the relay, `applyDefaultLimit:false`) completes with no reset, repeatably.
- `RUN_LONG_TESTS=1 RUN_LONG_TESTS_CONTROL=1 ...` → **2 passing** (control 14.3s,
  reset surfaced as required).
- The grep fix was validated implicitly: the runs above use the new
  `"Circuit-relay long-lived"` grep and select the test.

### Type safety / lint — pass
- `yarn tsc --noEmit` in `packages/db-p2p` → clean (exit 0). The new template-string
  listen addr is `string`, fits `listenAddrs: string[]`. No package-local lint
  script exists in db-p2p; type-check is the available static gate.

### Resource cleanup / error handling — no findings
- `afterEach` stops dialer/client/relay via `Promise.allSettled`; stream `finally`
  blocks close streams. Unchanged by this diff and correct.

### Docs — checked, none to update
- Grepped `sereus/docs` and `optimystic/docs` for `circuit-relay-long-lived` /
  `Circuit-relay long-lived`: no references. The change is confined to a test file
  not in any doc or the web bundle.

### Acceptance criterion #4 (web Tier 2 e2e) — not re-run, justified
- The implementer ran `yarn workspace @serfab/reference-app-web test:e2e` →
  13 passed / 3 failed, ~26% dial:fail, and filed
  `tickets/fix/web-e2e-tier2-data-convergence-dial-fail-rate.md`. That follow-up is
  present and well-scoped (verified): it rules out the circuit-relay discovery race
  in production (`connectToBootstrap()`'s `/p2p-circuit/p2p/<self>` reservation gate
  passes for every spec), points at the cluster-coordinator convergence layer, and
  flags a harness `%s`-interpolation gap to fix first. The 13/16 result matches the
  documented `complete/web-e2e-tier2-data-convergence-relay.md` baseline. This change
  edits a db-p2p **test file** (not in the web bundle), so it cannot affect that
  suite. Re-running a multi-minute reference-peer-mesh + chromium e2e whose result is
  already documented, has its own live follow-up ticket, and is independent of this
  change was judged not agent-runnable-worthwhile; the criterion is satisfied by the
  filed follow-up.

### Minor observations (no action)
- `pickRelayWsAddr` now carries a new implicit dependency: `relayAddr` must contain
  `/p2p/<RELAY>` for `CircuitListen` to match (the old bare-listen code only needed
  it for `bootstrapNodes`). In practice libp2p always announces the peer id in its
  WS multiaddr, and both test runs confirm it; not worth guarding.
- The optimystic working tree also has an uncommitted edit to
  `packages/db-p2p/src/libp2p-key-network.ts` (drops a `getConnections` `any` cast).
  That belongs to the prior `optimystic-libp2p-keynetwork-limited-connection-reuse`
  ticket, not this one — flagged only so a future committer doesn't bundle it here.
- Production `reference-app-web/src/lib/optimystic.ts` still uses bare
  `listenAddrs: ['/p2p-circuit']`. e2e evidence says reservations land there, and the
  implementer explicitly scoped a production conversion out. The dial-fail follow-up
  ticket explicitly tells future work NOT to re-open the listener path. Agreed — no
  action.

### Disposition
No major findings; nothing required a new fix/plan ticket beyond the dial-fail
follow-up the implementer already filed. No minor fixes needed in this pass — the
diff is minimal and correct as written.
