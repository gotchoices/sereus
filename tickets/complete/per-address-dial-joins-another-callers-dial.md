description: When a node tries a peer's addresses one at a time, another part of the node dialing the same peer at the same moment could capture that attempt, so the next address was never actually tried and a phone claiming or reaching a node could fail even though the node's working address was in its list. Each address is now dialed around libp2p's dial queue, bound to the peer expected, with an already-open connection reused; the wake and invitation dialers use the same dial, and the review closed a gap where a deadline or stop arriving during the dial's gater check was missed.
architecture: docs/architecture.md#cohort-auto-connect
files: packages/cadre-core/src/peer-dial.ts (dialAddr, attemptSignal, dialPeerAddrs, boundTo, reusableConnection, trailingPeerId, withTrailingPeerId, AddrDialer, ReusableConnection), packages/cadre-core/src/peer-record.ts, packages/cadre-core/src/index.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/seed-bootstrap.ts, packages/cadre-core/src/strand-wake-protocol.ts, packages/cadre-core/src/cadre-invite-protocol.ts, packages/cadre-core/src/strand-peer-redial.ts, packages/cadre-core/src/strand-formation-protocol.ts, packages/cadre-core/src/relay-reservation.ts, packages/cadre-core/src/strand-fret-addrs.ts, packages/cadre-core/test/peer-dial.spec.ts, packages/cadre-core/test/peer-record.spec.ts, packages/cadre-core/test/control-database-offline-peers.spec.ts, docs/architecture.md (Cohort auto-connect)
difficulty: hard
repro: verified
----
# Queue-free per-address dial — complete

## What landed

libp2p's dial queue keys every job by peer id and joins any new dial of that peer to a queued job, whatever address the new dial names; a joined job ends only when every caller has aborted. So while anything else dialed the same peer, each per-address attempt of `dialPeerAddrs` waited on the other job's address and the working address was skipped.

- **Fix stage** (`ticket(fix): per-address-dial-joins-another-callers-dial`): each address is dialed through libp2p's transport manager (`peer-dial.ts` → `dialAddr`), which never joins anything; the two gater hooks the queue ran are run there; the node's `status` is checked before an attempt and its `stop` event aborts one in flight.
- **Implement stage** (`ticket(implement): per-address-dial-joins-another-callers-dial`): `dialPeerAddrs` takes the expected peer id and binds every address to it (`withTrailingPeerId`) so the handshake verifies who answered; `dialAddr` hands back an open connection to that peer without relay limits instead of dialing, the rule the queue applied; `sendWake` and `exchangeRedemption` dial each address with `dialAddr` and open their stream on the returned connection; the two address helpers moved into `peer-dial.ts`; `dialAddr` surfaces the abort reason (deadline or stop) instead of the transport's "could not connect"; `docs/architecture.md` → "Cohort auto-connect" describes binding, reuse and the other dialers.
- **Review stage** (this pass): see below.

## Review findings

Read the implement-stage diff first (`ticket(implement): per-address-dial-joins-another-callers-dial`), then the handoff; checked libp2p 3.3.11's `DialQueue.dial` and `findExistingConnection` against what `dialAddr` and `reusableConnection` reproduce (they match: open connections only, direct preferred, a relayed one not reused when the address would upgrade to direct); traced every caller of `dialPeerAddrs` and `dialAddr`, the fallback path on a node without `transportManager.dial` (every spec double), the empty-address and all-self-relayed branches, `deliverSeed`'s three target forms, and the stop ordering (libp2p sets `status` to `stopping`, stops components, then emits `stop`).

**Minor, fixed inline.**

- **A deadline or stop arriving during the gater check was missed** (`dialAddr`). The abort and `stop` listeners were attached after `await assertDialAllowed(...)`, and a signal already aborted on entry fires no `abort` event, so in either case the transport dial ran with a live signal until the transport's own limit. Now `attemptSignal` links both before anything awaits and aborts at once for a signal already aborted; the attempt re-checks the linked signal after the gater hooks. Pinned by a new case in `test/peer-dial.spec.ts` ("rejects with the reason of a signal already aborted on entry, touching no network"); it fails against the previous code by timing out at 30 s, as expected.
- **Compatibility re-export removed.** `peer-record.ts` re-exported `trailingPeerId` and `withTrailingPeerId` so old import paths kept working, which the project rules decline. The seven importers (four source files, two specs, the public export in `index.ts`) now import from `peer-dial.ts`; the `withTrailingPeerId` cases moved from `peer-record.spec.ts` into `peer-dial.spec.ts`.
- **Contradictory comment** in `control-database-offline-peers.spec.ts`'s stop-mid-dial case: the comment said "if the pass settles first, proceed anyway" while the new assertion requires it not to have. The comment now says why the assertion holds on loopback.
- **Formation dial note extended.** `strand-formation-protocol.ts` → `openFormationStream` already carries an accepted-tradeoff `NOTE:` for its one-budget list dial; the queue join is the same class of delay with the same revisit condition, so it was added to that note rather than filed.

**Major.** None: the queue's behaviours that matter (join, existing-connection reuse, gater hooks, shutdown abort) are each reproduced or deliberately dropped with a written reason at `dialAddr`, and the one real defect found (above) was a local fix.

**Tripwires recorded.**

- `seed-bootstrap.ts` → `seedStreamOpener`, the one-multiaddr-string form of `deliverSeed`: still through the queue; one address so nothing is skipped, only delayed if joined. `NOTE:` at the site says when to switch it to `dialAddr`.
- `strand-formation-protocol.ts` → `openFormationStream`: the join, added to the existing `NOTE:` (above).
- `dialAddr`'s relay-leg `NOTE:` (from the implement stage) stands: a relayed address's relay leg still goes through the queue.
- `docs/architecture.md` → "Other callers of the dial helper" now names the three dials that still use the queue and why (`strand-addr-protocol.ts` dials by bare peer id, which is what the queue and address book are for).

**Considered and left alone.**

- `reusableConnection` casts the structural `ReusableConnection` to `Connection`; on a real node it is one, and no double reports an open connection. The constraint is written on the function.
- A limited (relayed) open connection is never reused, as with the queue; a wake to a peer with only a limited connection open dials a second relayed connection. Unchanged behaviour.
- `boundTo` logs once per address when the peer id does not parse; a few identical debug lines on a caller's mistake, not worth a pre-parse.
- The `dial-past-dead:` timing prints in `cadre-node-dial-past-dead-addresses.spec.ts` follow the pattern three budget specs already use.
- `exchangeRedemption` dials an invitation member address that may carry no `/p2p/` id; then nothing binds the handshake to a peer, exactly as `dialProtocol(addr)` behaved before. Not a regression; the bundle's addresses are checked elsewhere.

**Tests.** Added one (the pre-aborted signal, a defect found here). Cut none: the implement stage's four new cases each pin a libp2p behaviour on the transport-manager path (binding, no-binding rejection, open-connection reuse, stop) against real nodes, not doubles.

**Docs.** `docs/architecture.md` re-read for the section the change owns and the `deliverSeed` paragraph ("Connecting before the deadline", still accurate); `docs/reference-app-rn.md`'s dial-queue mention describes libp2p itself and stands. No other doc names the moved helpers.

## Validation

- `yarn workspace @serfab/cadre-core typecheck` and `eslint packages/cadre-core docs`: clean.
- `yarn workspace @serfab/cadre-core test`: 162 files, 2438 passed, 1 skipped (the same skip as before this ticket). Log: `tickets/.logs/per-address-dial-joins-another-callers-dial.review-suite.log`.
- The implement stage's integration runs (`control-cohort-edge-carries-data`, `control-cohort-three-node-isolation`, `blind-relay-phone-to-phone-e2e`) were not repeated: this pass changed no network behaviour on the paths they drive beyond the abort-timing fix, which the unit case covers.
