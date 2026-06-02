description: Review the control-network push-wake protocol (WAKE_PROTOCOL) — receiver, sender API, membership gate, framing
prereq: hibernation-checkin-backoff
files: packages/cadre-core/src/strand-wake-protocol.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/strand-wake-protocol.spec.ts, packages/cadre-core/test/cadre-node.spec.ts, packages/cadre-core/test/wake-stream-helpers.ts, docs/architecture.md, docs/STATUS.md, tickets/backlog/3-mobile-background-service.md
----

Implements the third of the architecture's three wake paths: **push-wake**. A same-cadre peer (e.g. an always-on server that participates in a strand and sees new activity) signals a hibernating cadre peer over the **control network** — the only network a hibernating peer keeps connected — to bring a strand online. Local wake and check-in wake landed previously; this completes the trio.

## What was built

**New module `strand-wake-protocol.ts`** — modeled directly on `seed-bootstrap.ts`:
- `WAKE_PROTOCOL = '/sereus/strand-wake/1.0.0'`; 4-byte big-endian length-prefixed JSON frames; one request → one ack per stream; the same `LibP2PStream` shim; reuses the exported `decodeLengthPrefixedFrame` guard.
- `StrandWakeService` (receiver): registers the `node.handle(WAKE_PROTOCOL, …)` handler. `processWakeRequest(request, remotePeerId)` is the decision core (made public for direct unit testing):
  - non-member sender → `{ accepted: false, reason: 'Sender is not a cadre member' }` (checked **before** any strand lookup),
  - unknown / not-participated strand → `{ accepted: false, reason: 'Strand not found or not participated in' }`,
  - `hibernating`/`idle` strand → routes through the injected `wake` callback (wired to `CadreNode.wakeStrand` → `resumeStrand`), then `{ accepted: true, status }`,
  - already-live strand → no-op, `{ accepted: true, status }`.
- `dialWake(node, addrs, request, opts?)` (sender): tries each address in order (signaling/relay first) until one dials, with a per-dial timeout (default 10s); half-closes the write end then reads the ack — the libp2p 3.x pattern from `deliverSeed`.

**`CadreNode` wiring**:
- `start()` instantiates + registers `StrandWakeService` on the control node (`isMember`, `strandManager.getInstance`, `wakeStrand` injected); `cleanup()` calls `shutdown()` (unhandle).
- New sender API `pushWake(targetPeerId, strandId, reason?)`: resolves the target's signed control-network multiaddrs via `resolvePeerAddrs` (freshness + trust gated, signaling-first so NAT'd peers are reachable via circuit-relay), then `dialWake`. Throws if not started or no dialable address.

**Types** (`types.ts`): `WakeRequest { strandId; reason? }`, `WakeAck { accepted; status?; reason? }`. **Exports** (`index.ts`): `StrandWakeService`, `dialWake`, `WAKE_PROTOCOL`, `StrandWakeServiceOptions`, `DialWakeOptions` (the message types ride `export * from './types.js'`).

**Authorization decision (v1, documented):** control-network membership IS the authorization — the control network already admits only this party's schema-gated `CadrePeer` nodes, and a wake is low-risk (it only makes the receiver spend resources coming online for a strand it already participates in). No per-request signature beyond `isMember(remotePeerId)`. See `strand-wake-protocol.ts` header and `docs/architecture.md` Wake Mechanisms #3.

## Validation performed

- `yarn workspace @serfab/cadre-core test` → **275 passed** (20 files, incl. new `strand-wake-protocol.spec.ts`).
- `yarn workspace @serfab/cadre-core typecheck` → clean; `build` → exit 0.
- `eslint` on all changed files → 0 errors (2 pre-existing `any` **warnings** at `cadre-node.ts:86,219` confirmed present on HEAD before this ticket; backlogged `warn`s, not introduced here).

## Test coverage (the floor, not the ceiling)

`strand-wake-protocol.spec.ts` (12 tests): protocol-id export; full `processWakeRequest` decision matrix (hibernating wake, idle wake, active no-op, unknown reject, non-member reject-before-lookup); `handleStream` framing round-trip via a capturing stream; oversized/malformed frame → `accepted:false` (exercises the shared length guard); `dialWake` end-to-end against a live receiver over an in-memory `duplexPair`, including non-member rejection, fall-through to a second address on first-dial failure, and empty-address throw.

`cadre-node.spec.ts` (2 added tests): `pushWake` loops the control node's `dialProtocol` into a receiver service and asserts the hibernating receiver transitions to `active` with `{ accepted, status }`; `pushWake` throws when `resolvePeerAddrs` returns nothing.

Shared test doubles live in `test/wake-stream-helpers.ts` (`frameMessage`, `decodeFrames`, `CapturingStream`, `duplexPair`) — a plain `.ts` so vitest's `*.spec.ts` glob doesn't run it.

## Known gaps / things to scrutinize (treat tests as a floor)

1. **No real-libp2p / two-node integration test.** Every test uses in-memory stream doubles and a mocked `dialProtocol`/`resolvePeerAddrs`. The actual wire path — `node.handle` registration, real `dialProtocol`, half-close semantics, multi-chunk framing across a relayed connection — is **not** exercised end-to-end. `seed-bootstrap.spec.ts` has live-CadreNode round-trips; there is no equivalent here. Strongest follow-up: an `integration-tests` case that boots two real `CadreNode`s and `pushWake`s across them (NAT'd receiver via relay). Consider whether this should be a new ticket.
2. **`pushWake → resolvePeerAddrs` composition is stubbed.** `resolvePeerAddrs` itself is covered by `peer-record-resolution.spec.ts`, but `pushWake`'s use of it (signed-record freshness/trust → dialable addr) is only tested with a stub returning a fixed multiaddr.
3. **Wake-vs-check-in race relies on existing primitives, not new code.** The claim "resume coalescing prevents a push racing a concurrent check-in" rests on `HibernationManager.beginWake` coalescing overlapping *wakes* and on `resumeStrand` being idempotent (a prereq-ticket invariant). `handleStrandCheckIn` calls `resumeStrand` directly (not via `beginWake`), so a push-wake firing mid-check-in is serialized only by `resumeStrand`'s own idempotency — verify that invariant still holds; no new coalescing was added here.
4. **Receiver has no overall stream timeout.** `handleStream` reads to EOF with no session/step timeout (matching `seed-bootstrap`'s handler), unlike `FormationListener` which has `sessionTimeoutMs`/`stepTimeoutMs`. A member that opens a stream and never half-closes its write end would hang that read indefinitely. Acceptable for v1 (membership-gated, low-risk), but a reviewer may want a read timeout / concurrency cap parallel to the formation listener.
5. **Status semantics for non-hibernating/idle strands.** `processWakeRequest` returns `accepted:true` for *any* known strand that isn't hibernating/idle — including `starting`, `stopping`, `stopped`, `error`. The ticket only specified hibernating/idle→wake and unknown→reject; treating `stopped`/`error` as a successful "already online" ack is my judgment call. Confirm that's the desired contract (vs. rejecting non-live statuses).
6. **Minor placement deviations from the literal TODO:** `WAKE_PROTOCOL` lives in the service module (mirroring `SEED_PROTOCOL` in `seed-bootstrap.ts`) rather than `types.ts`; only the message interfaces went into `types.ts`. `MAX_WAKE_SIZE` is 64KB (defensive — wake frames are tiny) vs. the seed protocol's 1MB. Both are deliberate; flag if the literal ticket placement is preferred.
7. **Out of scope by design (note for completeness, not a gap to fix here):** the automatic trigger policy (a server fanning wakes on detected activity) and mobile FCM/APNs delivery are owned by `tickets/backlog/3-mobile-background-service.md`, which now carries an explicit dependency note. A libp2p dial cannot reach a phone whose process the OS suspended; on mobile the `WakeRequest` must arrive via the platform push channel and the background task resumes locally.

## Docs updated

- `docs/architecture.md`: Wake Mechanisms #3 flipped from "planned" to "implemented" with the full protocol description; the `/sereus/*` protocol note near line 48 now lists `strand-wake`.
- `docs/STATUS.md`: "Push-wake via the control network" checklist item checked with a sub-summary.
- `tickets/backlog/3-mobile-background-service.md`: added the dependency block delimiting transport (landed here) from trigger-policy + mobile-delivery (still owned there).
