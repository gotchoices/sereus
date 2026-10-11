description: After a phone restarts, its copy of a shared workspace reconnects to the other members only through a routing library that gives each reconnect attempt two seconds, which a slow relayed link cannot meet, so the two phones never reconnect and changes saved before the restart never reach the other side. Sereus should redial known members itself with the time budget it already uses for relayed connections.
prereq: strand-deferred-join-keeps-its-runtime
architecture: docs/strands.md#joining-no-writes-before-the-first-sync
files: packages/cadre-core/src/cadre-node.ts (refreshStrandPeerAddrs ~3405-3435 and its per-strand pass, mergeStrandPeerAddrs, remergeUnrecordedFormationAddrs ~6769, the "FRET reconnect from the address book" comment ~2568), packages/cadre-core/src/peer-dial.ts (dialPeerAddrs ~188), packages/cadre-core/src/link-budget.ts (relayedDialBudgetMs), packages/cadre-core/src/strand-network-state.ts, packages/integration-tests/src/scenarios/joiner-first-commit-over-slow-relay.integration.ts, ../Fret/packages/fret/src/service/fret-service.ts (MAINTENANCE_RPC_TIMEOUT_MS ~339, read-only)
repro: verified
----
# Strand peers are redialed only by FRET's 2-second maintenance ping

Found while answering why the phones in gotchoices/sereus#44 never delivered a joiner's write even after both apps restarted.

## What happens

Scratch arm of `joiner-first-commit-over-slow-relay.integration.ts`: the third arm's journey (20 ms `serial` frame cap, event loop 70% busy), then the joiner stops and is rebuilt over the storage it kept (raw stores, persisted strand network state, joined-strand record) with the slow link still in force. Two runs, same result:

- Both sides know each other: the joiner's saved network state holds the founder's strand peer with a signed address record, its rebuilt strand node's peer store has the founder's circuit address, and the founder holds the joiner's record too.
- Both sides try: under `DEBUG=libp2p:connection-manager:dial-queue*`, the joiner dials the founder's strand node and the founder dials the joiner's, every 6–30 s, for the whole 180 s window (32 failed attempts in one run, 20 by the joiner and 12 by the founder).
- Every attempt fails about 2.05 s after it starts. The first ones fail `NO_RESERVATION` (the founder's strand node had lost and was re-making its relay reservation); every one after that fails `EncryptionFailedError: This operation was aborted`, the Noise handshake over the relayed circuit cut off.
- The founder never gets the rows. Restarted on an undelayed link instead, the same joiner reconnects and the rows arrive 24.5 s after the restart began (now the committed fourth arm), so delivery after a restart works once the strand nodes reconnect.

## Why

The 2.05 s is FRET's: its maintenance pings (`sendPing` in `fret-service.ts`, three call sites) dial with `dial: true` under `MAINTENANCE_RPC_TIMEOUT_MS = 2000`, a whole-call budget that includes opening the connection. After a restart nothing else dials a strand peer: the launch seed is empty for a cross-party strand (the formation's carried addresses are in memory only, an accepted tradeoff on `CadreNode.formationStrandAddrs`, and the joiner's party has no sibling running the strand), so Optimystic's bootstrap contact has no one to dial, and cadre-core's strand address passes only merge addresses ("FRET reconnect from the address book as they do for any known peer", `cadre-node.ts` ~2568). A relayed dial on this link needed about 9 s the one time it succeeded, so no ping can ever open the connection. Sereus already derives relayed-dial deadlines from the declared link (`relayedDialBudgetMs`, 21.5 s at the default declaration; `optimysticDialLimits` gives libp2p 39 s per address), but none of those paths dials a strand peer.

FRET is a sibling repository and read-only from here; the upstream half is `blocked/fret-maintenance-ping-dial-budget-below-a-relayed-dial`. This ticket is the Sereus half and does not wait for it: phones fail now, and cadre-core is where the link declaration lives.

## Expected behaviour

A running strand node that holds no connection to any other strand member, while it knows at least one (its FRET table's peers with address records, the formation's carried addresses, the sibling seed), dials them itself with the declared-link budget, backing off between rounds, until one connects. Once a member is connected it stops; FRET and the existing paths take over. A machine that knows no member does nothing (a founder alone, a storage replica before anyone arrives).

## Design notes

- Natural home: the per-strand pass that already runs `refreshStrandPeerAddrs` (it knows the strand node, its FRET records and the formation addresses), or a small per-runtime supervisor started in `buildStrandRuntime` beside the relay supervisors. Whichever is chosen, it must stop with the runtime (quiesce, stop, revocation) and must not dial a peer the revocation enforcer has cut off.
- Dial with `dialPeerAddrs` (`peer-dial.ts`) and `relayedDialBudgetMs(config.network?.linkRoundTripMs)`, direct addresses before relayed ones as it already orders them.
- Backoff: start near the relayed-dial budget and double to a cap of a few minutes; a hibernating strand has no runtime, so this never wakes one.
- Count "connected to a member" from strand-peer connections, not the relay's: the relay is a peer of the strand node too.
- `NOTE:` at the site that if FRET's maintenance dial ever takes a link-derived budget, this supervisor becomes a backstop and may be deleted, the same way `peer-join-backfill.ts` says of itself.

## How to verify

Add the slow-restart arm to `joiner-first-commit-over-slow-relay.integration.ts`: the fourth arm's journey without releasing the busy loop and the frame cap before the restart, asserting the founder then holds the rows. Today it never converges (the 180 s gate expires; the arm takes about 7 minutes in all). With the fix it must pass. Decide whether it runs by default (cost) and record the decision in the scenario line of `docs/testing.md`.

`strand-deferred-join-keeps-its-runtime` landed and the joiner's first commit is still made alone: the harness relay cuts the founder-to-joiner circuit during the first join (its stock ping monitor; `backlog/debt-libp2p-nodes-built-outside-cadre-core-miss-the-ping-defaults`, third arm), and nothing redials the founder before the deferred database retry 5 s later makes the joiner writable. That is the state this ticket's supervisor covers (a running strand node with no member connected), so re-run the third arm once the redial is in; it passes only if the redial reconnects before that retry, or before the write.

If the joiner's first commit is no longer made alone, the arm needs another way to leave the founder without the rows at the moment of the restart (a write made after the founder's strand node is stopped, say, with the founder restarted first) — the subject here is reconnection after a restart on a slow link, not the solo commit.

## TODO

- Implement the redial (home, budget, backoff, stop conditions as above), with a `NOTE:` naming the FRET budget it compensates for.
- One unit test on the decision with real branching: dials when no member is connected and one is known, does nothing when a member is connected or none is known, backs off between failed rounds.
- Add the slow-restart arm described above; confirm it fails before the change and passes after.
- Update `docs/strands.md` (or `docs/architecture.md` where strand reconnection is described; grep "FRET reconnect") with one sentence on who redials a strand peer and on what budget.
- `yarn lint`, cadre-core tests and typecheck.
