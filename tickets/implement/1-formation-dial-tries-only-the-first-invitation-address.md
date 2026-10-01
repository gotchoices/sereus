description: A joiner's formation dials only the first address in the invitation's bootstrap list, so one dead relay fails the join even when the inviter is reachable through another. Make the dial try every address.
architecture: docs/architecture.md#strand-formation
files: packages/cadre-core/src/strand-formation-protocol.ts (dialFormation ~767, openFormationStream ~751), packages/cadre-core/test/strand-solicitation.spec.ts (describe "StrandFormationManager transport: real disclosure + result validation" ~380), .release-notes.pending.md
repro: verified
----
# Formation dials only the first invitation address

Found while analysing gotchoices/sereus#25.

`CadreNode.createOpenInvitation` (`cadre-node.ts` ~8037) puts every address the inviting node has into `invitation.bootstrap`, so a phone with reservations on two relays gets two circuit addresses. `StrandFormationManager.formStrand` passes that list as `responderAddrs`, and `dialFormation` (`strand-formation-protocol.ts` ~779) does `multiaddr(options.responderAddrs[0])` and never looks at the rest. If that relay is down, or the reservation on it has lapsed, the join fails although the inviter is reachable through the second relay.

## Reproduction (verified)

Added temporarily to the real-libp2p describe block in `packages/cadre-core/test/strand-solicitation.spec.ts` (the one whose `beforeEach` starts `nodeA`/`nodeB` over TCP), next to `'delivers the responder real cadre addresses to the initiator (no placeholders)'`:

```ts
it('forms through a later bootstrap address when the first is unreachable', async () => {
  const goodAddrs = nodeA.getMultiaddrs().map(ma => ma.toString());
  const deadAddr = `/ip4/127.0.0.1/tcp/1/p2p/${nodeA.peerId.toString()}`;
  const responder = new StrandSolicitationService({
    partyId: 'responder-party',
    cadrePeerAddrs: goodAddrs,
    strandProvisioner: { provisionStrand: async () => ({ strandId: 'strand-second-addr' }) }
  });
  await responder.registerResponder(nodeA);
  const invitation = await responder.createOpenInvitation('test-sapp', 60000, [deadAddr, ...goodAddrs]);
  const initiator = new StrandSolicitationService({
    partyId: 'initiator-party',
    cadrePeerAddrs: nodeB.getMultiaddrs().map(ma => ma.toString())
  });
  const result = await initiator.formStrand(invitation, { purpose: 'second-addr' }, nodeB);
  expect(result.strandId).toBe('strand-second-addr');
  await responder.unregisterResponder(nodeA);
}, 15000);
```

Run from `packages/cadre-core`: `yarn vitest run test/strand-solicitation.spec.ts -t "first is unreachable"`. At HEAD it fails in ~190 ms with `Error: connection error 127.0.0.1:1: connect ECONNREFUSED 127.0.0.1:1`. The test was removed again so the tree stays green; add it back as the regression test.

## Fix (hypothesis checked)

Hand libp2p the whole list in one dial. `Libp2p.dialProtocol` accepts `Multiaddr[]`; libp2p 3.1.3's dial queue (`node_modules/libp2p/src/connection-manager/dial-queue.ts`, `dialPeer`) sorts the addresses (direct before circuit), drops ones it has no transport for, and tries them **one after another under the single abort signal we pass**, returning the first connection. Changing `dialFormation` to `options.responderAddrs.map(a => multiaddr(a))` and `openFormationStream`'s `addr` parameter to `Multiaddr[]` made the reproduction pass. That edit was reverted; the implementer applies it properly.

Deadlines stay as they are: `formationDeadlines` sizes the session as `dialMs + initiatorAwaitResponseMs`, so the whole address list shares the one `dialMs` dial-connect budget (`openFormationStream`'s `withDeadline`), and the await-response budget is untouched. Most dead-address failures are fast (connection refused, or a relay answering "no reservation"), so later addresses still get tried. The case that is not covered: an address that hangs without answering (a black-holed relay host) consumes the whole dial budget before the next is tried. Giving each address its own `dialMs` would make the session overrun or shrink the await-response budget, so leave the shared budget and record the limitation as a `NOTE:` tripwire at `openFormationStream` (revisit if joins through a hung first relay are seen in practice; then per-address sub-budgets or dialing in parallel).

Two input-shape points, since the bootstrap list comes from a stranger's invitation:

- **Malformed entries.** `multiaddr()` throws on an unparseable string. Today only entry 0 is parsed; after the change every entry is. Skip an entry that does not parse (log it), and throw the existing `'No responder addresses available for formation'` only when none parse — one bad entry must not fail an otherwise good list.
- **Mixed peer ids.** libp2p's `getPeerAddress` throws `'Multiaddrs must all have the same peer id or have no peer id'` when entries name different peers. A real invitation carries one node's own addresses, so this only happens with a tampered or hand-built invitation; letting that error propagate is acceptable. Do not add handling for it.

## Failure message

When every address fails, libp2p throws `AggregateError('All multiaddr dials failed')` with the per-address errors in `.errors`. That message alone names nothing. Catch it in `dialFormation` (or `openFormationStream`) and rethrow an `Error` whose message says formation could not reach the inviter on any of its N addresses and includes each underlying error message (they already name host:port), with the `AggregateError` as `cause`. A single-address failure still surfaces libp2p's own error unchanged (libp2p rethrows it unwrapped when only one address was tried). The dial-deadline timeout message (`Formation dial-connect timed out after …ms`) is unchanged. Nothing in the repo matches on the old message text (checked with grep for `All multiaddr` / `Formation dial` across `packages/`).

Related, not a dependency: `plan/durable-pending-join` (gotchoices/sereus#25) adds retry around the whole join; this ticket only makes a single attempt use every address.

## TODO

- Change `dialFormation` to parse every `responderAddrs` entry (skipping and logging unparseable ones) and pass the `Multiaddr[]` to `openFormationStream`; update `openFormationStream`'s parameter type and the `FormationDialOptions.responderAddrs` doc comment ("tried in libp2p's order until one connects, under one dial-connect budget").
- Wrap the all-addresses-failed `AggregateError` in a message that lists each address's error, keeping it as `cause`.
- Add the `NOTE:` tripwire at `openFormationStream` about a hung address consuming the shared dial budget.
- Add the reproduction above as the regression test in `strand-solicitation.spec.ts` (one test; the mock-node `dialFormation` tests in `strand-formation-protocol.spec.ts` need no change since their `dialProtocol` mock ignores its address argument — confirm they still pass).
- Update `docs/architecture.md` → Strand Formation if it describes which bootstrap address is dialed (one sentence: every invitation address is tried, sharing the dial budget).
- Add a line to `.release-notes.pending.md`: a join now tries every address in the invitation, so one unreachable relay no longer fails it, and the all-addresses-failed error names each address's failure.
- Run `yarn workspace @serfab/cadre-core test` (or at least the two formation spec files) and `yarn lint`.
