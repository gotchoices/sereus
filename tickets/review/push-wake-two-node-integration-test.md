description: Review the new real-libp2p push-wake integration scenario (direct dial, NAT-via-relay delivery, non-member rejection) AND the `runOnLimitedConnection` wake-protocol fix it forced. Implement is green; several ticket assumptions proved false and were worked around — verify the workarounds are honest and the follow-ups are filed.
prereq:
files: packages/integration-tests/src/scenarios/push-wake-e2e.integration.ts (new), packages/cadre-core/src/strand-wake-protocol.ts (fix), packages/cadre-core/src/cadre-node.ts (pushWake/resolvePeerAddrs/isMember/addStrand/hibernateStrand — unchanged, referenced), packages/cadre-core/src/strand-cohort.ts (selectStrandMode — unchanged, referenced), packages/integration-tests/src/scenarios/strand-formation-e2e.integration.ts (pattern), packages/cadre-core/test/peer-record-resolution.spec.ts (seed pattern)
----

## What landed

A new scenario file `packages/integration-tests/src/scenarios/push-wake-e2e.integration.ts`
(3 `it()`s, all green) that exercises the **real wire path** of control-network
push-wake — real `node.handle(WAKE_PROTOCOL,…)` dispatch, a real `dialProtocol`
stream over a real WebSocket transport, libp2p 3.x half-close, multi-chunk
length-prefixed JSON framing, the circuit-relay (signaling-first) dial, and
`pushWake`'s composition with `resolvePeerAddrs` — which the
`strand-wake-protocol.spec.ts` unit tests only cover with in-memory stream
doubles and a stubbed `dialProtocol`/`resolvePeerAddrs`.

**Plus a real product fix** the test forced (see Finding 1): `StrandWakeService`
now registers the WAKE handler with `runOnLimitedConnection: true`, and `dialWake`
opens the wake stream with `runOnLimitedConnection: true`. Without this the
protocol could **not** dial over a circuit relay at all (`LimitedConnectionError`)
— directly contradicting its own documented purpose ("a NAT'd peer is reachable
via its circuit-relay address"). One-line additions on each side; the wake
exchange is a single tiny request→ack well inside the relay's data/duration cap.

### Scenarios (what the reviewer should re-run and trust as a floor)

1. **Direct dial, hibernating member** — boots server `S` and receiver `Rx`,
   seeds `Rx`'s self-signed record on `S`, brings up a `mode:'bootstrap'` strand
   on `Rx` → `active`, hibernates it → `hibernating`, then `S.pushWake(...)`
   asserts `{accepted:true, status:'active'}` and `Rx.getStrand().status==='active'`.
   This is the only scenario that proves the **full hibernating→active resume**
   over the real wire (networked-solo resume succeeds with no relay contamination).
2. **NAT'd receiver via circuit relay** — relay `L` (relay server, distinct from
   `S`), `S` bootstrapped to `L`, `Rx` NAT'd (no direct listen addr; listens on
   `<L>/p2p-circuit`). Asserts `resolvePeerAddrs(Rx)` returns the `/p2p-circuit`
   addr **first** (signaling-first), then `S.pushWake(...)` over the relay asserts
   `{accepted:true, status:'active'}`. **The receiver's strand is kept ACTIVE
   (not hibernated)** so the wake is the "already-live → accepted" branch — this
   keeps the assertion about the relayed delivery (the unique thing here), not the
   networked strand resume (see Finding 3).
3. **Non-member rejected** — outsider `O` (its own authority, seeds `Rx`'s record
   so it can resolve+dial, but never authorized by `Rx`) dials a hibernating `Rx`.
   Asserts `ack.accepted===false` and the strand is **still `hibernating`** (no
   side effect — the receiver rejects before `wake`).

## Validation (all green at handoff)

- `yarn workspace @serfab/integration-tests test src/scenarios/push-wake-e2e.integration.ts`
  → **3 passed** (~10s wall incl. transform/import; each `it()` 0.2–0.6s).
- `npx vitest run test/strand-wake-protocol.spec.ts` (cadre-core) → **13 passed**
  (the `runOnLimitedConnection` change is invisible to the mock-based unit tests).
- `yarn workspace @serfab/cadre-core typecheck` → clean.
- `yarn workspace @serfab/integration-tests typecheck` → clean.
- `eslint` on both changed files → clean.
- No `.pre-existing-error.md` written — no unrelated failures surfaced.

**Build dependency:** the integration test imports the **built** `@serfab/cadre-core`
(`dist/` is gitignored). The fix lives in `cadre-core/src`, so `cadre-core` MUST be
rebuilt (`yarn workspace @serfab/cadre-core build`) before the integration test
will pick it up. Done locally; CI/review must build cadre-core first or the NAT
scenario fails with the original `LimitedConnectionError`.

Stability: ran the full file 3× while iterating — no flakiness. The relay
reservation appeared well under the 20 s `waitUntil` (sub-second locally). Kept
per-`it()` timeouts at 60 s and the reservation wait at 20 s for headroom.

## Findings / deviations from the ticket (review these critically)

The ticket was marked "fully resolved — no open options," but three of its
load-bearing assumptions did not hold against the real stack. Each deviation is
documented inline in the test file header; summarized here for the reviewer.

### 1. (FIXED, real bug) Wake could not dial over a relay — `runOnLimitedConnection`

The NAT scenario initially failed with `LimitedConnectionError: Cannot open
protocol stream on limited connection`. circuit-relay-v2 marks relayed
connections "limited"; libp2p refuses a protocol stream on a limited connection
unless **both** the handler registration and the dial opt in. The wake protocol
did neither. **Fixed** in `strand-wake-protocol.ts` (handler `handle(..., {
runOnLimitedConnection: true })` + `dialProtocol(..., { runOnLimitedConnection:
true })`). Reviewer: confirm this is the right fix (it matches how libp2p's own
RELAY_V2_STOP handler is registered) and that the tiny request→ack is safely
within the relay limit. This was the headline value of writing the NAT scenario.

### 2. (WORKED AROUND) Cross-node control-DB pull-on-read does NOT converge here

The ticket assumed a `registerSelf()`/`insertSelfPeerRecord()` on one node is
visible on another via pull-on-read ("just query after the write"). A diagnostic
(two control nodes, a live control connection) showed the receiver **never** sees
the server's `CadrePeer` row even after 24 s. The control DB uses a *network*
transactor (`control-database.ts`), but cross-node control reads do not converge
in this harness — consistent with the documented "control-network cohort
discovery is TODO" note in `strand-formation-e2e.integration.ts` (strand tests
work around the same gap by manually dialing strand nodes; the control plane has
no equivalent yet).

**Workaround (honest, keeps the wire path under test):** each node is made its
own control authority and the membership facts it consults are seeded **locally**
— the dialer seeds the target's self-signed record (so `resolvePeerAddrs` passes
its binding/self-sig/freshness/trust gates) and the receiver `authorizePeer()`s
the sender (so `isMember` is true). Every byte of the dial/handle/framing/resolve
path is still exercised; only the (currently non-functional) cross-node DB
propagation is sidestepped. **Reviewer judgement needed:** is cross-node control
replication *supposed* to work P2P (then this is a real product gap worth a fix
ticket — push-wake in production relies on the receiver reading the shared control
DB to know the sender is a member), or is it expected to need real
bootstrap/relay infra + time the harness doesn't provide? Suggest filing a
fix/backlog ticket to pin this down. (Not filed by implement — it needs the
design call above.)

### 3. (WORKED AROUND) NAT receiver is not hibernated; networked resume over a relay fails

Driving a *hibernating* NAT receiver to `active` requires the woken strand's
`networked` resume to form its Optimystic cluster (`resumeStrandRuntime` always
recomputes `mode` from cohort membership, and the sender must be a `CadrePeer` for
the wake gate, which forces `networked`). Over the relay mesh the strand cluster
tries to recruit the relay/server peers — which speak the control-network protocol,
not `/optimystic/strand-<id>/repo/1.0.0` — and fails super-majority
("could not negotiate … repo/1.0.0"). This is the same strand-cohort-discovery
TODO, surfaced acutely by the shared relay mesh; it is **not** a wake-transport
defect (the relayed dial + handler + framing + membership gate all succeed and an
ack round-trips). So scenario 2 wakes an **already-active** strand to keep its
assertion on the relay transport. The full hibernating→active resume is proven by
scenario 1 (same receiver code, direct transport). **Suggested follow-up:** a
fix/plan ticket for "woken NAT'd member's strand resume recruits non-strand
relay-mesh peers" (depends on strand-cohort discovery over the control network).
Not filed by implement — it's a design-level gap, not a quick fix.

### 4. (DEVIATION) NAT receiver listens on the relay's explicit `/p2p-circuit`, not `[]`

The ticket's `listenAddrs: []` never produces a reservation:
`@libp2p/circuit-relay-v2@4.x` skips a *discovered* relay reservation unless a
`/p2p-circuit` listen addr has populated the pending-reservation queue
(reservation-store `HadEnoughRelaysError` guard). The receiver listens on
`<L-addr>/p2p-circuit` — still genuinely NAT'd (no direct dialable addr), but the
reservation is deterministic rather than discovery-timing dependent.

### 5. (CONFIRMED) `addStrand` mode

`mode:'bootstrap'` stands the strand up solo and reaches `active` (the ticket's
preferred path; no fallback to `'networked'` was needed). On *resume*, mode is
recomputed from cohort and goes `networked` regardless of the original explicit
mode (relevant to Finding 3).

## Reviewer checklist

- Re-run the validation block above (remember to build cadre-core first).
- Sanity-check the `runOnLimitedConnection` fix in `strand-wake-protocol.ts` — is
  opening a stream on a limited connection acceptable for this protocol? (It is the
  protocol's whole point, and the frame is tiny.) Treat the unit tests as a floor.
- Decide whether Findings 2 and 3 each warrant a fix/plan/backlog ticket (implement
  deliberately did NOT file them — both need a product/design call you are better
  placed to make). If cross-node control replication is meant to work P2P, Finding 2
  is a latent correctness gap in production push-wake authorization.
- The local-seeding workaround (Finding 2) means the three scenarios do not prove
  control-DB replication. If you want that proven, it needs the Finding-2 follow-up
  first; this test should not be expected to cover it.
