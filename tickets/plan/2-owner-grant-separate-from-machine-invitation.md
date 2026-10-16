description: An owner-granting invitation today seats the redeeming device's own key as an owner. Split it into two kinds: a machine invitation, which admits a machine and grants no ownership, and an owner grant, which gives a freshly generated owner key to whoever holds the invitation and admits no machine. An owner grant is never targeted at a peer id.
prereq: reference-app-web-owner-keys
files: schemas/control.qsql, packages/cadre-core/src/control-schema.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/cadre-node.ts, packages/reference-app-rn/src, packages/reference-app-web/src, packages/cadre-cli/src/commands, docs/architecture.md
----

# Owner grants are separate from machine invitations

## The design (decided by the project owner)

- **Two kinds, orthogonal.** A *machine invitation* admits a machine (a cadre node / peer) and never grants ownership. An *owner grant* gives an owner key and admits no machine. One flow that does both is two invitations, redeemed separately.
- **An owner grant goes to its possessor, not to a peer.** Redeeming it is the one moment the new owner key is generated: the holder generates a fresh Ed25519 keypair once and stores the private key where they choose (phone hardware vault, hardware key, OS vault, file/QR; see `owner-key-independent-of-machine-identity`). The new public key is seated in `OwnerKey`. No peer id or `CadrePeer` row is involved.
- **An owner grant is never targeted at a peer id.** Peer identity and ownership are unrelated, so the grant has no `PeerId` column. Its protection is possession of the invitation's private half, single use, expiry, and how it is handed over.
- **Use as a backup.** A user can mint an owner grant and keep it (printed QR, file) as a way back into the cadre. That needs a long or no expiry, chosen explicitly by the user; the default lifetime for an untargeted owner grant is 15 minutes today, so the apps need a distinct "backup" choice with a plain warning that whoever holds it can become an owner.

## Where the code diverges today

- `CadreInvite` carries `GrantsOwner` and an optional target `PeerId`; redemption with `GrantsOwner` seats `OwnerKey.Key = CadrePeer.PublicKey` (`docs/architecture.md`, `CadreInvite` / `CadreInviteUsage` rows, "Why the invitation is a keypair").
- `CadreInviteUsage` names both a peer row (`PeerId`, `PeerKey`, `PeerStampId`) and an owner row (`OwnerStampId`).
- `createCadreInvitation({ peerId, grantsOwner })` and `redeemCadreInvitation` return `{ peerId, grantsOwner }`; the targeted request/response flow defaults to targeted owner grants ("Targeted (request and response) is the default for owner grants").
- Reference apps (RN and web) offer "also an owner" when admitting a device; `AppRecommendationStore.approve` records `grantsOwner`.
- Provider `rentNode` uses `grantsOwner: false` (unchanged in meaning).

## Decisions for this pass

- Machine invitations keep the existing `CadreInvite` machinery minus `GrantsOwner`. Owner grants get their own row kind (a separate table, or a kind column with constraints that forbid a target and a peer row; choose in the plan, preferring a separate table if the constraints on `CadreInvite` get simpler).
- Owner-grant redemption is an owner-key insert authorized by the grant: the holder's signature with the invitation key (proves possession) plus the new owner key's signature over the same digest (proves the new key is held), both bound to the party id. It can be written by any member machine, as machine invitations are today, because the member can verify but not produce either signature.
- Redemption needs no machine of the holder's in the cadre, but it does need a member to write the row; the holder's app reaches one the same way a joining device does.
- The race accepted today for single-use owner grants (two redeemers on different machines both seated until merge) still applies; keep the mitigations recorded at the constraint, and re-check them for the new row kind.
- UI: "Add a device" no longer has an "also an owner" checkbox; "Add an owner key" / "Make a backup" mint owner grants. A device that should be an owner redeems a machine invitation and an owner grant.

## Edge cases & interactions

- An owner grant whose issuer is removed as an owner before redemption: liveness requires the issuer still be an owner, as today.
- Withdrawal (`Revocation` tombstone) and "rows are never deleted" carry over to owner grants.
- `removeMachine` withdraws machine invitations the removed machine could redeem; it has nothing to withdraw among owner grants, since none target a machine.
- The connection gate's "do I expect a stranger?" input (`hasLiveCadreInvite`): an owner-grant holder with no machine in the cadre still has to connect to a member to redeem; decide whether a live owner grant counts as expecting a stranger.
- Seed / anchor: the redeemer's anchor (`ownerKeys` from the issuer's node-local anchor) applies to the owner-grant bundle as it does to machine invitations.

## TODO (plan stage)

- Update `docs/architecture.md` (`CadreInvite`, `CadreInviteUsage`, the invitation flows, "Why the invitation is a keypair").
- Split into implement tickets: schema + `ControlDatabase` writers/redeemers; `CadreNode` API (`createOwnerGrant`, `redeemOwnerGrant`, machine invitation without `grantsOwner`); reference apps and cadre-cli; integration scenarios (owner grant redeemed with no machine joining; backup grant redeemed later).

## Left for this ticket by the owner-key split

`owner-key-independent-of-machine-identity` was planned into the `1.01`–`1.10` implement tickets (`owner-signer-seam` … `reference-app-web-owner-keys`); this ticket now waits on the last of them. They leave three things here on purpose:

- **The interim identity owner.** An owner-granting `CadreInvite` still seats the redeeming device's identity key (`OwnerKey.Key = CadrePeer.PublicKey`), and `CadreNode.wireOwnKeyIfOwner()` with no argument still wires a software signer over the identity key when that key is a live owner; the phone kit and the web app call it for joined parties. Removing both is this ticket's job (`docs/architecture.md` → Owner Keys, "Invitation-granted owners, until owner grants land").
  - One visible effect to retire with it: on such a device or tab, both apps' **Export this device's/tab's key** exports the owner slot's key (typically the one it founded its own cadre with), which is not an owner of the joined cadre; the export is titled by that key's bare fingerprint and nothing says it is not an owner here (found in the review of `reference-app-web-owner-keys`).
- **Labels on granted keys.** `OwnerKey.Label` is bound into the owner-signed add digest; the invitation consent branch requires it null. Decide whether an owner grant carries a label (chosen by the issuer and covered by the issuer's signature on the grant row, or chosen by the holder and covered by the new key's own signature) and change that branch.
- **Owner-grant redemption stores the key in an owner slot.** The redeemer generates the key with `createOwnerKey` (`owner-key-store.ts`) or into a file/QR export (`owner-key-export.ts`), and the apps' owner-keys sections (`reference-app-rn-owner-keys`, `reference-app-web-owner-keys`) are where "Add an owner key" / "Make a backup" should mint and redeem grants.

