description: A machine's private data-sharing session cannot start behind a home router, because the party's storage machine refuses to forward its traffic. Teach the storage machine to accept forwarding requests from the extra network names its own party members run, and only those.
files: packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/strand-addr-protocol.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/membership-connection-gater.ts, packages/cadre-core/src/strand-transport-key.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/integration-tests/src/scenarios/push-wake-e2e.integration.ts, packages/integration-tests/src/scenarios/control-stream-authz.integration.ts, docs/strands.md, docs/architecture.md
difficulty: hard
----

# Delegate-peer admission: let a party relay serve its own members' strand nodes

<!-- resume-note -->
**Prior run (2026-07-29) hit the soft token budget during investigation. NO code was
changed — the working tree is untouched by that run.** All findings are inline below (no
external log). The design in this ticket was verified against HEAD; nothing contradicts it.
Start implementing directly from these confirmed sites — no re-discovery needed:

- **Delegate peerId computation.** `peerIdFromPrivateKey` from `@libp2p/peer-id` is the
  right call on the derived transport key (already used throughout
  `packages/integration-tests`). At reconcile/re-announce time, do NOT re-derive: a running
  strand's delegate peerId is simply `instance.libp2pNode.peerId.toString()` — enumerate via
  `StrandInstanceManager.getInstances()` (`strand-instance-manager.ts:154`). Re-derivation
  via `strandTransportKey` is only needed on the launch/resume paths (deterministic, cheap).
- **Gate wiring site.** `admitInboundControlConnection` is `cadre-node.ts:883-907`; insert
  the delegate check between the enrollment-window check (:887-889) and the
  `listAuthorizedMembers()` read (:890). Its doc block is :832-882 (numbered admit list
  :841-860, the "who pays" ordering note :861-863). Stream gate
  `authorizeInboundControlStream` is :985-999 (doc :948-984) — doc-only change there.
- **Announce hook (responder).** `StrandAddrService` is constructed in `CadreNode.start()`
  at `cadre-node.ts:541-545` — inject `onDelegateAnnounce` there. `processAddrRequest` is
  `strand-addr-protocol.ts:219-230`; the `isMember` gate is :222 — call the hook after it,
  before the `getStrandMultiaddrs` lookup. `peerIdFromString` is already imported in that
  module (:34) for validation. The request is additive JSON — no framing changes.
- **Announce plumbing (client).** `collectStrandAddrs` builds one shared request object at
  `strand-addr-protocol.ts:274`; add `delegatePeerId` to `CollectStrandAddrsOptions` (:246)
  and set it on that request. `StrandAddrRequest`/`StrandAddrResponse` live in
  `types.ts:1036-1054`.
- **Launch reorder.** In `launchStrand` (`cadre-node.ts:2765-2811`) the transport key is
  derived at :2789 AFTER `resolveCohortSeed` at :2771 — swap. Clean approach: give
  `resolveCohortSeed` (:2827-2843) an optional `delegatePeerId` and, when present, merge the
  relay targets into the sibling set it already passes to `collectStrandAddrs` — the
  announce then rides the exact RPC pass the launch already awaits, so every grant is
  recorded on the responder BEFORE `startStrand` runs `libp2p.start()` (the responder
  records the grant before writing its response; the client awaits responses).
  `resumeStrandRuntime` (:2500-2507) gets the same optional-arg treatment.
- **Relay targets.** For a configured circuit listen addr, strip the trailing
  `/p2p-circuit` to get the relay's direct dial addr and pass it as the
  `StrandAddrPeer.addrs` fallback (`strand-addr-protocol.ts:234-243` supports exactly this)
  — covers the not-yet-connected-relay case. Live-circuit relays come from
  `controlNode.getMultiaddrs()` (pattern at `getRelayAddress`, `cadre-node.ts:3535-3543`).
  A party-member relay admits the announcer (the announcer's control node IS an authorized
  member), so the responder-side `isAuthorizedMember` gate passes; a dedicated `ops/` relay
  does not speak the protocol at all and the per-peer failure folds to `[]` — harmless and
  correct (it needs no grant: it has no membership gate).
- **Re-announce.** `runReconcileControlCohort` is `cadre-node.ts:1455-1530` (15 s interval
  armed at :1273). Track `lastAnnouncedAt` per (target, strand). Record it OPTIMISTICALLY
  at announce time: `collectStrandAddrs` folds per-peer failures to `[]` and reports no
  per-peer success, and threading success out would change its API for little gain — a
  failed INITIAL announce is fatal-at-start anyway (relay denies the reservation,
  `libp2p.start()` throws, wake/check-in re-resume retries with a fresh announce), and a
  failed REFRESH retries within TTL/2 = 15 min, still inside the 30 min TTL. State this
  tradeoff in a comment at the site.
- **Unit-test harnesses (exist, reuse).** `test/membership-gate-helpers.ts` `inject()` +
  the private-method call pattern in `test/control-stream-authorization.spec.ts` (its
  `admitConnection`/`authorize` helpers) are exactly how to assert "grant admits the
  connection, stream gate still denies" — put that case beside the enrollment-window
  divergence test (`control-stream-authorization.spec.ts:122`). For the responder,
  `test/strand-addr-protocol.spec.ts` has `makeService(overrides)` and a `freshPeerId()`
  helper that mints real parseable peerIds — extend `makeService` with `onDelegateAnnounce`.
- **Bookkeeping.** `tickets/.pre-existing-known.md:3-4` is the entry to remove once the
  circuit-relay scenario is green.
- **Module placement.** `cadre-node.ts` is ~3300 lines; put the grant store + the
  relay-peerId extractor in a new `packages/cadre-core/src/delegate-admission.ts` with its
  own spec file, mirroring `membership-connection-gater.ts`'s injectable-policy pattern
  (the ticket's stated preference — confirmed sensible on inspection).
<!-- /resume-note -->

## What is broken (reproduced at HEAD, 2026-07-29)

`packages/integration-tests/src/scenarios/push-wake-e2e.integration.ts > E2E push-wake over
the control network > delivers a wake to a NAT'd receiver over a circuit-relay
(signaling-first) dial` fails **deterministically**, alone via `-t "circuit-relay"` and in
whole-file runs:

```
UnsupportedListenAddressesError: Some configured addresses failed to be listened on …
  /ip4/127.0.0.1/tcp/<port>/ws/p2p/<L>/p2p-circuit: UnexpectedEOFError: Unexpected EOF - stream closed while reading 0/1 bytes
      at ReservationStore.#createReservation (@libp2p/circuit-relay-v2/…/reservation-store.js:279)
      at Libp2p.start (libp2p/src/libp2p.ts:236)
      at StrandInstanceManager.buildStrandRuntime (packages/cadre-core/src/strand-instance-manager.ts:263)
```

thrown from `Rx.addStrand(...)`.

Chain of causes, all confirmed:

1. A strand node runs as its own libp2p instance with its **own** transport peerId, derived
   from the cadre identity key + strandId (`strand-transport-key.ts`) — the fix for the
   shared-relay reservation collision in [issues/1](https://github.com/gotchoices/sereus/issues/1).
2. That derived peerId is **unattested**: nothing anywhere binds it to a party member.
3. The strand node inherits the control node's `network.listenAddrs` verbatim
   (`strand-instance-manager.ts:280-285`), so on a NAT'd node it inherits the
   `…/p2p/<L>/p2p-circuit` listen addr and tries to reserve a relay slot on `L`.
4. `L` is a party **control** node with `enableRelay: true` — the default for every
   storage-profile node (`cadre-node.ts:784`). Its membership connection gater asks
   `admitInboundControlConnection` (`cadre-node.ts:883`), which sees an unknown peerId with no
   admit path open (node running, anchor non-empty, not configured bootstrap infra, no
   enrollment window, non-empty authorized set lacking it, no outstanding formation invite)
   and **denies the inbound encrypted connection**.
5. The reservation stream dies mid-multistream-select, the `/p2p-circuit` listen fails, and
   `libp2p.start()` throws — so the strand never starts at all.

The prior triage pass confirmed step 4-5 two ways: `L` admits **Rx's control node** on the same
relay/transport/code path (the "Rx's circuit-relay reservation appears" assertion at
`push-wake-e2e.integration.ts:459-460` passes), and inserting
`L.openEnrollmentWindow(Date.now() + 120_000)` before `Rx.addStrand(...)` — the one in-memory
bypass of the authorized-member check — turns the failure into a clean pass.

## Decision

`docs/strands.md:76-79` asks exactly this as an open question — *"Can any sereus relay node
serve as a relay for anyone? Can a relay refuse service to unknown nodes?"* **Resolution
adopted here:**

> A **dedicated** relay/bootstrap node (the `ops/` infrastructure stacks) has no membership
> gate and relays for anyone. A **party control node** that also runs the relay server is
> party-private infrastructure: it relays for its own party's nodes — including the extra
> transport identities its members' strand nodes run as — and for nobody else.

Realizing that needs a way for the relay to learn "peerId P acts on behalf of member M". The
chosen mechanism is a **member-announced delegate grant**: before a member's control node
starts a strand node, it tells the relay (over the already-authenticated control network) the
derived peerId that strand node will use, and the relay holds a short-lived, in-memory
admission grant for exactly that peerId.

### Why not the alternatives

- **A. Admit every relay-client connection on relay-enabled control nodes.** Rejected. A
  connection gater cannot see protocols, so this admits *every* stranger connection on every
  storage-profile node (relay is on by default there) — a deliberate security-posture widening
  of the layer-2 gate that would need human sign-off. Delegate grants get the same unblocking
  with the exposure narrowed to peerIds an authenticated member explicitly named.
- **B. Attest strand transport peerIds as replicated, signed rows in the control DB.** The
  durable, auditable, revocable version of the same idea — but it puts a **replication
  latency** dependency on a path that hard-fails: if the attestation row has not converged to
  the relay when the strand node dials, `libp2p.start()` throws and the strand does not start.
  It also costs a `schemas/control.qsql` change (plus the byte-equivalent embedded
  `CONTROL_SCHEMA`), a signed-record byte format, a publish path, and an edition/determinism
  review. Deliberately deferred, not discarded — see "Deferred" below.
- **C. Stop handing strand nodes the control node's `/p2p-circuit` listen addr.** A non-fix.
  It makes this test pass while leaving genuinely NAT'd strand meshes unreachable. Recorded
  here so it is not rediscovered as a fix.

## Design

### 1. The grant (relay side) — `cadre-node.ts`

An in-memory map of delegate peerIds a member vouched for, consulted by the existing
connection gate and by nothing else:

```ts
/** How long one announced delegate grant stays valid without a re-announce. */
export const DELEGATE_GRANT_TTL_MS = 30 * 60 * 1000;
/** Cap on live grants per announcing member, and in total (oldest-expiry evicted first). */
export const MAX_DELEGATE_GRANTS_PER_MEMBER = 32;
export const MAX_DELEGATE_GRANTS = 256;

interface DelegateGrant {
  /** The authorized member whose control node announced this delegate. */
  announcerPeerId: string;
  /** The strand the delegate serves — diagnostics + per-strand replace semantics. */
  strandId: string;
  /** Epoch ms after which the grant is inert. */
  expiresAt: number;
}
```

`CadreNode` gains:

- `grantDelegateAdmission(announcerPeerId: string, strandId: string, delegatePeerId: string): void`
  — record/refresh a grant. Called **only** from the strand-addr responder, after that
  handler's existing `isAuthorizedMember` gate has passed. Re-announcing the same
  `(announcer, strandId)` **replaces** the previous delegate peerId rather than accumulating,
  so a restarted strand cannot leak grants. Enforce both caps; evict soonest-expiry first.
- `hasDelegateAdmission(remotePeerId: string): boolean` — cheap, synchronous, prunes expired
  entries as it goes.

Wire `hasDelegateAdmission` into `admitInboundControlConnection` as a new admit check, placed
**after** the enrollment-window check and **before** the `listAuthorizedMembers()` DB read
(it is in-memory; the ordering comment at `cadre-node.ts:861-863` explains who pays for what
and must be updated).

**Do NOT wire it into `authorizeInboundControlStream`.** That gate stays a strict subset: a
delegate gets the *connection* (which is all the circuit-relay `hop` reservation needs — the
`authorizeInboundStream` hook only wraps the four Optimystic control-DB services, confirmed in
`../optimystic/packages/db-p2p/src/inbound-authorization.ts`) and still cannot open
`repo`/`cluster`/`sync`/`block-transfer`, nor pass the in-handler `isAuthorizedMember` checks
on wake and strand-addr.

### 2. The announcement (member side) — `strand-addr-protocol.ts`

Reuse the existing control-network strand-address RPC rather than adding a protocol: it is
already registered on every control node, already gates on `isAuthorizedMember`, already
carries a `strandId`, already tolerates per-peer failure, and already runs on limited (relayed)
connections. Extend the request with one optional field:

```ts
export interface StrandAddrRequest {
  strandId: string;
  /**
   * The derived transport peerId the requester's own strand-<strandId> node runs as.
   * Present → the responder records a delegate admission grant for it (relay admission);
   * absent → today's behavior exactly.
   */
  delegatePeerId?: string;
}
```

`StrandAddrServiceOptions` gains an injected
`onDelegateAnnounce?(announcerPeerId: string, strandId: string, delegatePeerId: string): void`,
called from `processAddrRequest` **after** the `isMember` gate and before the address lookup.
`CadreNode` injects `grantDelegateAdmission`. Validate the field: reject anything that is not a
parseable peerId, and ignore a `delegatePeerId` equal to the announcer's own peerId.

`collectStrandAddrs` grows an optional `delegatePeerId` so the caller can set it on the request
it already sends.

### 3. Who gets announced to, and when — `cadre-node.ts`

**Do not rely on `resolveCohortSeed`'s target set.** Verified in the failing run with
`DEBUG='sereus:cadre:strand-addr'`: **zero** strand-addr dials happen before the failure,
because `resolveCohortSeed` (`cadre-node.ts:2827`) only RPCs connected peers that already have
a converged `CadrePeer` row in the local DB, and the relay `L`'s own row had not replicated to
`Rx` yet. Relay admission must not depend on DB convergence.

Announce targets = union of:

- relay peerIds parsed from configured `network.listenAddrs` — the `<relay>` in
  `…/p2p/<relay>/p2p-circuit`. This is the deterministic case and the one the failing test
  needs: the strand node inherits these very addrs;
- relay peerIds parsed from the control node's own live `/p2p-circuit` multiaddrs (covers a
  reservation this node discovered rather than configured);
- connected `CadrePeer` siblings (free — `resolveCohortSeed` already dials them; just set the
  field on that request. Future-proofs strand-mesh admission).

Sequencing in the `addStrand` path (`cadre-node.ts:2771-2806`): derive `transportKey`
**before** resolving the cohort seed, compute its peerId, then announce, then
`startStrand(...)`. Today the derivation happens after `resolveCohortSeed` — reorder.
`resumeStrandRuntime` (`cadre-node.ts:2501`) must do the same, so hibernate → wake re-announces.

Refresh: a grant must outlive the reservation, because a dropped relay connection makes the
strand's circuit-relay transport re-dial and face the gate again. Re-announce from the existing
`controlCohortReconcileTimer` pass (`DEFAULT_CONTROL_COHORT_RECONCILE_MS` = 15 s,
`cadre-node.ts:1273`) for every running strand, **throttled** to no more than once per
`DELEGATE_GRANT_TTL_MS / 2` per (relay, strand) so the 15 s tick does not turn into per-tick
RPC chatter. Track `lastAnnouncedAt` locally.

### 4. Docs + the stale note

- `docs/strands.md:76-79` — replace the open question with the resolution above (dedicated
  relay = open; party control node running a relay = party-private, serves its members'
  delegate peerIds).
- `strand-transport-key.ts:38-43` — the "unattested … breaks nothing" note is **wrong** and
  caused this bug. Correct it: the derived peerId *is* attested now, by the runtime delegate
  announcement, and the note should point at it. Keep its pointer to the durable
  `MemberPeer(MemberKey, PeerId)` binding as the strand-mesh-admission follow-up.
- `docs/architecture.md` — the strand-addr RPC description gains the announce direction.

## Residual exposure (state it, don't hide it)

A delegate grant admits a **connection**, so the delegate reaches the always-on libp2p
services on the relay's control instance: `identify`/`identifyPush`, `ping`, `dcutr`,
`autoNAT`, `gossipsub`, the circuit-relay `hop`, and the fret/arachnode DHT services
(`../optimystic/packages/db-p2p/src/libp2p-node-base.ts:504-620`). The four Optimystic
control-DB protocols stay fail-closed, and wake/strand-addr/formation/seed keep their own
in-handler decisions. So the widening versus today is: **an authorized member can hand
connection-level access to a peerId of its choosing for up to `DELEGATE_GRANT_TTL_MS`.** The
relay cannot verify that the named peerId really is that member's strand node — the derivation
uses the member's *private* seed by design (`strand-transport-key.ts:30-34`), so it is not
recomputable by a third party. This is a delegation of trust to an already-trusted member, not
an opening to strangers; option A would have opened it to everyone.

## Deferred (do not file as tickets from this one)

- **Durable attestation (option B).** When strand-*mesh* admission control lands it will need
  the signed `MemberPeer(MemberKey, PeerId)` binding anyway; at that point the in-memory grant
  can be backed by a replicated row and gain revocation + audit. Record as a bullet in
  `docs/strands.md`, not a ticket.
- **Autorelay-discovered party relays.** A relay the strand node discovers on its own (no
  configured `/p2p-circuit` listen addr, relay not a converged connected `CadrePeer`) gets no
  announcement and will still deny. Note it at the announce-target site as
  `// NOTE:` — conditional, and every realistic topology is covered by the union above.
- **`listenAddrs` inheritance.** `strand-instance-manager.ts:280-285` already carries an
  "Unverified" note about fixed ports being inherited; a `/p2p-circuit` addr is the second
  instance of that inheritance being wrong-by-default. Add one sentence to that same note
  saying the circuit addr is now deliberate (it is what gives a NAT'd strand a reachable slot)
  and depends on the delegate announcement above.

## TODO

### Phase 1 — grant + gate

- Add `DELEGATE_GRANT_TTL_MS`, the two caps, and the `DelegateGrant` shape to `cadre-node.ts`
  (or a small `delegate-admission.ts` if `cadre-node.ts` is already overfull — it is ~3300
  lines; a separate module with an injectable store is preferred and matches
  `membership-connection-gater.ts`'s testability pattern).
- Implement `grantDelegateAdmission` / `hasDelegateAdmission` with replace-per-(announcer,
  strandId), lazy expiry pruning, and both caps (evict soonest-expiry first).
- Add the `hasDelegateAdmission` check to `admitInboundControlConnection`, between the
  enrollment-window check and the `listAuthorizedMembers()` read; update that method's doc
  block (the numbered admit list and the "who pays" ordering note).
- Leave `authorizeInboundControlStream` untouched; extend its doc to say a delegate-admitted
  connection is exactly one of the cases it must still refuse.
- Unit tests: grant expiry, replace-not-accumulate, both caps, and that
  `authorizeInboundControlStream` denies a peer that `admitInboundControlConnection` admits by
  grant.

### Phase 2 — announce over the strand-addr RPC

- Add `delegatePeerId?: string` to `StrandAddrRequest` (`types.ts`), plumb it through
  `collectStrandAddrs` / `dialOneSibling` / `sendStrandAddr`.
- Add `onDelegateAnnounce` to `StrandAddrServiceOptions`; call it in `processAddrRequest` after
  the `isMember` gate. Validate/parse the peerId; ignore self-announcements.
- `CadreNode.initializeStrandAddr` (wherever the service is constructed) injects
  `grantDelegateAdmission`.
- Unit tests on `processAddrRequest`: non-member announce is ignored, member announce grants,
  malformed peerId is ignored, address-lookup behavior unchanged when the field is absent.

### Phase 3 — announce targets + sequencing

- Helper (exported for test) that extracts relay peerIds from a multiaddr list:
  `…/p2p/<relay>/p2p-circuit` → `<relay>`. Cover a bare `/p2p-circuit`, a full circuit addr
  with a trailing `/p2p/<dst>`, and a non-circuit addr.
- Reorder the `addStrand` path so the transport key is derived before cohort-seed resolution;
  compute the delegate peerId from it; announce to the union target set; then `startStrand`.
- Same for `resumeStrandRuntime`.
- Re-announce from the control-cohort reconcile pass, throttled to `DELEGATE_GRANT_TTL_MS / 2`
  per (relay, strand).

### Phase 4 — validation

- `yarn build` + `yarn typecheck` + `yarn lint` clean; `yarn test` in `packages/cadre-core`.
- The gating scenario, from `packages/integration-tests`:
  `yarn vitest run --reporter=verbose src/scenarios/push-wake-e2e.integration.ts -t "circuit-relay" 2>&1 | tee <scratch>/relay.log`
  then the whole file. Remove the entry from `tickets/.pre-existing-known.md` once green.
- Extend `packages/integration-tests/src/scenarios/control-stream-authz.integration.ts` (or a
  sibling) so the policy is asserted at the **connection** layer, not merely implied by the
  push-wake scenario passing. Three cases: (a) an un-announced stranger peerId is still denied
  its inbound connection; (b) an announced delegate peerId is admitted; (c) that same admitted
  delegate is still refused a control-DB stream (`repo`) **and** a wake/strand-addr request.
- Docs: `docs/strands.md` open question resolved, `strand-transport-key.ts:38-43` note
  corrected, `docs/architecture.md` strand-addr section updated,
  `strand-instance-manager.ts:280-285` note extended.

## Review handoff must call out

- Whether the announce genuinely lands before the strand's `libp2p.start()` on every path
  (`addStrand`, `resumeStrand` via wake, via check-in) — the failure mode is fatal, not
  degraded.
- The residual exposure paragraph above, verbatim, so the reviewer judges the widening
  deliberately.
