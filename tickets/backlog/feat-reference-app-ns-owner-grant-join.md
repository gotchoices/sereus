description: The NativeScript reference app's "Join a Cadre" field only accepts a machine invitation, so a phone that already has conversations of its own cannot join a cadre as an owner and bring them along, even though the edge node under it can.
architecture: docs/architecture.md#an-app-joins-an-existing-cadre
files: packages/reference-app-ns/src/cadre-vm.ts, packages/reference-app-ns/app/settings/settings-view-model.ts, packages/reference-app-ns/app/settings/settings-page.xml, packages/reference-app-ns/src/join-failure.ts, packages/reference-app-ns/test/settings-view-model.spec.ts, packages/reference-app-ns/test/stubs/fake-cadre-node.ts, docs/reference-app-ns.md
difficulty: easy
tradeoffs: The NativeScript app is a parity twin of the phone app with no owner-key screens of its own, so a maintainer may fold this into a wider NativeScript owner-keys ticket, or defer it with the rest of the app's parity gaps.
----

# NativeScript app: the join field takes an owner grant

Since `machine-invitation-grants-no-ownership`, a machine invitation admits a phone as a member only. A phone that founded a cadre of its own and holds conversations in it is refused a join by invitation before anything stops (`StrandsNeedOwnerJoinError`), and the refusal text in `src/join-failure.ts` tells the user to join with an owner grant made in the owner app under Owner keys. The edge node's `joinCadre` takes either credential (`JoinCredential` in `@serfab/cadre-core/edge-node`), but the NativeScript app's `CadreViewModel.joinCadre` decodes the paste with `decodeCadreInvitation` alone, so a pasted owner grant is refused as unreadable and the user the refusal points at has no way in.

## Expected behaviour

- **One join field, either credential.** The paste is decoded by its prefix: `sereus-owner-grant:1.` through `decodeOwnerGrant`, `sereus-invite:1.` through `decodeCadreInvitation` (the phone kit's README under "Joining another cadre" shows the switch). The rewrap that names which paste was unreadable names both prefixes.
- **The join reports what the edge node reports.** The "Joined cadre" modal already reads standing from `CadreViewModel.owner`; after a grant join it says the device is an owner once the owner step settles `enrolled`.
- **Copy follows.** The Settings hint for the field, the refusal text and `docs/reference-app-ns.md` → "Joining another cadre" say the field takes an invitation or an owner grant, and that only a grant brings the phone's own conversations along.

The phone app's equivalent is `reference-app-rn-owner-grants`, which also adds the grant-minting screens; this app has no owner-key screens, so a grant is minted elsewhere and pasted here.
