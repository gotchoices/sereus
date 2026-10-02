description: An invitation lists a few of the inviting party's other machines besides the one that created it, and a joining device tries each machine in turn, so a join can succeed through an always-on machine while the inviting phone is offline.
prereq: formation-rejection-codes, formation-responder-installed-at-start
architecture: docs/architecture.md#which-machines-an-invitation-names
files: packages/cadre-core/src/invitation-bootstrap.ts (new: caps + ranking), packages/cadre-core/src/cadre-node.ts (createOpenInvitation, siblingInvitationAddrs, resolvePeerAddrs → resolvePeerRecord split), packages/cadre-core/src/strand-formation-protocol.ts (dialFormationByMachine, groupResponderAddrsByMachine, shouldTryNextMachine, noMachineReached, FormationDialOptions.responderAddrs doc), packages/cadre-core/src/strand-formation-manager.ts (formStrand now calls dialFormationByMachine), packages/cadre-core/src/index.ts (export), packages/cadre-core/src/types.ts (OpenInvitation.bootstrap doc), packages/cadre-core/test/strand-formation-manager.spec.ts, packages/cadre-core/test/strand-solicitation.spec.ts, packages/cadre-core/test/formation-stream-helpers.ts, packages/cadre-core/test/strand-formation-membership-invite.spec.ts, docs/architecture.md, docs/strands.md, docs/reference-app-rn.md, packages/reference-app-rn/src/use-cadre.ts, packages/reference-app-rn/src/relay-config.ts, .release-notes.pending.md
----
# Invitations name every party machine; the joiner tries each

Part of gotchoices/sereus#25 (inviter side, reason 1 of the issue's three). Builds on `formation-responder-installed-at-start` (every machine answers formation) and `formation-rejection-codes` (typed, retryable-or-final refusals).

## What changed

**Inviter** — `CadreNode.createOpenInvitation` builds `bootstrap` as: this machine's own `getMultiaddrs()` first, then `siblingInvitationAddrs()`:

- Candidates: `listAuthorizedMembers()` (already excludes self). Each goes through `resolvePeerRecord` — the body of `resolvePeerAddrs`, split out so it returns `{ addrs, updatedAt } | null` and the ranking needs no second record read. `resolvePeerAddrs` is now a one-line wrapper over it; behaviour unchanged (tests that stub `resolvePeerAddrs` on an instance still stub every other caller).
- `selectInvitationSiblingAddrs` (`invitation-bootstrap.ts`): connected-on-control-network first, then `UpdatedAt` newest first; at most 3 machines (`INVITATION_SIBLING_MACHINES`), 4 addresses each (`INVITATION_ADDRS_PER_SIBLING`, relay addresses first because `resolvePeerAddrs` orders them so). The QR-code `NOTE:` sits on those constants.
- Best effort: an unstarted node, or any throw while listing/resolving, logs and yields `[]` (the invitation then names only this machine, as before).
- Throws `No multiaddrs available for invitation` only when the combined list is empty.

**Joiner** — new exported `dialFormationByMachine(node, options)` beside `dialFormation`; `StrandFormationManager.formStrand` calls it with the one contact it builds (same `usageStampId` and consent signature for every machine; the consent is still minted once in `StrandSolicitationService.formStrand` above it).

- Groups `responderAddrs` by `trailingPeerId`, first-appearance order. Unparsable entries and entries naming no peer are dropped with a log line.
- One `dialFormation` per machine: approved → return; `FormationUnreachableError` or retryable `FormationRejectedError` → next machine; final refusal or a plain `Error` (approval that failed validation) → throw at once.
- Exhausted: throw the last retryable refusal if any machine answered; else, for one machine, its own unreachable error unchanged (it already names each address tried); for several, one `FormationUnreachableError` naming each machine with `cause: AggregateError`.
- `dialFormation` itself is unchanged: still one session, one `dialProtocol` call, so the protocol spec's peerless fixtures still exercise it directly.

**Docs** — new `docs/architecture.md` subsection "Which machines an invitation names" (inviter selection + joiner walk + duration bound); the existing address-dial paragraph now says "within one machine's session"; the rejection-codes paragraph says `formStrand` walks the machines. `docs/strands.md` Inviting Parties gained a paragraph. Release note added.

**React Native app** — the `getMultiaddrs().length === 0` pre-check in `use-cadre.ts` is kept, as the ticket said. Its two comments, `relay-config.ts`'s header and `docs/reference-app-rn.md` claimed `createOpenInvitation` itself refuses with no own address; that is no longer true, so they now say the app refuses because the phone runs the strand it invites to.

## Behaviour change a reviewer should weigh

A bootstrap entry without a trailing `/p2p/<peerId>` used to be dialled; now `formStrand` ignores it. Everything `createOpenInvitation` mints carries the suffix, and every integration scenario builds invitations from `getMultiaddrs()`. Two cadre-core spec fixtures used the bare `/ip4/127.0.0.1/tcp/1` with a bridging dialer that ignores the address; they now use `BRIDGED_RESPONDER_ADDR` from `formation-stream-helpers.ts`. A hand-built invitation outside this repo with bare addresses would now fail with `No responder addresses available for formation` (release note says so). The alternative — one extra session for all peerless entries — was rejected per the ticket: the joiner should dial only a machine the invitation names.

## Tests added

- `strand-solicitation.spec.ts` → "forms through another machine of the party when the first one named is offline" (real libp2p): invitation = a never-started peer's `/tcp/1/p2p/<id>` then the running responder's addresses. Pins the per-machine loop: on the old single-dial path it fails with libp2p's "Multiaddrs must all have the same peer id" (verified by temporarily swapping the manager back to `dialFormation`).
- `strand-formation-manager.spec.ts` → describe "an invitation naming several machines of the party", two cases over a peer-id-routing in-memory dialer with two responder managers:
  - "asks the next machine after a retryable refusal" — machine A answers `token-unknown`, B approves; asserts both contacted, strand from B. Also fails on the old path.
  - "stops at a final refusal…" — A answers `token-spent`; asserts only A contacted and the error is `FormationRejectedError { code: 'token-spent', retryable: false }`.
- No test for the inviter-side ranking/caps (a sort and two slices, per the ticket).

## Validation run

- `yarn workspace @serfab/cadre-core test`: 147 files, 2350 passed, 1 skipped.
- Integration (after `yarn workspace @serfab/cadre-core build`): `strand-formation-e2e` + `strand-formation-cross-party-seed` 24/24; `strand-always-on-replica-hosts-cross-party-join`, `strand-formation-concurrent-redemption`, `blind-relay-phone-to-phone-e2e` 7/7.
- `yarn lint`: clean.
- `yarn workspace @serfab/cadre-core typecheck`: 36 errors, the same count as before, all the known in-flight `typecheck-fails-on-libp2p-interface-3-1-against-linked-optimystic-3-3` mismatch (`tickets/.pre-existing-known.md`); none in touched code. The cadre-core build exits 2 for the same 4 src errors but emits dist.

## Known gaps / for the reviewer

- **No scenario has an invitation actually reach a sibling.** The real-libp2p test uses an offline peer id plus a single responder; nothing runs `CadreNode.createOpenInvitation` on a multi-machine party with the minting machine stopped and then joins through the sibling. That end-to-end (sibling gate admits the stranger via the replicated `FormationInvite`, answers from its own control DB) is the issue's real use case and is only covered piecewise by `formation-responder-installed-at-start`'s tests. Worth deciding whether it belongs in a scenario (likely alongside `durable-pending-join` work).
- **Timed-out-but-committed first machine.** If machine A commits the redemption after the joiner gave up on it, B is then asked with the same `usageStampId`. If A's row has replicated to B, B refuses (`token-spent` on a single-use invite, or `conflict`), so the joiner sees a failure although the token is spent on A. The ticket's argument covers "no second redemption", not "the joiner learns it succeeded"; that recovery belongs to `blocked/strand-half-committed-join-recovery`. Not addressed here.
- `siblingInvitationAddrs` resolves every authorized member serially (one control-DB record read each) on every `createOpenInvitation`. Cadres are a handful of machines; no `NOTE:` added since the cost is per user action, not per pass.
- The ticket's "approver race" (two machines asking a `ValidationUrl` hook for one `usageStampId`) and "duplicate peer" edges were checked by inspection only, as the ticket allowed.


## Review findings

Read the `ticket(implement): invitation-names-every-party-machine` diff first, then the handoff. Ran `yarn lint` (clean) and `yarn workspace @serfab/cadre-core test` (147 files, 2350 passed, 1 skipped). Integration scenarios were not re-run, since my only code edit is a comment.

**Checked, no change needed**

- *Inviter selection.* `listAuthorizedMembers` excludes this node and revoked/unvouched rows; `resolvePeerRecord` keeps every gate of `resolvePeerAddrs` (key binding, signature, 15-minute freshness, trust policy) and `resolvePeerAddrs` is a pure wrapper over it. A sibling whose `signalingOnly`-filtered or normalized list is empty is skipped. Unstarted node and read failures fall back to own addresses only, logged. Serial per-member record reads use the same read path as every other caller; cost is per user action.
- *Joiner loop.* Grouping by trailing peer id keeps first-appearance order and handles one machine's addresses being non-contiguous. `dialFormation` turns every pre-answer failure (including a stalled session) into `FormationUnreachableError`, so the continue/stop split in `shouldTryNextMachine` covers every outcome: unreachable or retryable → next; final refusal, plain `Error` (failed validation, missing provision result) → thrown. `noMachineReached` is only reached with at least one unreachable entry. One contact (one `usageStampId`) for every machine, minted once above the loop.
- *Sibling admission.* The sibling's control gate (`admitInboundControlConnection`, check 6) consults the replicated `FormationInvite` through `hasOutstandingFormationInvite`, so a stranger is admitted once the row has replicated; before that the joiner sees unreachable and moves on.
- *Bare-address behaviour change.* Every `createOpenInvitation` caller in `packages/` mints through `getMultiaddrs()` or passes suffixed addresses; the harness's hand-built invitations (`test-network.ts`) never reach `dialFormationByMachine`. Release note already says so.
- *Docs.* `architecture.md`, `strands.md`, `reference-app-rn.md`, `types.ts`, `FormationDialOptions.responderAddrs` and the RN comments match the code; constants (3 machines, 4 addresses, 19.5 s dial, 24 h default lifetime, 15-minute freshness) checked against source.
- *Tests.* The three new tests each pin a branch that failed on the old single-dial path or the stop branch; none restates the implementation. Kept all three. No test added for the ranking (a sort and two slices), as planned.

**Found and fixed inline**

- *Disclosure contradiction (docs).* `architecture.md`'s "Cadre-disclosure timing" paragraph says cadre addresses are revealed only after approval, but the invitation now carries up to three sibling machines' peer ids and addresses before any token check. This is inherent to the requested feature, so I reconciled the docs rather than the code: the timing paragraph now says what it still withholds (party id, full cadre list, membership key, strand addresses), the "Which machines an invitation names" section gained a **Disclosure** bullet, and the release note says invitation holders now learn those machines' addresses.

**Tripwire**

- The per-machine cap of four keeps the record's order (relay first, then direct addresses as published, loopback included), so a sibling with many interfaces and no relay could have its reachable address cut. Parked as a `NOTE:` on `INVITATION_ADDRS_PER_SIBLING` in `invitation-bootstrap.ts`.

**Filed**

- `backlog/debt-join-through-a-sibling-machine-unscenarioed`: no real-network test has the minting machine stopped and a stranger join through its always-on sibling. The implementer named this gap. It is the feature's main use case, and today it is covered only piece by piece.

**Left as is (already tracked or by design)**

- Timed-out-but-committed first machine: the joiner can see a failure while machine A spent the token. Tracked by `blocked/strand-half-committed-join-recovery`, and the `token-spent` confirmation in `implement/pending-join-retry-loop` handles the retry side.
- `createOpenInvitation` uses `getMultiaddrs()` for its own addresses, not the NAT-resolved `resolveInviteAddresses()` its siblings publish. This predates the change and is out of scope.
- Approver race and duplicate-peer edges: checked by inspection only, as the plan allowed. Nothing found.
- Typecheck: not re-run. The 36 errors are the known in-flight `typecheck-fails-on-libp2p-interface-3-1-against-linked-optimystic-3-3`.
