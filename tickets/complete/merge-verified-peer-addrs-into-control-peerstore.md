----
description: A node now copies its teammates' verified network addresses into the shared address book on every reconcile pass, so the layers underneath can dial a teammate by name instead of failing with an empty address book.
files: packages/cadre-core/src/peer-addr-book.ts (new), packages/cadre-core/src/cadre-node.ts, packages/cadre-core/test/peer-addr-book.spec.ts (new), packages/cadre-core/test/cadre-node-control-cohort.spec.ts, docs/architecture.md
----

Control-network arm of `plan/feat-merge-cadre-peer-addrs-into-libp2p-peerstore`. The strand arm
(`implement/2-merge-strand-peer-addrs-into-strand-peerstore`) reuses the helper this ticket
introduces.

## What shipped

**`packages/cadre-core/src/peer-addr-book.ts` (new, 160 lines).**
`mergePeerAddrs(host, peerId, addrs) → 'merged' | 'restamped' | 'skipped' | 'failed'`.

- Empty `addrs` ⇒ `'skipped'`, no write. This is how a revoked / stale / untrusted peer's entry
  is allowed to age out on its own.
- Otherwise `peerStore.merge`, then a visibility check against the returned (already
  expiry-filtered) `Peer`. All present ⇒ `'merged'`; not present ⇒ a field-preserving
  `peerStore.save` restamp ⇒ `'restamped'`.
- `peerId` may be a `PeerId` or the string form callers actually hold; the parse is inside the
  helper's own error fold, so no caller re-wraps it.
- Any throw is logged via `debug('sereus:cadre:peer-addr-book')` and folded to `'failed'`.

The restamp exists because of an upstream bug, re-confirmed during review by reading the
installed package: `@libp2p/peer-store@12.0.10`'s `to-peer-pb.js:126` shadows its own loop
variable (`addresses?.find(addr => uint8ArrayEquals(addr.multiaddr, addr.multiaddr))` — always
true, so it returns the *first* stored address's `observed`). Every read then filters addresses
older than `MAX_ADDRESS_AGE` (1 h, `constants.js:1`). Net effect: an entry dies at the one-hour
mark and no amount of re-merging revives it. `store.js`'s `save` is the one write path that omits
`existingPeer` and so stamps `Date.now()` — but it re-uses the `patch` strategy, dropping every
field it is not handed, so the restamp carries `addresses` / `protocols` / `metadata` / `tags` /
`peerRecordEnvelope` forward by hand.

**`cadre-node.ts` — `runReconcileControlCohort` restructured.** New step 3 between sibling
enumeration and the dial loop: `warmSiblingAddrBook(siblings)` resolves **every** sibling once
(not the `selectControlCohortDials` subset, and not skipping already-connected ones), merges each
non-empty result into the control peerStore, and returns a `Map<peerId, Multiaddr[]>` the dial
loop consumes — one `queryPeerRecord` per sibling per pass, not two. Only `resolvePeerAddrs`
output is merged, never the cold-start `peerStoreAddrs` fallback. `_running` / `controlNode` are
re-guarded on both sides of the resolve await.

**`docs/architecture.md`** — the "cohort auto-connects" bullet gained the address-book paragraph,
including the libp2p caveat and where it is pinned.

## Review findings

Read the implement diff (`e85eebd`) before the handoff summary. Verified the upstream libp2p bug
claim against the installed `@libp2p/peer-store@12.0.10` source rather than taking it on trust —
`to-peer-pb.js`, `store.js`, `dedupe-addresses.js`, `peer-equals.js`, `constants.js`, and
`libp2p/dist/src/libp2p.js`'s peerStore wiring all read as described.

### Fixed in this pass (minor)

- **DRY / layering: the helper forced every caller to pre-parse and re-wrap.**
  `mergePeerAddrs` took a `PeerId`, so `cadre-node.ts` carried a 15-line private
  `mergeSiblingAddrs` that duplicated the helper's own empty-`addrs` check and added a second
  try/catch purely to contain `peerIdFromString`. The strand arm would have copied it verbatim —
  `groupAddrsByPeerId` is specified to return string keys. Widened the helper to
  `PeerId | string`, moved the parse inside its existing fold, and deleted `mergeSiblingAddrs`
  (`cadre-node.ts` 4859 → 4842 lines). The strand arm's `mergePeerAddrs(strandNode, peerId, addrs)`
  now works directly on those string keys.
- **Log label was self-contradictory.** `address book warmed (resolved=3, …, skipped=3)` — the
  counter is siblings processed, not siblings that resolved to something. Renamed to `siblings=`.
- **Two test gaps closed** (see *Tests* below).

### Considered and deliberately not changed

- **`maxAddressAge` would sidestep the whole workaround in one line.** libp2p forwards
  `init.peerStore` straight into `persistentPeerStore` (`libp2p.js:77-79`), and
  `PersistentPeerStoreInit.maxAddressAge` is public config — so raising it on the control node
  would retire the restamp entirely. Not done, and now recorded as a `NOTE:` at the helper so the
  next reader does not have to re-derive it: expiry is load-bearing in this design. Only verified
  addresses come through the helper, and the stated rule "never restamp the cold-start fallback,
  let it age out" depends on stock expiry still applying to seed and identify-learned addresses.
  A global age bump would keep those alive too.
- **The spec's four undeclared imports** (`@libp2p/peer-store`, `datastore-core`,
  `@libp2p/logger`, `main-event`, all hoisted transitive deps of `libp2p`). The implementer
  measured the alternative — declaring them re-resolves the ranges and drags an unrelated
  `datastore-core` 11.0.2 → 11.0.4 bump into the lockfile — and documented the decision plus its
  fallback ("declare at exact versions if this ever breaks") in the spec header. That is an
  accepted tradeoff at the site with a revisit condition; not re-litigated.
- **The implement handoff's claim that the restamp "preserves `isCertified`" is weaker than
  stated**, though the code is right. Because the upstream bug stamps *every* address with the
  same `observed`, the expiry filter is all-or-nothing: whenever expiry is what triggered the
  restamp, the merged `Peer`'s address list is empty and there is no flag left to preserve. The
  preservation loop only does anything in the address-rejected case below. Left as-is — it is
  correct defensive code and the code comment does not overclaim; only the handoff prose did.
- **`resolveControlDialAddrs` is now a three-line pass-through** whose name no longer describes
  what it does. Left alone: the fallback rationale in its doc comment is worth more than the
  saved lines, and the strand ticket references neighbouring line numbers.

### Tripwires parked (conditional — not tickets)

- `peer-addr-book.ts`, on `mergePeerAddrs` — **permanent restamp loop if the store ever rejects
  an address we hand it.** `allVisible` would stay false forever and `save` would re-submit the
  same rejected address every pass. libp2p wires the store's `addressFilter` to
  `connectionGater.filterMultiaddrForPeer`; nothing in this repo implements that hook today
  (`createMembershipConnectionGater` gates dials, not addresses), so the loop is unreachable — but
  `NetworkConfig.connectionGater` is app-supplied and could add it. Cost if it trips: one
  redundant datastore write per gated sibling per ~15 s pass, forever. No `peer:update` storm —
  `peerEquals` ignores `observed`, so a restamp that changes nothing else does not fire the event.
- `peer-addr-book.ts`, same comment block — the `maxAddressAge` alternative above.
- `cadre-node.ts`, on `warmSiblingAddrBook` — the implementer's existing per-pass-cost NOTE gained
  a second arm: the pass now resolves every sibling **serially before any dial**, so each record
  query also delays the pass's first dial, not just its total cost. Same escape hatches, plus
  "move the warm pass after the dials".
- Retained from implement: the non-atomic read-modify-write against a concurrent `identify` write
  (`restampData`), and the dropped tag TTL.

### Checked, nothing found

- **Address-key normalization.** Walked `dedupe-addresses.js` against `addrKey`: the store strips
  a trailing `/p2p/<peerId>` only when that id is the address's *first* `/p2p/` component, so a
  direct address round-trips stripped and a relayed one (`…/p2p/<relay>/p2p-circuit/p2p/<peer>`)
  keeps it. `addrKey` strips the suffix from both sides, which matches either shape. Verified for
  direct, relayed, WebRTC-over-circuit, and self-in-the-middle forms. No permanent-restamp case.
- **Cross-copy multiaddr identity.** The restamp feeds `Address` objects from the peerStore's own
  `@multiformats/multiaddr` back in alongside ours from the top-level copy. `isMultiaddr` keys off
  `Symbol.for(...)`, which is registry-global, and `decapsulate` runs on the instance's own
  implementation. Safe.
- **Peer eviction.** `MAX_PEER_AGE` (6 h) evicts on `updated`, which `#saveIfDifferent` bumps on
  every write including a no-op one, so a warmed entry never hits it.
- **The two integration assertions the implementer flagged as read-not-run.**
  `control-cohort-three-node-isolation:130,143` and `control-cohort-edge-carries-data:273` assert
  `peerStoreAddrsFor(B, cPeerId)` is empty inside a negative window. Re-read both plus
  `bootControlTrio`: B's only reconcile pass drains at harness step 2, *before* C starts (step 3)
  and before A vouches it (step 4), and both scenarios boot with `reconcileMsB: 600_000`. So no
  pass runs while C is a resolvable sibling and the assertions still hold. Worth recording that
  line 130 is now **more** fragile than the connection check beside it: a stray
  `self:peer:update`-triggered pass would leave peerStore addresses even if its dial failed,
  whereas before only a *successful* dial was observable. Both files already carry a NOTE naming
  that trigger as the first suspect. Not run — these scenarios are red for causes tracked in
  `.pre-existing-known.md` and the suite exceeds the agent wall-clock budget.
- **Swallowed-exception behaviour change.** `resolveSiblingAddrs` now folds a `resolvePeerAddrs`
  throw to `[]` where it previously propagated out of the whole pass. Both call sites of
  `reconcileControlCohort` already `.catch(…)` and log, so nothing regressed to an unhandled
  rejection; the change turns one aborted pass into per-sibling log lines plus a cold-start-fallback
  dial attempt, which is the right trade now that the pass touches every sibling.
- **Shutdown safety.** `_running`/`controlNode` guards bracket both awaits in the warming loop and
  the pass re-guards after it. Covered by a test.
- **Docs.** Read `docs/architecture.md`'s changed bullet in full against the shipped code — the
  "every sibling / only verified / one-hour caveat / pinned by a spec" claims all match. Checked
  the other subsystem docs for stale address-book statements; none of `cadre-host.md`,
  `strands.md`, `cadre-consistency.md` or `STATUS.md` describe peerStore contents, so nothing else
  needed updating. `docs/strands.md` is the strand arm's to update.

### Tests

Run: `yarn lint` (repo root) clean; `yarn typecheck` in `packages/cadre-core` clean; full
`yarn test` in `packages/cadre-core` → **1528 passed, 1 skipped, 2 failed**, both pre-existing (below).
The two affected specs are 44 passing tests.

Gaps closed in this pass:

- `peer-addr-book.spec.ts` — a **malformed peer-id string folds to `'failed'` with nothing
  written**. The old `mergeSiblingAddrs` catch that handled this was entirely untested; after the
  refactor the behaviour lives in the helper and is pinned there.
- `peer-addr-book.spec.ts` — the string-form `peerId` overload merges and reads back.
- `cadre-node-control-cohort.spec.ts` — **two consecutive passes**: a sibling merged in pass N and
  resolving to `[]` in pass N+1 is not re-merged. The implement handoff called this out as
  covered per-sibling but never in sequence, which is the shape production actually takes.

Judged adequate as-is: the 200-simulated-minute expiry test is the load-bearing one and does its
job — it pins both halves (helper survives, plain merge dies), so an upstream fix fails the test
instead of silently changing production. Error paths (throwing `merge`, throwing `save`, rejecting
merge mid-pass), the empty-input no-write, store-rewritten addresses, and the stop-mid-warm race
are all covered.

Still uncovered, deliberately, and unchanged from the handoff: **no live-network proof.** Nothing
in `packages/integration-tests` asserts that a dial-by-bare-peer-id succeeds between reconcile
passes because the book is warm — the actual user-visible claim (gotchoices/Optimystic#11). A
scenario would have to drop a sibling connection and drive an Optimystic cluster/repo call by peer
id. Not filed as a ticket: the integration suite is currently red for several unrelated tracked
causes, so a new scenario added now could not be shown green, and the claim is unit-covered.
This is the single largest remaining gap in the work — flagging it here rather than burying it.

Also unasserted and accepted: the invisibility window (an entry is only restamped *after* it has
fallen off the one-hour edge, so there is a gap of up to one reconcile interval — bounded and
self-healing, but unmeasured), and address ordering (`resolvePeerAddrs` returns signaling first;
the peerStore sorts alphabetically, so libp2p's own dial ranking takes over).

### Pre-existing failures — not this ticket's

`test/control-start-storage-op-budget.spec.ts` (1983 ops vs a 1700 budget) and
`test/strand-solo-write-budget.spec.ts` (1979 vs 1780). Both are listed in
`tickets/.pre-existing-known.md` under `optimystic-schema-catalog-reread-per-write-blows-storage-budgets`
(blocked), added by the triage pass in `b825dd5`. Not re-reported. `tickets/.pre-existing-error.md`
is empty and stays that way.

One further observation, not filed: `test/control-database-solo-warm-start.spec.ts` failed 3 of its
6 tests on **one** of two full-suite runs (that file: 118 s under load vs 60 s in isolation) and
passes cleanly alone and on the repeat full run. Same fingerprint as the timeout-under-parallel-load
class already analysed at length in `.pre-existing-known.md` (the `control-formation-invite` entry,
fixed by budgeting `testTimeout` suite-wide). One unreproduced occurrence with no captured error
text does not meet the bar to name a site, so it is recorded here as evidence rather than filed.
