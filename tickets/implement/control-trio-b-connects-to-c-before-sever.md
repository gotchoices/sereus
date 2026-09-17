description: Two three-machine tests assume that nothing except the cohort reconcile routine can connect machine B to machine C, but the routing layer can learn C's address and dial it on its own, so the tests fail at random. The test harness needs a switch that blocks B from dialling C until the test deliberately allows it.
prereq: isolated-node-reads-unwritten-revocation-table-as-empty
files: packages/integration-tests/src/harness/control-trio.ts, packages/integration-tests/src/scenarios/control-cohort-edge-carries-data.integration.ts, packages/integration-tests/src/scenarios/control-cohort-three-node-isolation.integration.ts, packages/integration-tests/src/harness/node-fixtures.ts, packages/cadre-core/src/cadre-node.ts, ../optimystic/packages/db-p2p/src/cluster/service.ts, ../optimystic/packages/db-p2p/src/peer-address-book.ts, ../Fret/packages/fret/src/service/fret-service.ts
difficulty: medium
repro: verified
----

# The control trio's "only reconcile can connect B to C" premise is false

## What was measured (2026-09-16)

9 runs of `control-cohort-edge-carries-data.integration.ts`. The only change was temporary instrumentation: B's connection gater logged a stack trace for every dial, and B's peerStore `merge`/`patch`/`save`/`consumePeerRecord` plus `connection:open`/`connection:close`/`peer:disconnect` were wrapped to log. Results: 3 passed. 3 failed at the first window checkpoint (`expect(openControlConnections(B)).toHaveLength(0)`). 3 timed out at the boot gate `B resolves C's signed CadrePeer address record`, which is tracked separately by `control-peer-row-refresh-invisible-to-third-node` (blocked). The pre-sever `:217` arm did not recur in these 9 runs. The instrumented runs had to use a scratch vitest config without `globalSetup`, because `../optimystic` had someone else's uncommitted edits in `quereus-plugin-optimystic` and the stale-build guard refused to run. Logs, until pruned: `tickets/.logs/b2c-trace1.log` (dial stack only) and `tickets/.logs/b2c-trace9.log` (full trace).

In every connection failure, the full chain on B was the same (trace9 timestamps):

1. **C's address enters B's address book from an optimystic cluster record, not from reconcile.** A coordinates a control write whose cohort includes C and sends the `update` to B. `ClusterService.processOperation` → `learnPeerAddresses` → `mergeRecordPeerAddresses` → `peerStore.merge(C, /ip4/127.0.0.1/tcp/<port>/ws)` (`../optimystic/packages/db-p2p/src/cluster/service.ts` ~224-256). This happened ~1.5 s after C started, during boot steps 4-6. It is a deliberate production feature: the comment says a cluster record "is often the only place a relay-only sibling's address ever reaches us". It runs only when the record's peer map includes C with addresses, which depends on timing. In the passing run 4, B's peerStore got no C address until reconcile dialled.
2. **The sever makes FRET dial C.** `hangUp(A)` → `peer:disconnect A` → FRET's `peer:disconnect` handler (`../Fret/packages/fret/src/service/fret-service.ts` ~1133-1147) sees A was a near ring neighbour → `announceOnDeparture` → `announceTargetsAround` prefers ring members that are **not connected but have addresses**, which now includes C → `sendAnnouncementsRateLimited` → `announceNeighbors(..., { dial: true })` → `libp2p.dialProtocol(C)` → dial queue loads C's address from the peerStore → outbound B→C connection, 1 ms after the disconnect.

Stack from `b2c-trace1.log`, for the record:

```
denyDialPeer <C>
  membership-connection-gater.ts:387 denyDialPeer
  dial-queue.js calculateMultiaddrs / dialPeer
  Libp2p.dialProtocol
  fret rpc/protocols.js openRpcStream → rpc/request.js rpcRequest
  fret rpc/neighbors.js announceNeighbors
  FretService.sendAnnouncementsRateLimited
  FretService.announceOnDeparture
```

This accounts for all three arms in the original ticket:
- **window checkpoint**: the sever itself triggers the dial (observed 3 of 3 times).
- **post-sever wait never reaches zero connections**: the same dial, still in flight or landing right after the hang-up (inferred; same timing).
- **`:217` before the sever** (not reproduced this session, `static`): FRET has other paths that dial addressed ring members that are not connected (`announceToNewPeers`, the post-bootstrap `announceNeighborsBounded`, stabilization pings, departure handling after any earlier `peer:disconnect`). Any of them dials C once step 1 has put C's address in B's peerStore. Confirm with the same instrumentation if it matters. The fix below covers every opener.

The `self:peer:update`-triggered reconcile, which the scenarios' `NOTE:` comments name as the first suspect, did not appear in any trace. Every B→C dial stack was FRET's.

## Why this is a harness defect, not a product bug

Both behaviours are intended: optimystic learns cohort addresses from cluster records, and FRET announces to addressed ring neighbours. In production, B *should* connect to C through these paths. The false part is the scenarios' premise, stated in two places:

- `control-cohort-edge-carries-data.integration.ts` header, "WHY THE NEGATIVE WINDOW CANNOT ACCIDENTALLY FORM B↔C": "B's peerStore holds no address for C … The only component that can turn C's signed record into a dialable address is `CadreNode.resolveControlDialAddrs`".
- `control-cohort-three-node-isolation.integration.ts` negative-window comment: "FRET stabilization learns C's peer id … but its `dialProtocol(peerId)` has no address to use". This scenario has no sever, so the departure path does not fire there, but its `expect(await peerStoreAddrsFor(B, cPeerId)).toHaveLength(0)` checkpoints (~lines 130 and 143) fail whenever step 1 happens. The same scenario is exposed to the other FRET dial paths.

So "B's peerStore holds no address for C" is not something the harness can guarantee, and the proof that "nothing else dialled C" cannot rest on it.

## Fix: a harness-owned dial gate from B to C

Put the isolation into the harness, where the scenario can assert it, instead of relying on production subsystems not having an address:

- `bootControlTrio` already derives `cPeerId` before B starts. Always compose a **C-dial gate** into B's `connectionGater`, alongside the optional `gaterB`. It denies `denyDialPeer`, `denyDialMultiaddr` (last `/p2p/` component) and `denyOutboundConnection` for C while closed, and counts denials. It starts **closed**. Composition: a hook denies if either gater denies. Moving `severableDialGater` from the edge scenario into the harness, generalised to a set of denied peers, is one DRY way to do this.
- Expose it on `ControlTrio`, for example `dialsToC: { allowDuring<T>(fn: () => Promise<T>): Promise<T>; deniedCount(): number }`. `allowDuring` opens the gate only while `fn` runs, and closes it again in `finally`. Opening permanently is not needed: once B↔C exists, later FRET or transactor dials reuse it.
- Both scenarios wrap each `B.reconcileControlCohort()` call in their "reconcile dials C" poll with `dialsToC.allowDuring(...)`.

"Reconcile is what formed the link" still needs proof, because a FRET dial could land inside the brief allowed window. Pick one of these:
  - **Recommended:** have `reconcileControlCohort` resolve to a small pass summary (for example `{ dialed: string[] }`, the peer ids `dialControlSibling` connected this pass). The log line at `cadre-node.ts` ~2820 already computes the count. The scenario then asserts that some pass reported dialling C. If FRET won the race, reconcile skips C as already connected and the assertion fails, so the check stays strict. Check other callers: the timer and `self:peer:update` wrappers `void` the promise, and any `await B.reconcileControlCohort()` in other scenarios still compiles.
  - Lighter: keep the current `passes > 0 && hasOutboundTo` check and document in a `NOTE:` that a FRET dial landing inside the allowed window would pass falsely. This is weaker. Use it only if the API change is rejected.

Assertion changes. Do not loosen the connection assertions; they stay exactly as they are:
- Keep every `connectionsTo(B, cPeerId)` / `openControlConnections(B)` zero-connection checkpoint. They now hold by construction until the gate opens, and a failure means something bypassed the gate, which is a real finding.
- **Replace** the `peerStoreAddrsFor(B, cPeerId)` empty checkpoints in both negative windows. They assert something production legitimately breaks. Decide per site: drop the check, or turn it into an informational count. Do **not** assert that it is non-empty, because that is timing-dependent too. Keep the boot-time check in `control-trio.ts` step 3 ("peerStore holds no addresses for C before C was vouched"). It is still true: no record can name C before A vouches it.
- Add `expect(dialsToC.deniedCount())` only if a run shows it is reliably greater than zero. Otherwise leave it out, since whether FRET even tries depends on step 1.
- Rewrite the premise prose in both scenario headers and in `control-trio.ts`'s header: the gate, not an empty address book, is what keeps other subsystems from dialling C, and the two production paths above are named as the reason the gate is needed. Remove or update both "first suspect is a `self:peer:update`-triggered reconcile" `NOTE:`s. Any such pass is now denied by the gate outside `allowDuring`, and it was not the opener.

Edge scenario detail: the sever gate (deny A) and the C gate must coexist. After the sever, A stays denied permanently and C is allowed only inside `allowDuring`. Step 7's invariant ("every open connection B holds is to C") and the "same connection id" check are unaffected.

Out of scope: the boot gate timeout (`control-peer-row-refresh-invisible-to-third-node`) and the boot-wait contention ticket `debt-control-trio-boot-wait-is-contention-sensitive`. Both touch `control-trio.ts`, but at different steps.

## Running the scenario

`yarn vitest run src/scenarios/control-cohort-edge-carries-data.integration.ts` from `packages/integration-tests`. The global stale-build guard fails if any linked `../optimystic` package has source edits newer than its build. Do not rebuild someone else's uncommitted optimystic work. Report the block, or use a temporary vitest config without `globalSetup` for diagnosis only, and delete it afterwards. Expect about 1 in 3 runs to hit the unrelated boot-gate timeout above. Judge the fix on the runs that get past boot.

## TODO

- Add the closed-by-default C-dial gate to `bootControlTrio`, composed with `gaterB`, and expose `dialsToC` (`allowDuring`, `deniedCount`) on `ControlTrio`. Consider moving `severableDialGater` into the harness to share the gater code.
- Make `reconcileControlCohort` return a pass summary of the peers it dialled (recommended), update its doc comment, and check other callers compile. Or take the lighter option and add a `NOTE:`.
- Edge scenario: wrap the step-6 reconcile call in `allowDuring`, assert that a pass reported dialling C, replace the window's peerStore checkpoint, and rewrite the "WHY THE NEGATIVE WINDOW…" header section and the step-4 `NOTE:`.
- Isolation scenario: the same changes (wrap reconcile, assert dial-by-reconcile, replace both peerStore checks, rewrite header and window comment and `NOTE:`).
- Update `control-trio.ts` header prose (step 6: "B knows C's address but has never connected to it", which now holds because of the gate).
- Run both scenarios several times each; record the pass count and any non-boot-gate failure in the review handoff. Run `yarn lint` and the integration-tests typecheck.
- If `docs/testing.md` describes these scenarios' isolation argument, update it.
