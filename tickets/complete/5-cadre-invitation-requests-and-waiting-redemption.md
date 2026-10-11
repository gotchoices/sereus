description: Shared pieces that let one app hand a cadre invitation to another: a short join request, invitations small and labelled enough to paste or show as a QR code, a warning when no always-on machine could take the redemption, a redemption that waits for such a machine, and wiring the joined device's owner key only when it really is an owner.
prereq: cadre-invitations-redeemable-by-any-member
architecture: docs/architecture.md#enrollment-flow-invitation-redeemed-at-any-member
files: packages/cadre-core/src/cadre-join-request.ts, packages/cadre-core/src/cadre-invite-protocol.ts, packages/cadre-core/src/invitation-bootstrap.ts, packages/cadre-core/src/node-claim-payload.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/index.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/test/cadre-join-request.spec.ts, packages/cadre-core/test/invitation-bootstrap.spec.ts, packages/cadre-core/test/cadre-invite-protocol.spec.ts, packages/cadre-core/test/cadre-node-cadre-invitation.spec.ts, packages/integration-tests/src/harness/cadre-invite.ts, packages/integration-tests/src/scenarios/app-joins-cadre-by-invitation.integration.ts, packages/cadre-cli/src/commands/start-invitation.ts, packages/cadre-cli/README.md, packages/cadre-host/src/hosted/hosted-node-watcher.ts, packages/reference-app-ns/src/cadre-vm.ts, packages/reference-app-rn/app/settings.tsx, packages/reference-app-rn/src/use-cadre.ts, docs/architecture.md
----

# Join requests, labelled invitations, and a redemption that waits

The platform-neutral half of the app-to-app join, all in `@serfab/cadre-core`; the phone kit's party switch (`app-joins-existing-cadre-by-invitation`) and the screens (`reference-apps-join-existing-cadre`) build on it. Documented in `docs/architecture.md` → "Enrollment Flow: Invitation Redeemed at Any Member" and its subsection "Handing an invitation from app to app".

## What shipped

- **Join request** (`cadre-join-request.ts`): `sereus-join-request:1.<base64url canonical JSON of { appName, peerId, v }>`, with an encoder that refuses what the decoder would and a decoder that names each refusal (wrong or missing prefix, an invitation pasted here, bad shape, non-Ed25519 peer id, empty or over-64-character name).
- **Invitation prefix**: `encodeCadreInvitation` emits `sereus-invite:1.`; `decodeCadreInvitation` requires it and refuses a join request by name. No backwards compatibility (an older cadre-host `hosted-nodes.json` record no longer decodes; accepted).
- **Address cap**: `selectCadreInvitationMembers` names at most 6 addresses (own ≤ 4, each other member ≤ 2), each machine's addresses ranked for a phone before the cut (added in review, below).
- **`reach`** on the mint result (`anywhere` / `local-network` / `issuer-only`), judged on machines other than the minting one.
- **Waiting redemption**: `redeemCadreInvitation(invitation, { waitForMember, signal, onProgress })`, passes in `redeemInPasses`, one signed request for every pass, 5 s doubling to 60 s, cut at expiry, local expiry check, abort, node stop.
- **`CadreNode.wireOwnKeyIfOwner()`**: wires the identity key only when it is a live `OwnerKey` row; never inserts one.
- Harness `redeemWaitingForMember`, the `app-joins-cadre-by-invitation` scenario (targeted arm through a real `no-member-answered` pass with M restarted on the same address; open arm), CLI `--json` carrying `reach`.

## Review findings

Read the diff of `ticket(implement): cadre-invitation-requests-and-waiting-redemption` before the handoff, then the touched docs and callers.

### Fixed in this pass

- **Address cap could cut a machine's only reachable address (correctness).** The new cap took the first 4 of the issuer's own addresses and the first 2 of each sibling's in the order given. libp2p reports a machine listening on every interface with loopback and private addresses ahead of its relayed one, so a cadre-cli owner with several interfaces minted a bundle with no relayed address for itself, and a sibling record (relay, loopback, LAN) kept relay + loopback rather than relay + LAN. `selectCadreInvitationMembers` now ranks each machine's addresses before slicing (`rankForPhone` in `invitation-bootstrap.ts`: relayed/public-name/public-IP, then private, then loopback, then any a phone cannot dial such as plain TCP; stable within a rank). New test in `invitation-bootstrap.spec.ts` pins it. Open strand invitations keep record order; the existing `NOTE:` there now says so.
- **Size budget re-measured.** Ranking puts the longest (relayed) addresses first, and a cadre whose machines publish only relayed addresses produced that shape before too: 6 relayed addresses with 3 owner keys encode to 2,206 characters, past the old 2,048 test bound (the handoff's 1,972 was the alternating mix, not the worst case). The size test now builds the all-relayed bundle and holds it to 2,331 — the largest QR code's capacity at error-correction level M (2,953 at L). The constant's comment and the architecture doc state both measurements.
- **Abort race in `underDeadlineAndCaller`** (`cadre-invite-protocol.ts`): a caller abort landing between `redeemAtMembers`' `throwIfAborted()` and the listener registration (across the `nextMacrotask` await) fired no event, so the attempt ran on to its per-address deadline. It now checks `caller.aborted` after registering.
- **A pause outliving a stopped node.** The implementer's tripwire (a node stopped during a pause is noticed only when the pause ends, a timer holding a Node process up to 60 s) is retired: `pause` now also ends on libp2p's `stop` event (or at once if the node is not started), and the next pass's stop check throws. `refuseIfStopped` lost a `status !== undefined` guard that would have made a status-less node spin through zero-length pauses.
- **Stale cadre-cli README sentence** (flagged in the handoff, and in a paragraph this ticket edited): it said a member without the invitation's row refuses the connection; since `cadre-invitations-redeemable-by-any-member` it seats the row from the bundle. Rewritten to say that, and that a member lacking the issuing owner's key answers `issuer-unknown` and the device moves on.
- **Reference-app text still describing unprefixed invitations**: the RN settings placeholder, the `use-cadre.ts` doc comment and the NativeScript app's decode error message now name `sereus-invite:1.` rather than "base64url".
- `cadre-node-cadre-invitation.spec.ts`'s "names this machine first" assertion compared against `getMultiaddrs().slice(0, 4)`, which restated the old unranked order; it now checks at most four members, all among the node's own addresses.

### Tripwires recorded

- Local expiry is judged by the device's clock; a clock running ahead ends a wait early. `NOTE:` at `refuseIfExpired` (`cadre-invite-protocol.ts`).
- Kept the implementer's `NOTE:` on `wireOwnKeyIfOwner` (cannot replace a listener-only seed service) and the accepted-tradeoff `NOTE:` at the cap (a sibling's reachable address can still be cut when it has more than two good ones).

### Checked, nothing to change

- **One signed request across passes**: signed once in `CadreNode.redeemCadreInvitation` before `redeemInPasses`; every pass reuses `options.request`. Correct.
- **Wait termination**: final refusal and invalid reply rethrown; an unreachable error with no outcomes (bundle with no addresses) thrown at once; non-wait mode makes one pass and leaves expiry to the member, as documented.
- **`wireOwnKeyIfOwner`**: reads live `OwnerKey` rows (`getOwnerKeys` excludes retired stamps), compares the identity key's public half, skips re-wiring when already able to authorize. Never inserts a row.
- **`classifyDialAddress` refactor**: the claim selector still drops loopback and unspecified addresses and narrows private ones by `lan`; `node-claim-payload.spec.ts` and `node-claim-addresses.spec.ts` pass.
- **`reach`**: relayed addresses classified by their trailing `/p2p/`, so a relay through the issuer's peer is not miscounted; TCP-only siblings correctly read as not dialable by a phone.
- **Callers of the codec**: every producer goes through `encodeCadreInvitation`; the cadre-host test fixture and the NativeScript fake use it. `invite-address-push.spec.ts` (pushed and unparsable addresses) keeps its order under ranking since all its addresses share a rank.
- **Tests**: the join-request spec and the reach spec cover branching logic named in the plan; kept. No pass-loop unit test (would mock a module this repo owns); the scenario exercises a real multi-pass join. Abort, expiry and stop paths are covered by reading only.
- **Docs**: `docs/architecture.md` (cap, ranking, measurements, app-to-app subsection, `wireOwnKeyIfOwner`, API listing) and the cadre-cli README now match the code.

### Not addressed here

- An older cadre-host record whose stored invitation lacks the prefix fails to decode (a `joining` node fails on Retry; a joined node shows no issuer, already handled in `issuerOf`). Accepted under the project's "no backwards compat yet" rule.
- `wireOwnKeyIfOwner` returning false right after an owner grant on a slow network is the phone kit ticket's to handle (retry rather than conclude "member"); it returned true at once in every scenario run.

## Validation

- `yarn lint`: clean. Typecheck: cadre-core, integration-tests, reference-app-ns, reference-app-rn clean.
- cadre-core unit suite: 164 files, 2,442 passed, 1 skipped. reference-app-ns: 118 passed.
- Integration (against a rebuilt cadre-core): `app-joins-cadre-by-invitation` green (B admitted on pass 2, ~5.5 s after M began restarting; the refused dial now reads "Received network error or non-101 status code"), `cadre-invite-any-member` green (pass 1). The full integration suite was not run.
