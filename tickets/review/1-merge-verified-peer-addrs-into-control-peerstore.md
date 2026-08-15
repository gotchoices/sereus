description: A node now copies its teammates' verified network addresses into the shared address book on every reconcile pass, so the layers underneath can dial a teammate by name instead of failing with an empty address book. Review the new helper, its workaround for a libp2p bug, and where the pass calls it.
files: packages/cadre-core/src/peer-addr-book.ts (new), packages/cadre-core/src/cadre-node.ts, packages/cadre-core/test/peer-addr-book.spec.ts (new), packages/cadre-core/test/cadre-node-control-cohort.spec.ts, docs/architecture.md
difficulty: medium

Implements `implement/1-merge-verified-peer-addrs-into-control-peerstore` (control-network arm of
`plan/feat-merge-cadre-peer-addrs-into-libp2p-peerstore`). The strand arm is
`implement/2-merge-strand-peer-addrs-into-strand-peerstore`, which reuses the new helper.

## What landed

**`packages/cadre-core/src/peer-addr-book.ts` (new, ~135 lines).**
`mergePeerAddrs(host, peerId, addrs) → 'merged' | 'restamped' | 'skipped' | 'failed'`.

- Empty `addrs` ⇒ `'skipped'`, no write at all. This is how a revoked / stale / untrusted peer's
  existing entry is allowed to age out on its own.
- Otherwise `peerStore.merge`, then a **visibility check** against the returned (already
  expiry-filtered) `Peer`. All present ⇒ `'merged'`.
- Not present ⇒ a field-preserving `peerStore.save` restamp ⇒ `'restamped'`.
- Any throw ⇒ logged via `debug('sereus:cadre:peer-addr-book')`, folded to `'failed'`. Nothing
  escapes; callers are best-effort loops.

The restamp exists because of an upstream bug, confirmed by reading the installed package and
pinned by a test: `@libp2p/peer-store@12.0.10`'s `to-peer-pb.js:126` shadows its own loop variable
(`addresses?.find(addr => uint8ArrayEquals(addr.multiaddr, addr.multiaddr))` — always true, so it
returns the *first* stored address's `observed`). Every read then filters addresses older than
`MAX_ADDRESS_AGE` (1 h). Net effect: an entry dies at the one-hour mark and **no amount of
re-merging revives it**, not even merging a brand-new address. `save` is the one write path that
omits `existingPeer` and so stamps `Date.now()` — but it also drops every field it is not handed,
so the restamp carries `addresses` / `protocols` / `metadata` / `tags` / `peerRecordEnvelope`
forward by hand.

**`cadre-node.ts` — `runReconcileControlCohort` restructured.** New step 3 between the sibling
enumeration and the dial loop:

- `warmSiblingAddrBook(siblings)` resolves **every** sibling once (not the `selectControlCohortDials`
  subset, and *not* skipping already-connected ones) and merges each non-empty result into the
  control peerStore, returning a `Map<peerId, Multiaddr[]>`.
- The dial loop consumes that map, so the pass makes **one** `queryPeerRecord` per sibling, not two.
  `resolveControlDialAddrs(peerId, resolved)` and `dialControlSibling(sibling, resolved)` now take
  the already-resolved addresses; the cold-start `peerStoreAddrs` fallback is unchanged.
- Only `resolvePeerAddrs` output is merged — never the cold-start fallback, which came out of the
  address book and would restamp unverified seed addresses forever.
- `_running` / `controlNode` re-guarded on **both** sides of the resolve await, so a torn-down node
  is never written to.
- New pass log line: `address book warmed (resolved=…, merged=…, restamped=…, skipped=…, failed=…)`.

**`docs/architecture.md`** — the "cohort auto-connects" bullet (Control Network status section)
gained the address-book paragraph, including the libp2p caveat and where it is pinned.

## Deviations from the implement ticket (all deliberate — check these first)

- **Helper takes `PeerAddrBookHost` (`{ peerStore }`), not `Libp2p`.** `Libp2p` satisfies it
  structurally, and it lets a spec pass a bare peerStore.
- **The restamp preserves `isCertified`.** The ticket said a certified address would lose the flag
  because `save` would be handed `multiaddrs`. It is handed `addresses` instead, so the flag
  survives. Cheaper than the loss it was accepting.
- **A tag's remaining TTL is still dropped** on restamp (the public `Tag` type exposes only
  `value`, so the stored expiry is unreadable) — the tag comes back non-expiring rather than
  vanishing. Documented at the site. Worth a reviewer's opinion: for a `keep-alive` tag,
  non-expiring is arguably wrong in the other direction.
- **`resolvePeerAddrs` failures are now caught per sibling** (`resolveSiblingAddrs`) and yield `[]`.
  Before, a control-DB read failure propagated out of the whole pass. This is a real behaviour
  change; it is in the spirit of "best-effort throughout", and it matters more now that the pass
  resolves *every* sibling rather than only the disconnected selected ones.
- **Not exported from `src/index.ts`.** The strand arm is in the same package, so keep it internal
  unless that ticket needs it cross-package.

## Validation — what was run

- `yarn lint` (repo root) — clean.
- `yarn typecheck` + `yarn build` in `packages/cadre-core` — clean.
- `yarn test` in `packages/cadre-core` — **1525 passed, 1 skipped, 2 failed**; both failures are
  pre-existing and unrelated (see below).
- `packages/cadre-core/test/peer-addr-book.spec.ts` (new, 8 tests) and
  `cadre-node-control-cohort.spec.ts` (33 tests) — all pass.

### New tests

`peer-addr-book.spec.ts` runs against a **real** `persistentPeerStore` over a `MemoryDatastore`
with `Date.now` stubbed:

- fresh address ⇒ `'merged'` and readable back.
- **the load-bearing one:** 200 simulated minutes of 10-minute passes. The helper's address stays
  readable at every checkpoint and reports `'restamped'` only after it actually falls off; a
  control peer merged the plain way at the same cadence reads back **empty**. A future libp2p bump
  that fixes the upstream bug fails this test instead of silently changing production behaviour.
- restamp carries `protocols` / `metadata` / `tags` / `peerRecordEnvelope`, and revives both an aged
  address and one merged after the freeze.
- addresses the store rewrites on the way in (`/p2p/<self>` stripped for a direct address, kept for
  a relayed one) still report `'merged'`, not `'restamped'`.
- empty list ⇒ `'skipped'` with the entry provably untouched; a throwing `merge` and a throwing
  `save` each ⇒ `'failed'`.

`cadre-node-control-cohort.spec.ts` — new "address-book warming" block (the fake control node
gained a `peerStore.merge` double; ids there are real Ed25519 ids because the merge path parses
them):

- every sibling merged, **including** an already-connected one and ones the `targetDegree` cap
  dropped from dialing.
- exactly one resolution per sibling per pass (the dial reuses it).
- a sibling that resolves to `[]` is never merged **even when the cold-start peerStore entry would
  still let the pass dial it**.
- a rejecting `merge` still lets the pass dial its selected siblings.
- a `stop()` landing during the first resolve leaves zero writes.

One existing test changed meaning and was renamed: "skips a sibling that is already connected (no
re-dial, no resolve)" → "does not re-dial a sibling that is already connected (but still resolves
it)". That resolve is now the point, not waste.

## Known gaps — treat the tests as a floor

- **No live-network proof.** Nothing in `packages/integration-tests` asserts that a dial-by-bare-
  peer-id succeeds between reconcile passes because the address book is warm. That is the actual
  user-visible claim (gotchoices/Optimystic#11: replication stalling on NAT'd/mobile topologies) and
  it is unit-covered only. A scenario would need to drop a sibling connection and then drive an
  Optimystic cluster/repo call by peer id.
- **Existing integration assertions were read, not run.** `control-cohort-three-node-isolation` and
  `control-cohort-edge-carries-data` both assert `peerStoreAddrsFor(B, cPeerId)` is empty inside a
  negative window. Reading them, the change is safe: both boot B with `reconcileMsB: 600_000` and no
  explicit pass runs between "C's record becomes resolvable on B" and the window. Those scenarios
  are red for unrelated reasons already tracked in `tickets/.pre-existing-known.md`, so this was not
  confirmed by a run. **A reviewer with a working integration environment should confirm it.**
- **The invisibility window is neither closed nor measured.** Because `merge` freezes the timestamp,
  an entry is only restamped once it has *already* fallen off the one-hour edge — so there is a gap
  of up to one reconcile interval (~15 s) where a sibling's address is unreadable. Bounded and
  self-healing, but no test asserts the bound and nothing pre-emptively restamps at, say, 45 minutes.
- **The restamp is a read-modify-write and is not atomic** against a concurrent `identify` write to
  the same entry. The loss window is milliseconds and costs at most one identify update, recovered
  by the next identify push. Documented at the site; deliberately no lock (per the implement
  ticket). Not tested.
- **Address ordering does not survive.** `resolvePeerAddrs` returns signaling (`/p2p-circuit`)
  first, but the peerStore sorts addresses alphabetically internally, so libp2p's own dial ranking
  takes over downstream. Noted in the implement ticket as accepted; not asserted anywhere.
- **The new spec's four imports are undeclared dependencies.** `@libp2p/peer-store`,
  `datastore-core`, `@libp2p/logger` and `main-event` resolve out of the hoisted root
  `node_modules` as transitive deps of `libp2p`. Declaring them in `packages/cadre-core`'s
  devDependencies **was tried and reverted**: yarn re-resolves the new ranges to the newest matching
  versions, which bumped `datastore-core` 11.0.2 → 11.0.4 at the root and pulled in nested
  `@libp2p/logger@6.2.12` / `@libp2p/interface@3.2.5` — an unrelated dependency bump riding in on
  this ticket. The rationale and the "declare at exact versions if this ever breaks" instruction are
  in the spec's header comment. A reviewer may reasonably disagree and take the bump.
- **Coverage is per-sibling, not per-pass-shape.** No test drives two consecutive passes to check
  that a sibling merged in pass N and revoked before pass N+1 is not re-merged (the code path is the
  same `'skipped'` branch, just untested in sequence).

## Tripwires parked in the code

- `peer-addr-book.ts`, on `mergePeerAddrs` — the upstream `observed`-timestamp bug, what the
  workaround is, and the condition to drop it ("once upstream stamps `Date.now()` on merge").
- `cadre-node.ts`, on `warmSiblingAddrBook` — one record query per sibling per 15 s pass; batch the
  records into one query, or merge only on record change, if cadres ever grow large.
- `peer-addr-book.spec.ts` header — the undeclared-dependency decision above.

## Pre-existing failures (not this ticket's)

`tickets/.pre-existing-error.md` was written for two raw-storage operation-budget specs that fail
in `packages/cadre-core`:

- `test/control-start-storage-op-budget.spec.ts` (1983 ops vs a 1700 budget)
- `test/strand-solo-write-budget.spec.ts` (1979 ops vs a 1780 budget)

**Measured** as pre-existing, not assumed: `cadre-node.ts` was temporarily reverted to its `HEAD`
content and `peer-addr-book.ts` removed, the two specs re-run, and the identical counts (1983 /
1979) observed — then the ticket's files restored. Both scenarios are also solo-node, so the new
code (which runs only when siblings exist) cannot reach them. Neither spec is listed in
`tickets/.pre-existing-known.md`.
