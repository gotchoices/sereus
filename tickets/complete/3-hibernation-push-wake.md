description: Control-network push-wake protocol (WAKE_PROTOCOL) — receiver service, sender API, membership gate, length-prefixed framing — the third of the architecture's three wake paths
files: packages/cadre-core/src/strand-wake-protocol.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/strand-wake-protocol.spec.ts, packages/cadre-core/test/cadre-node.spec.ts, packages/cadre-core/test/wake-stream-helpers.ts, docs/architecture.md, docs/STATUS.md, tickets/backlog/3-mobile-background-service.md
----

## Summary

Implements **push-wake**, the third of the architecture's three wake paths
(after local wake and check-in wake). A same-cadre peer — typically an always-on
server participating in a strand that sees new activity — signals a hibernating
cadre peer over the **control network** (the only network a hibernating peer
keeps connected) to bring a strand online.

- **`strand-wake-protocol.ts`** — `WAKE_PROTOCOL = /sereus/strand-wake/1.0.0`,
  modeled on `seed-bootstrap.ts`: 4-byte big-endian length-prefixed JSON frames,
  one request → one ack per stream, the same `LibP2PStream` shim, and reuse of
  the exported `decodeLengthPrefixedFrame` guard.
  - `StrandWakeService` (receiver): registers the `node.handle(WAKE_PROTOCOL, …)`
    handler; `processWakeRequest` is the decision core — non-member →
    reject-before-lookup, unknown/unparticipated strand → reject,
    hibernating/idle → route through the injected `wake` callback then accept,
    already-live → no-op accept.
  - `dialWake(node, addrs, request, opts?)` (sender): tries each address in order
    (signaling/relay first) with a per-dial timeout, half-closes the write end,
    reads the ack — the libp2p 3.x pattern from `deliverSeed`.
- **`CadreNode`**: `start()` registers `StrandWakeService` on the control node
  (`isMember`, `strandManager.getInstance`, `wakeStrand` injected); `cleanup()`
  unhandles it. New sender API `pushWake(targetPeerId, strandId, reason?)`
  resolves the target's signed control-network multiaddrs via `resolvePeerAddrs`
  (freshness + trust gated, signaling-first) then `dialWake`.
- **Types**: `WakeRequest { strandId; reason? }`, `WakeAck { accepted; status?;
  reason? }`. **Exports**: `StrandWakeService`, `dialWake`, `WAKE_PROTOCOL`,
  `StrandWakeServiceOptions`, `DialWakeOptions` (message types ride
  `export * from './types.js'`).

**Authorization (v1):** control-network membership IS the authorization — the
control network already admits only this party's schema-gated `CadrePeer` nodes,
and a wake is low-risk (it only makes the receiver spend resources coming online
for a strand it already participates in). No per-request signature beyond
`isMember(remotePeerId)`.

Docs updated: `docs/architecture.md` Wake Mechanisms #3 (planned → implemented)
and the `/sereus/*` protocol note; `docs/STATUS.md` push-wake item checked;
`tickets/backlog/3-mobile-background-service.md` carries the dependency block
delimiting transport (landed here) from trigger-policy + mobile-delivery.

## Review findings

**Method.** Read the implement diff (commit `21237b0`) with fresh eyes before
the handoff, then read the full `strand-wake-protocol.ts`, the `seed-bootstrap.ts`
it is modeled on (framing, half-close, decode guard), the `CadreNode` wiring
(`start`/`cleanup`/`pushWake`/`resolvePeerAddrs`/`isMember`/`wakeStrand`), the
`StrandStatus`/`StrandInstance` types, and traced the wake mutation path
(`handleStrandWake → resumeStrand`) to verify the ack's status field. Scrutinized
for SPP/DRY/modularity, error handling, resource cleanup, type safety, framing
correctness, and authorization. Ran lint + typecheck + build + the full test
suite.

**Validation (all green):**
- `yarn workspace @serfab/cadre-core test` → **276 passed** (20 files; was 275,
  +1 from the review's added coverage below).
- `yarn workspace @serfab/cadre-core typecheck` → clean.
- `eslint` on all changed files → 0 errors (2 pre-existing `any` **warnings** at
  `cadre-node.ts:86,219` — the `eventHandlers` map pattern, unrelated to this
  ticket; confirmed by lint output, just shifted one line by the new field).

**Correctness — verified, no defects found.**
- Traced the most load-bearing claim: `processWakeRequest` returns
  `{ accepted: true, status: instance.status }` after an awaited `wake()`, with a
  comment that the wake "mutates the shared instance." Confirmed sound:
  `handleStrandWake` and `StrandInstanceManager.resumeStrand` both mutate the
  *same* `StrandInstance` object that `getInstance(strandId)` returns (not a
  replacement), and `buildStrandRuntime` sets `status = 'active'` on it — so the
  re-read reports the true post-wake status.
- Framing round-trip is robust to chunk boundaries: `readFrame` accumulates all
  chunks to EOF before decoding, so split/coalesced `send(prefix)`/`send(body)`
  writes decode identically. Half-close ordering (sender writes → half-closes →
  receiver reads to EOF → acks → closes → sender reads ack to EOF) terminates on
  both sides; matches the seed pattern.
- Membership is checked **before** any strand lookup (reject-before-lookup), as
  specified. `pushWake` correctly omits `signalingOnly` so `resolvePeerAddrs`
  returns relay-first-then-direct, matching `dialWake`'s per-address fallthrough.
- Public API surface verified: `index.ts` re-exports the service/fn/protocol-id
  and `export * from './types.js'` exposes `WakeRequest`/`WakeAck` (no duplicate
  export conflict).
- Docs verified against code, not taken on faith: architecture #3 and STATUS
  reflect the landed reality; the backlog dependency block correctly delimits
  what landed (transport) from what `3-mobile-background-service` still owns
  (trigger policy + FCM/APNs mobile delivery, which a libp2p dial cannot reach a
  suspended phone for).

**Minor — fixed in this pass.**
- Test coverage gap: the existing "oversized/malformed" test only exercised the
  `decodeLengthPrefixedFrame` length-prefix guard (a *declared* oversize). The
  distinct `readFrame` per-chunk **accumulation cap** (`total > MAX_WAKE_SIZE`,
  64KB, streamed across many real chunks) was untested. Added
  `replies accepted:false when streamed bytes exceed the 64KB cap` to
  `strand-wake-protocol.spec.ts` (276 total, +1). Passes.

**Minor — noted, not changed (deliberate v1 contracts).**
- `processWakeRequest` returns `accepted: true` for *any* known non-hibernating/
  idle strand, including `stopped`/`error` (reported as an "already online" ack).
  Judgment call beyond the ticket's hibernating/idle→wake, unknown→reject spec;
  acceptable for v1, callable contract is documented in the method's JSDoc.
- `WAKE_PROTOCOL` lives in the service module (mirroring `SEED_PROTOCOL` in
  `seed-bootstrap.ts`) rather than `types.ts`; `MAX_WAKE_SIZE` is 64KB vs the seed
  protocol's 1MB (wake frames are tiny). Both deliberate and consistent.
- A thrown `wake()` (e.g. `resumeStrand` failure) yields `accepted: false` with
  the error text in `reason`, so "rejected" vs "wake failed" is distinguishable by
  reason. Reasonable for v1.

**Major — filed as new backlog tickets (out of scope to fix inline).**
- `push-wake-two-node-integration-test` — every test here uses in-memory stream
  doubles and a mocked `dialProtocol`/`resolvePeerAddrs`; the real wire path
  (`node.handle` dispatch, real `dialProtocol`, half-close over a relayed
  connection, `pushWake → resolvePeerAddrs` composition) is not exercised
  end-to-end. `seed-bootstrap.spec.ts` has live round-trips; push-wake should get
  a two-node `integration-tests` scenario (NAT'd receiver via relay).
- `control-protocol-stream-read-timeouts` — both `StrandWakeService.handleStream`
  and the seed handler read to EOF with no session/step timeout (unlike
  `FormationListener`), so a member that opens a stream and never half-closes
  hangs that read; no per-protocol concurrency cap either. Membership-gated and
  low-risk (own-cadre exposure only), so deferred — but worth hardening across
  both protocols using the `FormationListener` pattern. Ticket also notes the
  sender-side `withTimeout` does not abort the in-flight dial on timeout (a small
  stream leak) to fix while there.

**Wake-vs-check-in race (carried-forward invariant, not new code).** The "resume
coalescing prevents a push racing a concurrent check-in" claim rests on
`HibernationManager.beginWake` coalescing overlapping wakes and `resumeStrand`
being idempotent (it returns early when the strand is already live). Confirmed
both still hold at HEAD: `beginWake` shares one in-flight promise per strand, and
`resumeStrand` short-circuits on `instance.libp2pNode || instance.database`.
`handleStrandCheckIn` calls `resumeStrand` directly (not via `beginWake`), so a
push firing mid-check-in is serialized only by that idempotency — which holds. No
new coalescing was needed.
