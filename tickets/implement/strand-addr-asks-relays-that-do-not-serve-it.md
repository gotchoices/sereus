description: Every time a node starts or joins a shared workspace, it first asks each of its relays to let that workspace's network identity in, and waits for the answer. A public relay such as relay.sereus.org does not support that request and always refuses it, so each start spends a round trip through the relay (about 95 ms on a desktop, more on a phone) for nothing. The node should remember that refusal and stop asking that relay (GitHub #49, second point).
architecture: docs/strands.md#relay-willingness
files: packages/cadre-core/src/strand-addr-protocol.ts (`StrandAddrOutcome` ~301, `dialOneSibling` ~389), packages/cadre-core/src/delegate-admission.ts (`CircuitRelayTarget` ~191, `dueRelayAnnounces` ~229), packages/cadre-core/src/cadre-node.ts (`siblingAnswered` ~250, `delegateAnnounceAt` ~691, `cleanup` ~5247, `resolveCohortSeed` doc ~6620, `resolveSiblingSeed` ~6646, `circuitRelayTargets` ~6737, `recordDelegateAnnounces` ~6758, `refreshDelegateGrants` ~6777, `announceDelegateToRelay` ~6834, `announceDelegateToDueRelays` ~6855), packages/cadre-core/test/strand-addr-protocol.spec.ts, packages/cadre-core/test/delegate-admission.spec.ts, docs/strands.md (Relay willingness, ~118-148), ops/docker/libp2p-infra/src/main.ts (~95-113, read only: the dedicated relay's service list)
repro: verified
----

# Remember which relays refuse the strand-addr protocol

## Background

A **delegate announcement** is a strand-addr request (`/sereus/strand-addr/1.0.0`) that carries the peer id a strand node is about to run as. It exists for **party-run relays**: a `CadreNode` with `enableRelay`, whose connection gate admits a strand node's derived peer id only after a member announces it (`delegate-admission.ts`, `docs/strands.md` → "Relay willingness"). A **dedicated relay** (`ops/docker/libp2p-infra`, relay.sereus.org) runs only identify, ping and `circuitRelayServer`, has no membership gate, and needs no grant. It answers the protocol negotiation with libp2p's `UnsupportedProtocolError`, by design (`blind-relay-phone-to-phone-e2e` asserts the relay does not list the protocol).

The announcement is sent from three places in `cadre-node.ts`:

- `resolveSiblingSeed`, awaited inline before `startStrand` on every strand founding, attach, resume and hibernation wake, because grants must be recorded before the strand node dials its reservation. This is the cost GitHub #49 reports.
- `refreshDelegateGrants` → `announceDelegateToDueRelays`, the periodic backstop, throttled to once per 15 min per (relay, strand).
- `announceDelegateToRelay`, the `beforeRedrive` hook a strand node's relay-reservation supervisor runs before every re-drive. Unthrottled, because a party-run relay restart drops every grant without telling the announcer.

## Reproduction (verified)

A throwaway spec against `collectStrandAddrs`, with a mock control node whose `dialProtocol` throws `new UnsupportedProtocolError(...)` from `@libp2p/interface`, given one relay target `{ peerId, addrs: [relayAddr] }` (the shape `relayStrandAddrPeer` builds): the outcome is `'unreachable'`, and `dialProtocol` is called **twice**, by peer id and then by the address fallback. So:

- A refusal is indistinguishable from a relay that is down, and nothing records it, so every founding pays it again.
- A refusal costs two negotiations, not one: `dialOneSibling` treats it as a failed target and moves on to the next, although every target reaches the same responder. Its own comment already makes that argument for a reply of any status.

## Design

### Report a refusal as its own outcome (`strand-addr-protocol.ts`)

Add `'unsupported'` to `StrandAddrOutcome`: the peer was reached and its protocol negotiation refused strand-addr. In `dialOneSibling`, an error whose `name` is `'UnsupportedProtocolError'` (match on `name`, the way `relay-reservation.ts` `describeReservationFailure` does) ends the target loop at once and returns `{ outcome: 'unsupported', multiaddrs: [] }`. Every other failure keeps today's fall-through to the next target. Update the outcome list in the type's doc comment.

`siblingAnswered` in `cadre-node.ts` needs no change: `'unsupported'` is not an answer, so a sibling that refuses (an older build that predates the protocol) keeps the retry interval, as `'unreachable'` does today.

### Remember the refusing relays (`cadre-node.ts`)

A per-node set of relay peer ids that refused the announcement, beside `delegateAnnounceAt`. Cleared in `cleanup` with `delegateAnnounceAt` (a stop/start cycle starts with an empty set).

- **Record.** Every announcement call site reads the `outcomes` of its `collectSiblingStrandAddrs` result: a relay peer id with outcome `'unsupported'` is added to the set; a relay peer id with an `'answered'`, `'empty'` or `'unavailable'` outcome is removed from it (a reply means it serves the protocol now). `resolveSiblingSeed` also sends to siblings in the same collection; only record for peer ids that are among the relay targets. One small helper shared by the three sites, so they cannot drift.
- **Skip.** The relay list used by `resolveSiblingSeed` and `refreshDelegateGrants` leaves out the remembered relays. The ticket that filed this said "in `circuitRelayTargets`"; both of its callers are announcement paths, so filtering inside it (and saying so in its doc comment) is fine, as is a separate filtered accessor. The filter can be a pure function next to `dueRelayAnnounces` in `delegate-admission.ts`.
- **Do not skip in `announceDelegateToRelay`.** The re-drive hook keeps announcing to every relay, remembered or not. This is required, not an oversight: a party-run relay registers its strand-addr handler late in its own `start()` (after the control database is initialized and the strand watcher has started, `cadre-node.ts` ~1347), while its libp2p node and relay server are already up. An announcement that lands in that window gets `UnsupportedProtocolError` from a relay that does serve the protocol a moment later. If the hook also skipped remembered relays, such a relay would be skipped until this node restarts, and every reservation through it would be refused at its gate. Because the hook still asks, and a reply clears the entry, the worst case is the one `recordDelegateAnnounces` already documents for a failed initial announcement: the strand supervisor loses its first attempt and recovers on the first re-drive (2 s backoff). Against a dedicated relay the hook's cost is unchanged: one negotiation per re-drive, bounded by the supervisor's backoff. The backlog ticket `debt-strand-relay-redrive-on-party-run-relay-unscenarioed` names this same bring-up window as an open question about the re-drive path.

Document the memo where it is declared: what it holds, why a refusal is treated as "not a party-run relay", and why the re-drive hook ignores it. Update the doc comments that describe the dedicated-relay case as "`unreachable` — harmless" (`resolveCohortSeed`, `recordDelegateAnnounces`, `announceDelegateToRelay`) to match.

### Docs

`docs/strands.md` → "Relay willingness": one sub-bullet saying a relay that refuses the strand-addr protocol is remembered as not party-run and is no longer sent the founding and periodic announcements, while the re-drive hook still asks it, so a party-run relay caught mid-start is not lost. No history.

## Tests

Two, both at the unit layer:

- `strand-addr-protocol.spec.ts`, `collectStrandAddrs` describe: the reproduction above, inverted. A `dialProtocol` that throws `UnsupportedProtocolError` for a target with an address fallback reports `'unsupported'` and is dialed once. The existing `collectNode` mock takes a `throwing` set that throws a plain `Error`; extend it, or write the mock inline, so it can throw the libp2p error.
- The memo's record/clear/skip logic. If the record step and the filter are pure functions in `delegate-admission.ts`, test them in `delegate-admission.spec.ts` (a refusal adds, any reply removes, a sibling's refusal is not recorded, the filter drops remembered relays). Do not build a `CadreNode` for this or mock modules the repository owns.

## Verification beyond unit tests

The ticket asked to check that the founding trace no longer shows a strand-addr dial to the dedicated relay. With `DEBUG=sereus:cadre:strand-addr`, a strand founding against the dedicated relay fixture logs `Strand-addr dial to <relay> via ... failed` on the first founding only, and nothing for the relay on a second founding in the same process. One of the dedicated-relay scenarios under `packages/integration-tests/src/scenarios/` (for example `strand-relay-only-restart-reconverges.integration.ts`) shows this if it founds or resumes more than one strand; run it with that `DEBUG` setting and read the log. If no scenario can be run within the 10 minute agent limit, say so in the review handoff rather than adding a scenario for it.

## TODO

- Add `'unsupported'` to `StrandAddrOutcome`; end `dialOneSibling`'s target loop on `UnsupportedProtocolError`; update its doc comments.
- Add the remembered-relay set to `CadreNode`, clear it in `cleanup`, record from the outcomes at the three announcement sites through one helper, and filter it out of the relay list used by `resolveSiblingSeed` and `refreshDelegateGrants` only.
- Leave `announceDelegateToRelay` asking every relay; document why at the set's declaration.
- Update the doc comments that call the dedicated-relay result `unreachable`, and the "Relay willingness" section of `docs/strands.md`.
- Add the two unit tests; run `yarn workspace @serfab/cadre-core test` and `yarn lint`, plus the cadre-core type check.
- Do the `DEBUG` trace check on a dedicated-relay scenario if it fits the time limit, and report the result.
