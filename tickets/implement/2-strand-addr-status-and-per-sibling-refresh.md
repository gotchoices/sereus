description: A phone that joins after a party's always-on machines can wait ten minutes before those machines learn where it is, because they re-ask for addresses on a fixed timer per workspace and treat "the other machine failed to answer" the same as "it has nothing". Make each machine ask each newly connected sibling right away, retry failed siblings within about a minute, and have the answering side say when it could not answer. Reported as gotchoices/sereus#21 and #22.
architecture: docs/architecture.md#strand-address-resolution
files: packages/cadre-core/src/strand-addr-protocol.ts, packages/cadre-core/src/types.ts (StrandAddrResponse ~L1948), packages/cadre-core/src/cadre-node.ts (strandPeerAddrRefreshAt ~L538, resolveSiblingSeed ~L5718, recordDelegateAnnounces ~L5829, refreshStrandPeerAddrs ~L5964, refreshOneStrandPeerAddrs ~L6028, recordFormationStrandPeers ~L7768), packages/cadre-core/src/delegate-admission.ts (peerStrandKey, pruneStoppedStrandAnnounces), packages/cadre-core/src/index.ts (collectStrandAddrs export), packages/cadre-core/test/cadre-node-strand-addr-refresh.spec.ts, packages/cadre-core/test/strand-addr-protocol.spec.ts, packages/cadre-core/test/cadre-node-strand-seed.spec.ts, docs/architecture.md (Strand-Address Resolution), docs/strands.md
repro: verified
----

# Strand-address refresh: per-sibling throttle, and a response that says when it failed

Issues #21 and #22 from risavian (cadre-core 1.6.0, still present in 1.7.0). The handler-registration half of #22 (`void node.handle(...)`) is split out as `await-protocol-handler-registration`.

## Background

Each running strand (a shared workspace, run as its own libp2p node) keeps its own libp2p address book. The periodic pass `CadreNode.refreshStrandPeerAddrs` (run from the 15 s control-cohort reconcile tick) fills that book from two sources:

- **Own-party siblings**, asked over the control-network RPC `/sereus/strand-addr/1.0.0` (`collectStrandAddrs` → `StrandAddrService` on the sibling). The request also carries this node's strand `delegatePeerId`, which the sibling records as an admission grant for its relay.
- **The node-local strand peer book** (`strandPeerBookAddrs`): cross-party addresses from formation, identify, and the signed swap. Local reads only, no RPC.

## Reproduced (2026-09-28, against HEAD)

A throwaway vitest spec using the harness in `cadre-node-strand-addr-refresh.spec.ts` confirmed all four failures (the spec has been deleted):

- **Late sibling.** Sibling A is connected at T0 and gets asked. Sibling B connects, and the pass runs again at T0+15 s: B is **not** asked (`asked` contains only A). The cause is that `strandPeerAddrRefreshAt` is keyed only by strand, and every pass writes it whatever the answers were.
- **1.7.0 widening.** A strand with a peer-book entry and no connected sibling runs a pass at T0. It merges the book and **stamps the throttle**. A sibling then connects, and the pass at T0+15 s asks nobody. This is also the first tick after a restart, before any control connection exists.
- **Responder failure looks like "empty".** A `StrandAddrService` whose `isMember` throws (the control-database read failed, e.g. `peers-unreachable`) replies `{"strandId":"","multiaddrs":[]}`, which is byte-for-byte a legitimate "I have nothing". The concurrency-cap path and the malformed or timed-out request path reply the same way. The asker (`dialOneSibling`) reads only `multiaddrs`.
- (Handler registration: `initialize()` did not throw, and one `unhandledRejection` fired. That is covered in the other ticket.)

A fifth case follows from the same code but was not run: a non-member refusal is also indistinguishable from empty. That matters for the late-joiner case, because a phone asking an always-on node that has not yet received the phone's `CadrePeer` row by replication is refused. That refusal also means the phone's delegate grant was **not** recorded, so the phone needs a prompt retry.

## Design

### Response carries a required status (types.ts, strand-addr-protocol.ts)

```ts
/** How a strand-addr responder handled the request. */
export type StrandAddrStatus =
  | 'ok'           // looked up; `multiaddrs` is the truth (possibly empty: strand not running here)
  | 'unavailable'  // responder could not answer: over its concurrency cap, unreadable request, or its own lookup threw
  | 'refused';     // requester is not an authorized member in the responder's current view

export interface StrandAddrResponse {
  status: StrandAddrStatus;
  strandId: string;
  multiaddrs: string[];
}
```

- Required, not optional. No backwards compatibility is owed (AGENTS.md). An old responder's reply that has no status is therefore a malformed reply.
- Replace `emptyResponse(strandId)` with a helper taking the status. Mapping: cap hit → `unavailable`; `readFrame`/`processAddrRequest` throws (caught in `handleStream`) → `unavailable`; non-member → `refused`; member → `ok`.
- The asker must not trust the wire. `sendStrandAddr` must check that `status` is one of the three and that `multiaddrs` is a string array, and treat anything else as a failed exchange. `sanitizeStrandAddrs` in `strand-formation-protocol.ts` is the existing validator for the address list; reuse it if it fits.

### Asker reports per-sibling outcomes (collectStrandAddrs)

```ts
export type StrandAddrOutcome =
  | 'answered'     // status ok, ≥1 addr
  | 'empty'        // status ok, 0 addrs — a normal steady state
  | 'unavailable'  // status unavailable
  | 'refused'      // status refused
  | 'unreachable'; // every dial target failed / timed out / malformed reply

export interface StrandAddrCollection {
  /** Deduplicated union, signaling-first — exactly today's return value. */
  addrs: string[];
  /** One entry per candidate (self excluded), keyed by the sibling's control peerId. */
  outcomes: Map<string, StrandAddrOutcome>;
}
```

`dialOneSibling` returns `{ outcome, multiaddrs }` instead of folding to `[]`. Keep its single summary log line for total failure. Update the doc comments on `collectStrandAddrs`/`dialOneSibling` ("`[]` alone cannot tell…" no longer applies). Callers:

- `resolveSiblingSeed` (launch/resume) uses `.addrs`. It does **not** write the refresh throttle: the only cost is one extra RPC per sibling on the first tick after launch, and stamping there would race the throttle pruning while the strand node is still coming up.
- `announceDelegateToRelay` / `announceDelegateToDueRelays` ignore `outcomes` and keep recording announces optimistically. A dedicated `ops/` relay never speaks this protocol, so recording only on success would re-announce to it on every tick. Reword the `recordDelegateAnnounces` comment, whose reason ("reports no per-peer success") is no longer true, to give this reason instead.

### Refresh pass (cadre-node.ts)

Replace `strandPeerAddrRefreshAt: Map<strandId, number>` with a per-(sibling, strand) **due time**:

```ts
/** Keyed peerStrandKey(siblingControlPeerId, strandId) → epoch ms when that sibling is next due an RPC. */
private readonly strandAddrAskDueAt = new Map<string, number>();
```

Each pass (`refreshStrandPeerAddrs`):

- Collect the running strands as today, and prune keys whose strand is not running (`pruneStoppedStrandAnnounces` already works on `peerStrandKey` keys; rename or generalize it if the name now misleads).
- Enumerate connected sibling targets as today (skip the enumeration when `getConnections()` is empty). **Also prune keys whose sibling is not in the current target set**, so a sibling that disconnects and reconnects (for example a phone restart with a new relay reservation) is asked on its next connected tick. On an enumeration failure `targets` is `[]`. That prunes every stamp, which costs one re-ask round, not a missed one. Accept that.
- For each running strand:
  - **Always** merge the peer book's addresses into the strand node's address book (local, no RPC). This is what keeps cross-party and swap-forwarded entries alive past the one-hour peerStore expiry. Today it only happens on the throttled pass.
  - RPC only the siblings whose due time has passed (a missing key counts as due). Stamp each asked sibling from its outcome: `answered`/`empty` → `now + refreshMs` (`strandAddrRefreshMs` ?? `STRAND_PEER_ADDR_REFRESH_MS`, 10 min). `unavailable`/`refused`/`unreachable` → `now + STRAND_PEER_ADDR_RETRY_MS` (new exported constant, 60 000). A config knob for the retry interval is not needed. Tests inject `now`.
  - Merge `unionAddrs(siblingAddrs, bookAddrs)` as today. If both are empty, skip the merge.
- The "stopped mid-pass" re-check after the RPC and the per-strand try/catch stay as they are. Stamp before the re-check, as today, so a strand torn down mid-pass still records who was asked.
- Delete the `strandPeerAddrRefreshAt.delete(strandId)` in `recordFormationStrandPeers`. The book now merges every tick, so freshly carried addresses reach the address book on the next tick without it. Update the comment above it.
- Rewrite the doc comments on the map, `refreshStrandPeerAddrs`, `refreshOneStrandPeerAddrs`, and the `runReconcileControlCohort` NOTE about the third `CadrePeer` read (it now happens on any tick with a control connection and a running strand, not only when a strand is due, because pruning needs the target set). That read is the unbounded one documented on `connectedSiblingTargets`. If that is judged too costly, run the enumeration only when some (sibling, strand) could be due or a connection changed. Record the choice as a `NOTE:` either way.

NOTE for the code: the every-tick book merge costs up to 16 `peerStore.merge` calls per running strand per 15 s tick (book cap 16 peers × 16 addrs). When the addresses are unchanged, libp2p's persistent peer store writes nothing. Leave a `NOTE:` tripwire at the merge site: if many strands run at once, merge only book entries changed since the last tick, plus those nearing the one-hour expiry.

### Docs

- `docs/architecture.md` → Strand-Address Resolution: the request/response bullet (the status field, and "refused with an empty list" becomes `refused`), the client-union bullet (per-sibling outcomes), and the "kept warm" bullet (per-sibling throttle, one-minute retry, book merged every tick, re-ask on reconnect). The "cross-party" bullet says a re-formation "clears that strand's refresh throttle". Change that to say the every-tick book merge picks the new addresses up.
- `docs/strands.md`: check for the same throttle description and update it to match.

## Tests

Keep the reporter's scenarios as vitest cases that pass once fixed. Keep to the tests listed here; don't add others.

`cadre-node-strand-addr-refresh.spec.ts`. The harness `fakeControlNode` builds one loopback `StrandAddrService` per sibling. Extend `ControlFakeOpts` with a per-sibling responder behaviour (e.g. `unavailable: Set<peerId>`, whose receiver's `isMember` throws). Replace the `throttleMap` helper with one reading the new map.

- **New: a sibling that connects after a pass is asked on the next tick.** A at T0. B connects, and the pass at T0+15 s asks B and not A. Include the book-entry variant (a book-only pass at T0 must not stop B being asked at T0+15 s) as a second arrangement in the same test or a tight sibling, not a third test.
- **New: an unavailable responder is retried within `STRAND_PEER_ADDR_RETRY_MS`.** Its control read throws at T0. It is not re-asked at T0+RETRY−1, it is re-asked at T0+RETRY, and a healthy sibling in the same pass is not re-asked until the full interval.
- **Rework** "throttles a second pass…" into the per-sibling form. **Rework** "keeps the book's cross-party addrs alive when there is no sibling to ask" (it pins the old zero-target stamp): the book merges on every tick and nothing is stamped. **Rework** "skips a hibernating strand and prunes its throttle entry…" onto the new keys. **Delete** "leaves the throttle unstamped when there is no connected sibling to ask" (the late-sibling test subsumes it) and "re-forming against a running strand refreshes on the next tick…" (the every-tick book merge makes it true by construction, and the reworked book test covers it). Update "honours a configured strandAddrRefreshMs override" as needed.

`strand-addr-protocol.spec.ts`:

- The existing handleStream "replies with empty multiaddrs…" cases now also assert `status`: non-member → `refused`, malformed/oversized → `unavailable`, cap → `unavailable`. Add one case: an `isMember` that throws → `unavailable`. That is the #22 reproduction.
- The `collectStrandAddrs` cases move to `.addrs`. Add `outcomes` assertions to the existing "skips a throwing sibling…" (→ `unreachable`) and "returns [] when no sibling answers" cases, rather than adding new tests.
- `cadre-node-strand-seed.spec.ts` and any other `collectStrandAddrs`/`StrandAddrResponse` consumers: fix them so they compile against the new shape.

## TODO

- Add `StrandAddrStatus` and the required `status` to `StrandAddrResponse` (types.ts). Export from index.ts alongside the existing strand-addr exports.
- Responder: status-carrying reply helper, and the mapping in `handleStream`/`processAddrRequest`.
- Asker: validate the reply, have `dialOneSibling` return an outcome, and have `collectStrandAddrs` return `StrandAddrCollection`. Update the doc comments.
- Update the `resolveSiblingSeed`, `announceDelegateToRelay` and `announceDelegateToDueRelays` callers. Reword the `recordDelegateAnnounces` comment.
- Replace `strandPeerAddrRefreshAt` with `strandAddrAskDueAt`. Add `STRAND_PEER_ADDR_RETRY_MS`. Rework `refreshStrandPeerAddrs`/`refreshOneStrandPeerAddrs` (every-tick book merge, per-sibling due set, outcome-based stamping, pruning of stopped strands and disconnected siblings). Drop the throttle clear in `recordFormationStrandPeers`.
- Update the comments and NOTEs listed above, including the `runReconcileControlCohort` read-count NOTE and the new every-tick-merge tripwire.
- Tests as listed.
- Update docs/architecture.md (Strand-Address Resolution) and docs/strands.md.
- `yarn workspace @serfab/cadre-core build`, `yarn workspace @serfab/cadre-core test`, `yarn lint`.
- After release: reply on gotchoices/sereus#21 and #22 (the maintainer approves the posts). #22's registration half lands in `await-protocol-handler-registration`, so post once both are released.
