description: A node no longer gives up on a peer because the first few addresses it tries never answer: each address now gets its own short time limit, and the phone's "borrow a node" flow keeps dialing until its whole wait runs out.
files:
  - packages/cadre-core/src/peer-dial.ts
  - packages/cadre-core/src/cadre-node.ts
  - packages/cadre-core/src/seed-bootstrap.ts
  - packages/cadre-core/src/strand-wake-protocol.ts
  - packages/cadre-core/src/control-cohort.ts
  - packages/cadre-core/src/types.ts
  - packages/cadre-core/src/index.ts
  - packages/cadre-core/test/peer-dial.spec.ts
  - packages/cadre-core/test/silent-server.ts
  - packages/cadre-core/test/cadre-node-dial-past-dead-addresses.spec.ts
  - packages/cadre-core/test/cadre-node-control-cohort.spec.ts
  - packages/reference-app-rn/src/host-node-request.ts
  - packages/reference-app-rn/test/host-node-request.spec.ts
  - docs/architecture.md
  - docs/reference-app-rn.md
----

# One unreachable address no longer stops a peer dial

## What landed

On a device run, borrowing a node from a cadre-host always stalled at "Connecting to the node…". `CadreNode` handed a peer's whole address list to one `libp2p.dial(addrs)` under one deadline; libp2p 3.1.3 tries those addresses one at a time with no per-address limit and sorts loopback last, so LAN addresses the host's firewall silently dropped used up the deadline before the working forwarded loopback address was tried.

- `peer-dial.ts` (new): `dialPeerAddrs` dials each address as its own `dial()` under `perAddressMs` (default 8 s) inside `totalMs` for the peer (default 30 s, was 20 s), direct addresses before `/p2p-circuit` ones, and throws one error naming every address. The loop, `tryAddrsInTurn`, waits one macrotask between attempts, because libp2p's dial queue otherwise lets the next dial join the aborted job and fail without touching the network. `dialWake` reuses the loop.
- Callers: the reconcile pass's sibling and cold-start dials, `SeedBootstrapService.applySeed` owner dials (previously only the first address, unbounded) and `dialInvite`. Configurable via `network.controlCohort.perAddressDialTimeoutMs` / `dialTimeoutMs`.
- Phone flow (`connectToNode`): the 60 s `connectMs` (was 30 s) counts from before the first pass, and a new pass starts whenever one ends without a connection; a throwing pass is reported, not retried.

Validation from implement: cadre-core 2143 tests, reference-app-rn 303, and six integration scenarios (including `cadre-host-donation-phone-requester` and `enrollment-e2e`) passed. Not yet re-run on the physical device (Galaxy Note 9 over `adb reverse`); that remains the real acceptance check.

## Review findings

Checked: the full implement diff (`db9a4a1`) — `peer-dial.ts`, every caller, `dialWake` refactor, config/type docs, exports, the phone flow's pass driver, all new and changed tests, and `docs/architecture.md` / `docs/reference-app-rn.md`. Also traced who awaits `applySeed` (inbound seed stream handler, cadre-cli `POST /seed`, cadre-host donation `PUT /grants/:id/seed`, phone `putSeed`) to see whether the longer owner dials change anyone's timing.

Correctness: no defects found. The per-address/total limit arithmetic, "not tried" reporting, abort of an overrunning attempt's signal, single-address error passthrough, and empty-list handling are right and covered by `peer-dial.spec.ts`. `reconcilePasses` cannot run two passes at once and its late rejection is always handled. `applySeed` with all-malformed or empty owner addresses fails fast and is counted as a failed owner dial, same as before.

Fixed inline (minor):
- Error wording. Every caller passed a label ending in "via", so the combined error read "reconcileControlCohort dial of sibling X via failed for all 3 candidate addresses" and the not-tried entry "the 30000ms Owner dial of X via budget…". `tryAddrsInTurn` now adds " via <addr>" itself; labels are plain (`cadre-node.ts`, `seed-bootstrap.ts`, `peer-dial.spec.ts`). Wake timeouts now read "Wake dial via <addr> timed out…"; nothing asserted the old form.
- `docs/architecture.md` cold-start bullet still said libp2p "drops addresses the node has no transport for before dialing" (the multi-address behaviour); reworded to the per-address dial.

Tripwire (parked as `NOTE:` at `seed-bootstrap.ts` owner-dial loop in `applySeed`): `handleSeedStream` acks only after the owner dials, so an unreachable owner can now hold the ack up to 30 s each, past the sender's 10 s `seedDeliverTimeoutMs`. The seed is still applied; only the sender's report would be wrong. The HTTP seed paths have no short timeout, and the donation integration scenario passes.

Accepted as documented by implement (no new ticket): the 8 s per-address default is reasoned not measured (NOTE on the constant); a working address behind four or more dropped ones still fails every pass (remedy named in the constant's doc); the macrotask wait depends on libp2p internals, pinned by real-libp2p specs; `applySeed` does not bind owner addresses to `/p2p/<peerId>` (pre-existing, unchanged here).

Tests: no gaps worth adding. `applySeed`'s multi-address behaviour has no dedicated unit test, but it is a direct call into `dialPeerAddrs`, which the real-libp2p specs cover, and `enrollment-e2e` exercises `dialInvite`.

Hygiene: `peer-dial.ts` is 214 lines with short functions; comments are long but each states a behaviour a reader needs. `control-cohort.ts` keeps a three-line pointer to where the moved constant lives — fine.

Runs after the review edits: `yarn workspace @serfab/cadre-core typecheck` clean; eslint on the four edited files clean; `yarn workspace @serfab/cadre-core test` 132 files, 2143 passed, 1 skipped; `yarn workspace @serfab/cadre-core build` then `yarn workspace @serfab/reference-app-rn test` 19 files, 303 passed. Integration scenarios were not re-run: the review edits change only error text, a comment and a doc sentence.
