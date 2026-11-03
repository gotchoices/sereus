description: After a phone adds an always-on node to its cadre, the phone's shared workspace stays unconnected to that node for about a minute, so everything saved in that minute lands on the phone alone. The phone asks the node for its workspace address while the node is still restarting, the ask fails, and the next ask is a full minute later.
architecture: docs/architecture.md#strand-address-resolution
files: packages/cadre-core/src/cadre-node.ts (`STRAND_PEER_ADDR_RETRY_MS` ~262, `refreshStrandPeerAddrs` ~7812, `askSiblingsForStrandAddrs` ~8007, `redialClaimedNode` ~10160), packages/cadre-core/src/control-cohort.ts (`nextReconcileWakeMs`), packages/cadre-core/src/strand-addr-protocol.ts, packages/integration-tests/src/scenarios/node-claim-by-phone.integration.ts, packages/integration-tests/src/scenarios/strand-addr-seed-convergence.integration.ts, docs/architecture.md (Strand-Address Resolution)
repro: verified
----
# A failed strand-address ask right after a claim costs a minute of solo commits (gotchoices/sereus#56)

## What the reporter measured

A phone-shaped node (no listen addresses, offline mode on) claims a cadre-cli node. The result is the same on Sereus 1.19.1 with Optimystic 1.20.1 and on Sereus 1.20.0 with Optimystic 1.23.0 (Node 24, one machine). The issue carries a self-contained script, `strand-unconnected-repro.mjs`, that takes about 100 s. We have not re-run it on 1.21.0.

```
[   7.5s] node 1 claimed; its strand started
[   7.7s] +0s    strand connections 0; commit cohort 1, heldElsewhere false
   …      +10s … +50s: the same
[  69.4s] +60s   strand connections 1; commit cohort 2, heldElsewhere true
solo-cohort commits: 58
```

With `DEBUG=sereus:cadre:strand*`:

```
16:45:44 strand-addr  Strand-addr dial to <node> via <node> failed: UnexpectedEOFError: Unexpected EOF - stream closed while reading 0/1 bytes
16:45:45 strand-addr  Strand-addr dial to <node> via <node> failed: StreamStateError: Cannot write to a stream that is closed
16:46:45 strand-addr  Strand-addr response: ok, 4 addr(s) for <strand>
```

## Why the code does this (read from the source, 2026-11-03; the sequence is inferred, not traced)

- A claimed node restarts into the party right after it acknowledges the claim. Asks made during that restart fail, as the two log lines show.
- `askSiblingsForStrandAddrs` gives any outcome other than an answer one flat retry, `STRAND_PEER_ADDR_RETRY_MS` (60 s), and `nextReconcileWakeMs` wakes the reconcile pass for that due time.
- Pruning the due time on a disconnect gives a reconnected sibling one prompt ask. That ask is probably the second failure above. Nothing else is due after it, so nothing happens for 60 s.
- While the ask is unanswered the phone cannot name the node's strand peer. A strand peer id derives from the node's private identity key (`strandTransportKey`), so it cannot be computed from the control rows, and the strand's redial loop (`strand-peer-redial.ts`) has no member to dial.

The flat retry is the one site that decides this delay. `redialClaimedNode` already handles the same restart for the control connection, in steps across `CONTROL_COHORT_REDIAL_MS`. The strand-address ask has no equivalent.

## Expected behaviour

A sibling's failed strand-address ask is retried soon after the failure and backs off to the existing bound, so a restarting sibling is reached within seconds of its strand serving. A sibling that stays down costs no more than one failed ask per `STRAND_PEER_ADDR_RETRY_MS` once the backoff saturates. A sibling answering `unavailable` because its strand is not up yet is covered by the same retry.

An `ok` with no addresses (`empty`) waits the full ten-minute refresh interval today. Check whether a restarting node can give that answer, because that would be a ten-minute version of this defect.

## Not in this ticket

Offline mode committing alone during such a window, and a commit made alone reporting nobody owed, are `plan/offline-mode-holds-writes-for-party-machines-it-cannot-reach`. So is a node with its control port reachable and its strand port firewalled: this ticket shortens the wait but cannot connect a strand whose port is closed.

## Reproducing

Prefer an arm in `node-claim-by-phone.integration.ts` over a new scenario: after a claim, the phone's strand connects to the node well inside 60 s. It needs a real restart, since the failure comes from the claimed node closing its connections. `nextReconcileWakeMs` is pure, if the retry timing needs a unit-level pin.

## TODO

- Reproduce with the issue's script or a scenario arm, on the current linked Optimystic
- Replace the flat retry with a backoff per (sibling, strand) that resets on an answer
- Check whether a restarting node can answer `empty`, and handle it if so
- Update the constant's doc comment and docs/architecture.md → Strand-Address Resolution
