description: After a strand peer connects, the node pushes its stored blocks to it, but it also tries this against the relay, which cannot receive strand data, and after three failures prints a warning naming the relay. Stop the catch-up from targeting peers that do not speak the strand's block-transfer protocol.
architecture: docs/architecture.md#strand-networks
files: packages/cadre-core/src/peer-join-backfill.ts, packages/cadre-core/test/peer-join-backfill.spec.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/cadre-node.ts, docs/strands.md, .release-notes.pending.md
difficulty: easy
----

## What changed

`PeerJoinBackfill` (`packages/cadre-core/src/peer-join-backfill.ts`) used to schedule a
whole-store push to every peer reported by libp2p's `connection:open` event — including a
circuit relay or bootstrap node that is connected to every strand/control node but speaks
none of the namespaced `/optimystic/<network>/db-p2p/block-transfer/1.0.0` protocol. The push
always failed, and after `PEER_JOIN_BACKFILL_WARN_AFTER_FAILURES` (3) consecutive failures the
module printed a `console.warn` naming the relay as if it were a struggling strand peer —
gotchoices/sereus#18.

The fix, per the maintainer decision referenced in the ticket:

- New exported pure helper `speaksBlockTransfer(protocols, protocolPrefix)` — `true` iff
  `protocols` includes `buildBlockTransferProtocol(protocolPrefix)` (from `@optimystic/db-p2p`).
  Exported for the next ticket (`strand-peer-book-local`), which needs the identical test for
  its own identify-driven address-observation writer.
- Scheduling now happens on libp2p's `peer:identify` event (`CustomEvent<IdentifyResult>`),
  not `connection:open`. The handler schedules a peer only when `speaksBlockTransfer` is true
  for its identified `protocols`.
- `scheduleConnectedPeers()` (used by `start()`'s initial sweep and by the control network's
  membership-change re-drive) is now `async Promise<number>`: for each currently-connected
  peer it reads `libp2p.peerStore.get(peerId)` and schedules only if the stored protocols
  already include ours. A peer not yet in the peer store (`NotFoundError`/throw — identify
  hasn't finished) is left alone rather than dialed blind; the later `peer:identify` event
  picks it up. This changes the method's signature, so the one production caller
  (`CadreNode.refreshAuthorizedControlPeers`) now calls it as `void this.controlBackfill?.scheduleConnectedPeers();`
  (still fire-and-forget, same as before — nothing awaited the old synchronous call either).
- **Removed `connection:open` entirely** rather than keeping it alongside `peer:identify`: no
  test needed it (see below), and keeping a second listener that duplicates scheduling would
  have added complexity for no behavioral benefit. If a reviewer knows of a runtime/fixture
  where `peer:identify` does not fire for an otherwise-connected peer, that would be a reason
  to reconsider — flagging as a place to double-check, not a known gap.
- Module comment rewritten: the paragraph describing the strand-networks membership argument
  no longer claims "the dial fails and the push is dropped" for a non-speaking peer (that
  peer is now never scheduled at all); a new paragraph at the top names the #18 symptom
  directly. Every other comment/doc mention of `connection:open` as the trigger event was
  updated to `peer:identify` (backoff/retry reasoning itself is unchanged — only the event name
  was stale). The old forward-looking `NOTE:` suggesting a peer-store pre-check was replaced
  with a note describing the mechanism that now exists (check happens once, not re-verified
  after scheduling).
- `strand-instance-manager.ts`: one `NOTE:` updated (`connection:open` → `peer:identify`
  listener) — no behavioral change, `PeerJoinBackfill` still owns its own peer selection.
- `docs/strands.md`: one sentence added to the SN-SN relay section (the section literally
  covering this bug's shape — two relay-only parties) naming the mechanism and #18.
- `.release-notes.pending.md`: added a `## Fixes` heading (the file had none) and a bullet for
  this issue, alongside the pre-existing gotchoices/sereus#18 bullet from the prior ticket
  (`cadre-core-remembers-joined-strands`).

## Tests

`packages/cadre-core/test/peer-join-backfill.spec.ts` — the fake libp2p (`makeLibp2p`) was
extended rather than replaced:

- Added a `peerStore.get(peerId)` fake that mirrors `@libp2p/peer-store`: throws for an
  unknown peer id (so "identify hasn't finished" is distinguishable from "identified with no
  matching protocol"), otherwise resolves `{ protocols }`.
- `dispatchConnectionOpen(remotePeer, protocols?)` now simulates a connection opening AND its
  identify completing in one call (firing `peer:identify`, not `connection:open`) — this is
  the realistic sequence the module now schedules on, and it kept ~25 existing tests passing
  unchanged since `protocols` defaults to this network's own block-transfer protocol (an
  ordinary speaking peer). Tests that need a non-speaking peer pass `[]` explicitly.
- A peer passed in the `connections` array (used for "already connected when `start()` runs"
  tests) is now pre-registered in the fake peer store as already-identified, matching the
  production case this exercises: a runtime rebuilt over live connections never sees a fresh
  `peer:identify`, but the peer's protocols are already persisted from before.
- `scheduleConnectedPeers()` callers updated to `await`/`void` per the new async signature.
- **New test**: `'never dials, re-arms, or warns about a peer whose identify omits the
  block-transfer protocol, while a speaking peer is caught up normally'`. Constructs two
  distinct push clients (one per simulated peer id) so a wrongly-scheduled relay push would be
  independently observable; dispatches `peer:identify` for a relay (`protocols: []`) and an
  ordinary peer, waits for the ordinary peer's push, then gives the (would-be) relay backoff
  every chance to fire within a short `retryBackoffMs`. Asserts zero relay pushes and that
  `console.warn` was never called. This is the test that pins the exact #18 regression — before
  the fix, the relay push would have been attempted, failed, retried, and warned.

All 31 tests in this file pass, including the new one. No test was added for the "identify
never fires for a connected peer" edge case the ticket calls out — per the ticket's own
guidance, this is an accepted cost noted in the module comment (db-p2p nodes always run
identify; read repair still covers reads), not something to regression-test.

## Validation performed

- `yarn workspace @serfab/cadre-core typecheck` — clean.
- `yarn workspace @serfab/cadre-core test` (full suite) — 141 files, 2288 passed, 1 pre-existing
  unrelated skip (`key-store.spec.ts`, Windows-only `it.skipIf`).
- `yarn eslint` on all four changed `.ts` files — clean.
- `yarn lint` (repo-wide) — clean.
- Integration scenarios run in the foreground, all green:
  - `strand-late-cadre-join` (3 tests)
  - `strand-membership-closed-strand-e2e` (9 tests, including the whole-store coverage gate
    that is the proof real strand peers are still scheduled and caught up)
  - `blind-relay-phone-to-phone-e2e` (2 tests — this is literally the two-relay-only-parties
    shape the bug report describes; no misleading warning appeared in its output)

## Things for the reviewer to scrutinize

- The decision to drop `connection:open` entirely rather than keep it as a belt-and-suspenders
  trigger — reasoning is in the module comment and above; no test forced keeping it.
- `scheduleConnectedPeers()`'s signature change from `number` to `Promise<number>` — only one
  production call site existed (`cadre-node.ts`), updated to `void`-prefixed fire-and-forget,
  matching its prior (also un-awaited) usage.
- Whether the docs sentence in `docs/strands.md` (SN-SN relay section) is the right location —
  the ticket named "the relay/Some Questions area" but no prior sentence there actually
  described the catch-up's relay-targeting behavior to amend, so this is a new addition rather
  than an edit of existing prose.
