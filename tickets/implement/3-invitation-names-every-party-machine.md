description: An invitation tells the joining device how to reach only the one machine that created it, so a join fails whenever that machine is offline, even if another machine of the same party is up. List a few of the party's other machines in the invitation, and have the joining device try each in turn.
prereq: formation-rejection-codes, formation-responder-installed-at-start
architecture: docs/architecture.md#strand-formation
files: packages/cadre-core/src/cadre-node.ts (createOpenInvitation ~8037, resolvePeerAddrs ~2920, listAuthorizedMembers ~7397), packages/cadre-core/src/strand-formation-manager.ts (formStrand ~289), packages/cadre-core/src/strand-formation-protocol.ts (dialFormation ~780-850, parseResponderAddrs, FormationDialOptions.responderAddrs doc), packages/cadre-core/src/peer-record.ts (trailingPeerId, orderSignalingFirst), packages/cadre-core/src/types.ts (OpenInvitation.bootstrap doc ~1377), packages/cadre-core/test/strand-solicitation.spec.ts (describe "StrandFormationManager transport: real disclosure + result validation"), docs/architecture.md (Strand Formation), docs/strands.md (Inviting Parties)
----
# Invitations name every party machine; the joiner tries each

Part of gotchoices/sereus#25 (split from the plan ticket `durable-pending-join`). Inviter side, reason 1 of the issue's three. With `formation-responder-installed-at-start`, every machine of the inviting party can answer, so listing them lets a joiner reach an always-on sibling while the inviting phone is offline.

## Inviter: which addresses go in `invitation.bootstrap`

`createOpenInvitation` builds the list in this order:

1. This machine's own `getMultiaddrs()`, unchanged and first. The minting machine is the one most likely to run the host strand.
2. Up to **3 other machines** of the party, each with up to **4 addresses**:
   - Candidates are `listAuthorizedMembers()` minus this machine. For each, use `resolvePeerAddrs(peerId)`, which applies the signature, freshness (`DEFAULT_PEER_RECORD_MAX_AGE_MS`, 15 min) and trust gates, orders relay (signaling) addresses first, and ends every address in `/p2p/<peerId>`. A machine whose record is missing, stale or untrusted is skipped.
   - Order: machines this node is connected to on the control network right now come first, then the rest by record `UpdatedAt`, newest first. A live connection is the best evidence available that the machine is up. The record alone is evidence only that it was up within the last 15 minutes.

This answers the issue's open question: both sources, with the signed `CadrePeer` record as the address source and live connections only for ordering. Addresses go stale over the invitation's lifetime (24 h by default). The joiner tolerating dead entries is what makes that acceptable.

`createOpenInvitation` throws only when the **combined** list is empty. A phone whose relay is down can still mint an invitation that names its always-on sibling. The React Native app's own pre-check (`getMultiaddrs().length === 0` in `use-cadre.ts`) is app policy and is left alone. Note it in the release note.

## Joiner: one session per machine

Today `dialFormation` hands the whole list to one `dialProtocol` call. libp2p refuses a list that mixes peer ids, so a multi-machine invitation would fail outright. Change `StrandFormationManager.formStrand`, or a helper beside `dialFormation`, to:

- Group `responderAddrs` by trailing peer id (`trailingPeerId`), keeping the order in which each peer first appears. Drop an entry that names no peer, with a log line. Every address `getMultiaddrs()` and `resolvePeerAddrs` produce carries one.
- Try the groups in order, one formation session each (the existing `dialFormation` with that group's addresses, so the per-session deadline ladder is unchanged):
  - approved → return it;
  - `FormationUnreachableError`, or `FormationRejectedError` with `retryable` → note it and try the next machine;
  - `FormationRejectedError` that is final (`token-spent`, `approval-refused`, `host-strand-must-be-recreated`, …) → throw it at once. Another machine of the same party would give the same answer.
- When every machine has been tried: throw the last retryable `FormationRejectedError` if any machine answered (the inviter's party is reachable but not ready, which is more useful to a caller than "unreachable"), otherwise one `FormationUnreachableError` whose message names each machine's failure and whose `cause` is an `AggregateError` of them.
- **Build the contact once per `formStrand` call and reuse it for every machine**: same `usageStampId`, same consent signature. `FormationUsage`'s primary key is `UsageStampId`, so at most one machine of the inviting party can record this attempt's redemption. A machine that timed out from the joiner's view while still committing therefore cannot lead to a second redemption by its sibling. Today `StrandSolicitationService.formStrand` already builds the consent once, so this holds as long as the loop sits below it.

## Edge cases & interactions

- **Duplicate peer across own addrs and member list.** The minting machine never appears twice (it is excluded from the candidates). A member whose addresses repeat is grouped once. Inspection.
- **Order of addresses within a group.** Keep the existing single-call dial and libp2p's sorter for the addresses of one peer (see the `NOTE:` at `openFormationStream` and the review findings of `formation-dial-tries-only-the-first-invitation-address`). Only the peer order is ours.
- **Worst-case duration.** Machines that cannot be dialled each cost one `dialMs` (19.5 s at the default declared link). A machine that accepts the contact and then stalls costs up to one `sessionMs`. With at most 4 machines that is bounded. State it in the `FormationDialOptions` doc, not as a new deadline.
- **A sibling not yet holding the invitation** answers `token-unknown` (retryable), so the loop moves on. One that does not run the closed host strand answers `host-strand-unavailable`, also retryable.
- **Invitation size.** Up to 12 extra addresses of roughly 100–200 characters each, base64url-encoded. The reference apps share invitations as text, not QR codes. Add a `NOTE:` at the cap: if invitations are ever carried in a QR code, lower the cap or ship peer ids only.
- **Approver race.** With a `ValidationUrl` invite, two machines might each ask the hook for the same `usageStampId` if the first timed out. The approval is bound to the nonce, and only one `FormationUsage` row can land, so a second approval is harmless. Inspection.
- **Trust.** The joiner dials only what the invitation says, as today. Whoever writes the invitation already chooses which peer gets dialled, so listing more peers adds no attack surface.

## Tests

- Extend the existing real-libp2p test `'forms through a later bootstrap address when the first is unreachable'` with one sibling case: an invitation listing machine A (stopped, or a refused address under A's peer id) and machine B (a running responder that holds the invite), and formation succeeds through B. This pins the per-peer loop, the new branching logic. If the spec's fixtures make a two-responder setup costly, use two responder nodes sharing one recorder stub.
- One manager-level test: a final rejection from the first machine stops the loop (the second responder is never contacted). This pins the stop-versus-continue branch.
- No test for the inviter-side list building beyond what an existing `createOpenInvitation` test can assert cheaply (own addresses first). The selection is a sort and two caps.

## TODO

- `createOpenInvitation`: append the other machines' addresses as above; throw only on an empty combined list; add a `NOTE:` on the caps.
- Joiner: group by peer and loop as specified, reusing one contact; aggregate the final error.
- Update the `OpenInvitation.bootstrap` and `FormationDialOptions.responderAddrs` docs.
- Docs: `docs/architecture.md` Strand Formation (which machines an invitation names, how the joiner walks them), `docs/strands.md` Inviting Parties (an always-on machine answers while the inviting phone is offline). Add a release-note bullet in `.release-notes.pending.md`.
- `yarn lint`, `yarn typecheck`, `yarn workspace @serfab/cadre-core test`; run `strand-formation-e2e` and `strand-formation-cross-party-seed`.
