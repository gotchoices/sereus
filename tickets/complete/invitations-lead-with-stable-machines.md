description: Invitations now list the party's most reliably reachable machines first, so a person redeeming an invitation minted on a phone that has since gone to sleep reaches an always-on machine at once instead of waiting on the phone's dead address. The phone is still named, and comes first when it is the party's only machine or every other machine is also a device.
architecture: docs/strands/formation.md#which-machines-an-invitation-names
files: packages/cadre-core/src/invitation-bootstrap.ts, packages/cadre-core/src/cadre-node.ts (resolvePeerRecord, selectInvitationMembers, createOpenInvitation, invitationSelf, resolveInvitationSiblings), packages/cadre-core/src/strand-fret-addrs.ts (fretPeerTenureMs), packages/cadre-core/src/index.ts, packages/cadre-core/src/cadre-invite-protocol.ts, packages/cadre-core/src/owner-grant-protocol.ts, packages/cadre-core/src/types.ts, packages/cadre-core/test/invitation-bootstrap.spec.ts, packages/integration-tests/src/scenarios/cadre-invite-row-unreplicated.integration.ts, docs/strands/formation.md, docs/cadre/membership.md, docs/cadre/owner-keys.md, docs/network/relay.md
----
# Invitations lead with the party's stable machines

## What was built

The implementation landed in `ticket(implement): invitations-lead-with-stable-machines`.

Both invitation kinds use one pure selection in `invitation-bootstrap.ts` (`selectInvitationAddrs`) and differ only in their caps:

- `selectCadreInvitationMembers(self, siblings)` serves the cadre invitation, the owner grant and `invitationReach()`, all through `CadreNode.selectInvitationMembers`. The caps are 4 addresses for the minting machine, 2 for each other machine and 6 in total, with each machine's addresses ranked for a phone.
- `selectOpenInvitationBootstrap(self, siblings)` serves `createOpenInvitation`. It takes all of the minting machine's addresses and 4 for each other machine, with no total cap.

The other machines (at most 3) are sorted by four keys in turn: declares always on, then reachability now (2 = this node opened a plain connection to it with no relay hop, 1 = connected some other way, 0 = not connected), then FRET tenure, then the newest record.

Where the minting machine goes depends on its class:

- It goes first, with its full allowance, when it is always on or when no always-on machine is named.
- A device minting machine with an always-on machine named goes after the always-on machines and before any device sibling, with one address. That address's slot counts inside the cap of 6.

The evidence is gathered in `CadreNode.resolveInvitationSiblings`:

- The always-on flag comes from the signed record.
- Reachability comes from `invitationReachability(connections)`.
- Tenure comes from `fretPeerTenureMs` in `strand-fret-addrs.ts`.

Docs updated: `docs/strands/formation.md` (new section "The order of the machines" and a new limit "An always-on declaration is not checked"), `docs/cadre/membership.md` → "The bundle", `docs/cadre/owner-keys.md`, `docs/network/relay.md`.

## Review findings

**Read first:** the implement diff, before the handoff, plus the implement ticket's spec. I checked every edge case it lists against the code.

**Correctness. Checked, no defects found.**
- The demoted-device branch: the always-on machines' addresses are a prefix of the sibling list because the always-on flag is the first sort key. With three always-on siblings the cut gives 2 + 2 + 1 of theirs plus 1 of the phone's, as specified.
- With empty own addresses nothing is held for the phone, so the "relay down" guarantee holds.
- The minting machine is excluded from the sibling list (`authorizedAmong` filters `selfPeerId`).
- `verifyPeerRecordSignature` covers `profile`, so the always-on flag that `resolvePeerRecord` now returns is the machine's own signed declaration and not something a relayer could edit.
- `getPeerTenure` exists in the installed FRET (`p2p-fret` index.d.ts). It throws only when FRET was never injected, and that throw lands in the existing try/catch, which logs it.
- `addrKind` returns `direct` only when the address has no `p2p-circuit`, so a relayed or WebRTC connection reads as reachability 1, never 2.
- `invitationReach()` and `createCadreInvitation` still share `selectInvitationMembers`.
- The owner grant's local redemption path does not read the member order.

**Fixed inline:**
- The comment in `resolvePeerRecord` said the self-signature covers `(peerId, addrs, updatedAt)`. It also covers `profile`, which this change now relies on. Corrected.

**Tripwire:**
- A device minting machine's held slot is taken even when its best address reaches only its own network, at the cost of a sibling's address. Parked as a `NOTE:` at `ownSlot` in `selectInvitationAddrs`.

**Tests:**
- I kept the implementer's extra test ("ranks the other machines by always on, then reachability now, then tenure, then the newest record"). It is the one test that pins each of the four sort keys, which is the core of the spec, and it does so through the public open-invitation selection.
- The three device-minting tests each pin a distinct branch. The three moved tests keep their old expectations under an always-on minting machine.
- I cut nothing and added nothing.
- The updated `cadre-invite-row-unreplicated` assertion expects `A.getMultiaddrs()[0]` to be A's best-ranked address. That holds while A's addresses all rank the same. It is brittle but correct, so I left it.

**Docs:**
- I read the four changed docs and `docs/cadre/apps.md`, `docs/cadre/node.md` (the always-on declaration limit) and `docs/concepts.md` (always-on node, address record). All still read true. `yarn lint`, including `check-docs`, passes.

**Hygiene and types:**
- `invitation-bootstrap.ts` is 246 lines.
- There is no `any`. The FRET access goes through a structural type guard, as `exportTable` already does.
- `ReachabilityEvidence` is exported from the module but not from the package index. That is fine, because only `cadre-node.ts` uses it.

**Validation:**
- `yarn lint` passes.
- The cadre-core specs `invitation-bootstrap`, `cadre-node-cadre-invitation`, `cadre-node-owner-grant` and `strand-fret-addrs` pass (20/20), on two runs of the four-file set and an isolated run.
- The integration scenario `cadre-invite-row-unreplicated` passes after rebuilding cadre-core. tsc still emits `dist` despite the known type error.

**Pre-existing:**
- `cadre-node-owner-grant.spec.ts` failed 3 of 4 tests once in 4 runs, with the symptom of its 2026-11-21 `one-off` record in `.pre-existing-known.md`. I reported it in `tickets/.pre-existing-error.md`. It is unrelated to this change, because the failing test takes the local redemption path, which never reads the member list.
- The build and typecheck break in `control-write-retry.ts`, and the integration failures in `enrollment-e2e`, `cadre-invite-any-member` and `cadre-host-join-by-invitation`, are tracked by the blocked ticket `optimystic-sibling-checkout-behind-declared-range`. `node scripts/check-dep-ranges.mjs` still reports the drift. Once that ticket clears, re-run those three scenarios and the full cadre-core suite. They were not run in this review.
