description: A joiner's formation used to dial only the first address in the invitation, so one dead relay failed the join even when the inviter was reachable another way. It now tries every address; review that change.
architecture: docs/architecture.md#strand-formation
files: packages/cadre-core/src/strand-formation-protocol.ts (FormationDialOptions.responderAddrs doc, openFormationStream, parseResponderAddrs, describeAllAddressesFailed, dialFormation), packages/cadre-core/test/strand-solicitation.spec.ts (describe "StrandFormationManager transport: real disclosure + result validation"), docs/architecture.md (Strand Formation, paragraph after the timeouts paragraph), .release-notes.pending.md
----
# Formation dial tries every invitation address — review handoff

Found while analysing gotchoices/sereus#25. `CadreNode.createOpenInvitation` puts every address the inviting node has into `invitation.bootstrap` (a phone with reservations on two relays gets two circuit addresses), but `dialFormation` dialed only `responderAddrs[0]`. A dead first relay failed the join.

## What changed

- `dialFormation` (`strand-formation-protocol.ts`) parses every `responderAddrs` entry through the new `parseResponderAddrs`, which skips (and logs at debug) any entry that does not parse and throws the existing `'No responder addresses available for formation'` only when none parse. The old `length === 0` check is subsumed by it.
- `openFormationStream` now takes `Multiaddr[]` and passes the whole list to `node.dialProtocol` in one call. libp2p 3.1.3's dial queue sorts them (direct before circuit), drops ones it has no transport for, and tries them one after another under the single abort signal from `withDeadline`, so the whole list shares the one `dialMs` budget and the deadline ladder (`formationDeadlines`) is untouched.
- When every address fails, libp2p throws `AggregateError('All multiaddr dials failed')`. `describeAllAddressesFailed` rethrows it as `Error('Formation could not reach the inviter at any of the N addresses tried: <msg1>; <msg2>')` with the `AggregateError` as `cause`. N is the number of addresses libp2p actually tried, which can be fewer than the invitation listed. A single-address failure is rethrown by libp2p unwrapped and passes through unchanged; the dial-deadline timeout message is unchanged.
- `NOTE:` tripwire on `openFormationStream`: an address that hangs without answering spends the whole shared dial budget before the next is tried. Revisit (per-address sub-budgets or a parallel dial) if joins through a hung first relay are seen in practice.
- Docs: one paragraph in `docs/architecture.md` → Strand Formation, right after the timeouts paragraph. Release note added to `.release-notes.pending.md`.
- Mixed peer ids in the list are deliberately not handled: libp2p throws `'Multiaddrs must all have the same peer id or have no peer id'`, which only a tampered or hand-built invitation can cause (per the ticket).

## Tests

- Added `'forms through a later bootstrap address when the first is unreachable'` in `strand-solicitation.spec.ts` (real libp2p over TCP): the invitation lists a refused `127.0.0.1:1` address first, then the responder's real ones; formation must succeed. This is the ticket's verified reproduction (failed at HEAD with `ECONNREFUSED 127.0.0.1:1`).
- The mock-node `dialFormation` tests in `strand-formation-protocol.spec.ts` needed no change (their `dialProtocol` ignores the address argument) and pass.
- Not kept as tests, but checked once with a throwaway real-libp2p test that was then removed: (a) `['not a multiaddr', dead:1, dead:2]` → `"Formation could not reach the inviter at any of the 2 addresses tried: connection error 127.0.0.1:1: connect ECONNREFUSED 127.0.0.1:1; connection error 127.0.0.1:2: connect ECONNREFUSED 127.0.0.1:2"` with `cause` an `AggregateError` (wording later changed from "on any of its N addresses" to "at any of the N addresses tried"; the code path is the same); (b) a single dead address → libp2p's own `connection error 127.0.0.1:1: …` unchanged; (c) `['junk']` → `'No responder addresses available for formation'`. The reviewer may decide the error restatement deserves a pinned test; I left it out under the "one test per behaviour, default no new test" rule since it is message formatting.

## Validation run

- `yarn workspace @serfab/cadre-core test`: 147 files, 2344 passed, 1 skipped (that skip was already there).
- `yarn lint`: clean. `npx tsc --noEmit` in `packages/cadre-core`: clean.

## Known gaps / things for the reviewer

- The hung-address case (black-holed relay) is not covered; it is the recorded tripwire, not a fix.
- `instanceof AggregateError` relies on the global `AggregateError`, which libp2p itself constructs; on a runtime without it libp2p would fail first. Worth a glance for React Native (Hermes) if that is a concern.
- Related, not a dependency: `plan/durable-pending-join` (gotchoices/sereus#25) adds retry around the whole join; this ticket only makes one attempt use every address.
