description: An owner can remove a device, app or always-on node from their cadre (an uninstalled app, a stolen phone, a dead basement server), revoking its owner key if it has one, so it can no longer read or act for the cadre.
prereq: app-joins-existing-cadre-by-invitation, owner-anchor-follows-owner-key-changes
files: packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/control-database.ts, schemas/control.qsql, packages/reference-app-rn/app/settings.tsx, packages/reference-app-web/, docs/architecture.md
difficulty: medium
----

# Remove a device, app or node from a cadre

## What exists

`CadreNode.removePeer` deletes a `CadrePeer` row with a tombstone (docs/architecture.md → "Deletes made while alone"). Ticket 5 adds `OwnerKey` inserts for devices. Nothing removes an `OwnerKey` after genesis, and no app UI lists or removes machines.

## What to build

- `removeOwner(publicKey)` in cadre-core, using the guarded delete plus `Revocation` tombstone the schema already requires for `OwnerKey` (removal needs an owner signature bound to the row). The schema already refuses removing the last owner (`MinOneOwner`) and an owner signing its own removal (`A.Key <> old.Key`: no self-resignation), so a removal always needs a **different** owner. The removed key also leaves every node's anchor through `owner-anchor-follows-owner-key-changes`.
- A machine that held an owner key: remove its `OwnerKey` row and its `CadrePeer` row in one transaction.
- A node that learns it has been removed stops serving the party and deletes the party's local data. Check whether "a node that learns it has been revoked should shut itself down" (named as distinct behaviour in docs/architecture.md) exists; build it if not.
- **Strand consequences.** A removed machine still holds strand read secrets it already synced. Removal stops future sync and membership; it cannot unlearn data. Say so in docs and UI. Rotating a strand's keys after removing a device is out of scope; file a backlog ticket if it is not already covered by "Removing Members" in docs/strands.md.
- **UI** (reference apps): "Devices and nodes" lists every `CadrePeer` with its kind (phone app, always-on node), its owner flag, last seen and key fingerprint, plus a Remove action with confirmation. Pending device authorizations (ticket 5) appear in the same list.
- **Replacing a dead host:** remove the old node, then claim a new one (`cadre-host-hosted-nodes-join-by-qr`). Document that sequence; nothing more is needed.

## Edge cases & interactions

- Removing the device you are using: an owner cannot sign its own removal, so "leave this cadre" from an owner device means asking another owner to remove it. A non-owner device can be removed by any owner. The UI must make this clear.
- `MinOneOwner` is a per-transaction local check; two partitioned owners removing each other can converge to zero owners (NOTE in control.qsql). Accept and document it, or add a guard; recovery is `decide-owner-recovery`.
- A removed node that is offline: it learns of the removal when it next syncs, or never. The rest of the cadre must refuse it regardless (the membership gates already read tombstones).

## TODO

- `removeOwner` plus combined removal; self-shutdown on removal if missing.
- Reference-app UI.
- Docs.

## Note from planning `owner-anchor-follows-owner-key-changes`

`CadreNode.addOwner(key)` and `CadreNode.removeOwner(key)` land in `owner-anchor-revocation-signer-and-owner-writers` (the guarded delete plus tombstone, with by-name refusals for self-removal and for the last owner). Build the combined "remove the machine's `OwnerKey` row and its `CadrePeer` row in one transaction" on `ControlDatabase.deleteOwnerKey` and `deleteCadrePeer`, both over `deleteGuardedRow`.

Two consequences of the anchor rule chosen in `owner-anchor-derivation` belong to this ticket's scope:

- **Re-vouch what the removed owner added.** Owners and devices that the removed owner vouched are no longer trusted on any machine until a remaining owner re-vouches them (devices: `reauthorizePeer` rebinds the voucher in place; owners: remove and re-add, since `OwnerKey` has no update branch). The removal flow should list both sets and offer the re-vouch, so removing a stolen phone does not silently drop the owner's other devices.
- **Re-adding a removed owner** from a machine that still holds the old physical `OwnerKey` row fails on the primary key, because that table is not reaped. Either do the re-add from the machine that removed it, or add an `OwnerKey` reap branch gated by `MinOneOwner` (NOTE at `ControlDatabase.insertOwnerKeyVouched`).
