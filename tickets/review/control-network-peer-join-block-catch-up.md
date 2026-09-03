description: A second machine joining a party could converge the shared membership database over the network yet never receive some of its underlying storage blocks, so restarting offline made whole tables read as empty; the fix teaches the control network the same peer-join block catch-up strands already had, and this handoff asks for a review of that work.
files: packages/cadre-core/src/peer-join-backfill.ts, packages/cadre-core/src/cadre-node.ts (startControlBackfill ~line 1120-1210, start() wiring ~line 850, cleanup ~line 3490, refreshAuthorizedControlPeers ~line 1630), packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/types.ts (controlBackfill config), packages/cadre-core/src/index.ts, packages/cadre-core/test/peer-join-backfill.spec.ts, packages/cadre-core/test/strand-instance-manager-backfill.spec.ts, packages/integration-tests/src/scenarios/control-offline-read-after-restart.integration.ts, packages/quereus-plugin-sereus/src/cluster-size.ts, docs/architecture.md, docs/cadre-consistency.md, tickets/.pre-existing-known.md
----

# Review: control-network peer-join block catch-up

## What was broken (one paragraph)

A control block committed while its writer was alone has a cohort of one, forever — the named
collection-header blocks (`default/CadrePeer`, `default/OwnerKey`, index headers) are written
once at the founder's solo genesis and never revised, so no later commit carries them anywhere.
The control network had no peer-join block catch-up (strands did), so whether a joiner held a
header was a hash-proximity coin flip. A member restarting offline then read the affected tables
as EMPTY, silently — measured as `control-delete-while-alone-convergence.integration.ts:154`
failing 8 of 11 isolated runs. Full evidence chain is in the completed implement ticket body
(now under this slug in `complete/` once review lands).

## What was built

- **`strand-backfill.ts` → `peer-join-backfill.ts`** (one shared module, no fork). Renames:
  `StrandBackfill` → `PeerJoinBackfill`, `DEFAULT_STRAND_BACKFILL` → `DEFAULT_PEER_JOIN_BACKFILL`,
  matching `*Config/Deps/Result/PushClient` types; deps field `strandId` → neutral `label`.
  No backwards-compat aliases (repo rule). Copy logic byte-for-byte unchanged except:
  - new optional dep `authorizePeer?: (peerId: string) => Promise<boolean>` — judged at PUSH
    time inside `runCatchUp`, fails CLOSED on a throw; a denied run sets `result.denied`,
    is never memoized, so the peer retries later;
  - new public `scheduleConnectedPeers()` — re-arms the debounce for every connected,
    not-yet-done peer (also used by `start()` for pre-existing connections);
  - `PeerJoinBackfillResult` gained `denied: boolean`.
  Module comment documents why the strand call site passes NO gate and why the control network
  MUST (the strand "everything connected already receives replicas" argument does not carry
  over — the control inbound gate deliberately admits non-members).
- **Control wiring** (`cadre-node.ts`): new `controlNetworkName()` (single binding for
  `control-<partyId>`, used by both `buildControlNodeOptions` and the backfill's protocol
  prefix `/optimystic/control-<partyId>`); `startControlBackfill()` called from `start()` right
  after `wireControlConnectionListeners()` (control DB is up, so the gate can read);
  `authorizePeer` = `isAuthorizedMember`; stopped in `cleanup()` BEFORE the control DB closes
  and the node stops (mirrors `releaseRuntime`). Receiving side needed no work:
  `createLibp2pNode` registers the block-transfer handler unconditionally, and the existing
  per-stream gate (`authorizeInboundControlStream`) covers inbound pushes.
- **Membership re-arm**: `refreshAuthorizedControlPeers` now calls
  `controlBackfill?.scheduleConnectedPeers()` after a successful snapshot refresh. Rationale:
  the production join order is connect-then-authorize, so the joiner's FIRST catch-up pass is
  denied while its connection stays up; without the re-arm it would wait for a reconnect.
- **Control debounce default 250 ms** (strand default stays 1000 ms), overridable via the new
  `CadreNodeConfig.controlBackfill`. Rationale in code: control store is small, re-push is
  idempotent, and the converge-one-row-then-stop window can be shorter than 1 s.
- **Docs**: `docs/architecture.md` (the "strand networks only" / "control network deliberately
  does not run the block catch-up" claims replaced with the new truth), `docs/cadre-consistency.md`
  (queue vs catch-up are complements, not substitutes), `cluster-size.ts`
  (`CONTROL_REPLICATION_BREADTH`'s every-member claim now credits the catch-up for pre-growth
  blocks), `types.ts` (both config fields).
- **`tickets/.pre-existing-known.md`**: delete-while-alone entry moved to resolved with the
  gate numbers; noted `control-write-while-alone-convergence`'s stale entry can retire at the
  next gardening pass.

## Validation actually run (all green, logs in tickets/.logs/control-network-peer-join-block-catch-up.*)

| gate | result |
| --- | --- |
| `control-delete-while-alone-convergence` isolated ×5 | **5/5 files, 10/10 cases** (pre-fix ~45% cases red) |
| `control-write-while-alone-convergence` isolated ×5 | 5/5, 10/10 (no regression) |
| new `control-offline-read-after-restart` ×5 | 5/5 |
| `strand-membership-closed-strand-e2e` ×1 | 6/6 (rename regressed nothing strand-side) |
| cadre-core unit suite | 106 files, 1706 passed, 1 skipped |
| `yarn build` / `yarn typecheck` / `yarn lint` (root) | exit 0 |

## The new tests

- `peer-join-backfill.spec.ts` (renamed from `strand-backfill.spec.ts`): all prior cases kept;
  4 new gate cases — denied peer gets zero pushes and is not memoized (then passes after
  authorization), throwing gate fails closed, gate judged at push time not schedule time
  (revocation during debounce), and `scheduleConnectedPeers()` re-arms a denied peer without a
  reconnect.
- `control-offline-read-after-restart.integration.ts` — the property test: A genesises alone,
  B joins and converges a `CadrePeer` row; a raw-store-only coverage gate
  (`compareBlockCoverage`, never reading through B's DB) proves B physically holds A's whole
  control store including `default/CadrePeer` and `default/OwnerKey`; both stop; B restarts
  ALONE (0 connections) and must still answer `isMember(X)` AND `getOwnerKeys()` — two tables,
  covering the class.

## What the reviewer should probe (known gaps, honest)

- **The 250 ms control debounce is a judgment call**, not a measured tuning. The delete
  scenario's phases 1-3 complete in ~1 s, so the old 1000 ms default left the push racing
  `B.stop()`; 250 ms gives margin and 5/5 rounds pass, but nobody swept the value. If the gate
  ever flakes again, look here first.
- **A denied-then-authorized peer with a stable connection relies on the membership re-arm**
  (`refreshAuthorizedControlPeers` → `scheduleConnectedPeers`). That refresh fires on committed
  local `CadrePeer` writes and on gate refresh calls — a membership row that arrives purely by
  REPLICATION triggers it only via the timed cohort reconcile's refresh. Bounded staleness by
  design (same as the stream gate); worth a second opinion on whether that bound is acceptable.
- **`isAuthorizedMember` per gate check is a full `CadrePeer` query** (existing predicate,
  deliberately reused — one code path). Runs once per (peer × catch-up attempt), debounced;
  fine at cadre scale, unmeasured beyond it.
- **The gate-denial path returns an all-zero result that also carries `denied: true`;** the
  no-`listBlockIds` inert path is still distinguishable only by log line. Cosmetic.
- **Tombstone skip NOTE** (pre-existing, carried over): a block whose latest revision is a
  delete is never pushed; a joiner relies on read repair for it. Unchanged behaviour, now
  applies to the control network too — the delete-while-alone scenario's row-level tombstone
  re-issue covers the case that matters there, and its 5/5 gate agrees.
- **Not closed by this ticket** (documented in the implement ticket, re-stated so review does
  not re-file): `blocked/block-held-by-only-one-machine-is-unreadable` (different site, refuted
  as this scenario's owner but shares the solo-commit origin — exposure reduced, not removed);
  `blocked/forked-control-collection-sync-livelocks` names the same scenario file and should be
  re-measured now that this landed; `backlog/control-rereplication-broadcast-confirmation`
  is the row-level twin and is not subsumed.
