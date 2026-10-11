description: A running strand node now redials the strand's other members itself whenever it is connected to none of them, giving each dial the time a relayed connection needs on the host's declared link, so two phones that restart on a slow relayed link reconnect and a change saved before the restart reaches the other side.
architecture: docs/strands.md#joining-no-writes-before-the-first-sync
files: packages/cadre-core/src/strand-peer-redial.ts (new), packages/cadre-core/src/strand-fret-addrs.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/test/strand-peer-redial.spec.ts (new), packages/cadre-core/test/fret-record-helpers.ts, packages/cadre-core/test/strand-instance-manager-*.spec.ts + strand-first-sync-gate.spec.ts + strand-scope-key-validation.spec.ts (fake nodes), packages/integration-tests/src/scenarios/joiner-first-commit-over-slow-relay.integration.ts, docs/architecture.md, docs/strands.md, docs/testing.md
----
# Strand peers redial on the declared link budget — review handoff

## What was wrong

After a restart, the only thing that redialed another member's strand node was FRET's maintenance traffic (pings and neighbour announcements in `../Fret/.../fret-service.ts`), which allows 2 000 ms per call with the connection opening included (`MAINTENANCE_RPC_TIMEOUT_MS`). A relayed dial on a slow link needs longer (about 9 s on a 20 ms frame cap with a 70%-busy event loop), so two restarted relay-only phones never reconnected and a write made alone before the restart never reached the other side (gotchoices/sereus#44). The upstream half stays `blocked/fret-maintenance-ping-dial-budget-below-a-relayed-dial`.

## What was built

`packages/cadre-core/src/strand-peer-redial.ts`: one loop per strand runtime, started in `StrandInstanceManager.buildStrandRuntime` right after the relay supervisors and stopped first in `releaseRuntime` (stop, quiesce, failed build), so a hibernating strand dials nobody.

Each look at the strand node:
- **A member is connected** (an open connection to a peer FRET labels `'member'`, or to a launch-seed peer) → do nothing; look again in `STRAND_REDIAL_CHECK_MS` (5 s), or at once when a peer disconnects. This look reads FRET's labels and the connection list only, with no signature verification (`strandFretMembership`, new in `strand-fret-addrs.ts`).
- **No member is connected and none is known** → do nothing (a founder alone, a replica before anyone arrives).
- **No member is connected, some are known** → dial every known member at once with `dialPeerAddrs` (direct addresses before relayed), `relayedDialBudgetMs(linkRoundTripMs)` per address (21.5 s at the default declaration), `CONTROL_COHORT_DIAL_ADDRESS_ATTEMPTS` × that per member. A round that connects goes back to watching. A round that reaches nobody waits a backoff that starts at the per-address budget and doubles to `STRAND_REDIAL_MAX_BACKOFF_MS` (5 min). A disconnect cuts a watching wait short, but never a backoff, so a flapping relay connection cannot turn the backoff into a dial per flap.

"Known" means peers the FRET table holds a verified signed record for, plus the launch seed (`config.bootstrapNodes`: sibling strand addresses and a formation's carried addresses). Never dialled or counted as members: the configured relays (excluded by peer id), any peer FRET labels `'foreign'`, and any peer the closed-strand revocation enforcer reports revoked. The relay matters because the strand node is connected to it throughout, and FRET files it with a signed record like any peer (adopted from identify). Only the `'foreign'` label tells it apart.

The `NOTE:` naming the FRET budget this compensates for is in the module header.

## Tests added

- `packages/cadre-core/test/strand-peer-redial.spec.ts` uses real signed FRET records and the real `dialPeerAddrs`; the node's `dial`, its connection list and the timers are doubles (the `TimeoutScheduler` seam). Four cases:
  - With only the relay connected (labelled `'foreign'`, record included), it dials the known member and not the relay. Once that member is connected it dials nothing more.
  - It dials nobody when every known peer is ineligible: a `'foreign'` relay, a relay excluded by id with no FRET label, and a revoked member.
  - Backoff between failed rounds goes 1 s, 2 s, 3 s (cap), 3 s, using a member known from the launch seed only. A connecting round resets it, so the next failure waits the minimum again.
  - A disconnect while watching triggers a look and a dial at once. A disconnect during a backoff does nothing.
- `joiner-first-commit-over-slow-relay.integration.ts`, new fifth arm `…restarts over its kept storage, still on the slow link`: the fourth arm's journey without lifting the frame cap and the busy loop before the restart. It runs by default (about 95 s), recorded in `docs/testing.md`, because it is the only end-to-end check of the redial.

Ten specs that stub `createLibp2pNode` with bare objects got an inert `peerId` / `getConnections` / `addEventListener` / `removeEventListener`, since the loop now starts on every runtime. They are inlined per file because the fakes live inside `vi.hoisted` blocks.

## Validation run

- Fifth arm before the change: failed at its 180 s gate (255.5 s for the arm). After: passed three times, with the founder holding the joiner's rows 45.5 to 45.7 s after the restart began (about 96 s for the arm). The debug log (`DEBUG=sereus:cadre:strand-redial`) shows `reconnected to a member` just before the rows land.
- Whole scenario file: 4 passed + 1 expected fail, 456 s. Arm timings: loopback 3.4 s, 100 ms 28 s, third 231 s, fourth 86 s, fifth 96 s.
- cadre-core: typecheck clean and 162/162 files pass (2430 tests). An earlier full run lost two files to a vitest pool IPC error (`write UNKNOWN`, Windows child-process pipe), with no test failures; a verbose re-run was clean.
- `yarn lint` clean, integration-tests typecheck clean.
- Integration scenarios re-run with the redial in: `strand-removal-cuts-network`, `strand-relay-only-restart-reconverges` (both arms, plus its opt-in `RESTART_NEGATIVE_CONTROL=1` arm, which still never reconverges), `blind-relay-phone-to-phone-e2e`, `strand-party-removal-via-formation-e2e`, `strand-formation-cross-party-seed`, `strand-two-party-two-machine`, `strand-membership-closed-strand-e2e`, and both `strand-always-on-replica-*` scenarios. All pass.
- Not run: the rest of the integration suite (67 scenarios, beyond an agent run's wall clock).

## Known gaps and things to look at

- **The third arm still commits alone (stays `it.fails`).** Measured with debug logging: when the harness relay's ping monitor cuts the circuit, both strand nodes' loops dial at once. The dials fail within milliseconds (`ConnectionClosedError: The connection muxer is "closed"`, `UnexpectedEOFError`), so each loop waits the full 21.5 s backoff. The deferred database retry makes the joiner writable about 8 s after the cut, with only the relay connected. Parked as a `NOTE:` on `nextBackoff` (retry a round that failed that fast after a short delay, if reconnecting within seconds ever matters). Even then the founder's strand node must first re-reserve on the relay (its supervisor checks every 5 s), so the 8 s window may not be winnable this way. The scenario header now describes this instead of "nothing redials the founder".
- **A self-revoked node keeps redialing** the remaining members every backoff. Their gates refuse it; FRET's maintenance does the same. A one-line skip when `isRevoked(self)` would stop it. I left it out because the ticket did not ask for it and it would need its own test.
- **Seed is the launch seed only.** A re-formation while the strand runs merges new carried addresses into the peerStore (`recordFormationStrandAddrs`), but the loop keeps the seed it was built with until the runtime is rebuilt. The loop also never reads peerStore addresses, only verified FRET records and that seed.
- **Dial load from departed members.** A member FRET still holds a record for (up to 14 days after it was last confirmed) is dialed every 5 min while no other member is connected, for example a founder whose only joiner left. This is stated on `STRAND_REDIAL_MAX_BACKOFF_MS`.
- **Both sides dial each other** after a cut or restart. No simultaneous-open trouble was seen, and libp2p's dial queue joins concurrent dials to one peer, so a redial joining a FRET dial keeps the job alive past FRET's 2 s signal (the job aborts only when every joiner has aborted).
- The control-node comment at `cadre-node.ts` ~2568 ("the connection manager and FRET reconnect from the address book") is about control bootstrap peers and was left alone.
