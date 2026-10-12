description: Each machine of a cadre publishes whether it is an app (phone, browser) or an always-on node in its own signed address record, so an owner looking at the cadre's machines can tell which one is the phone and which is the basement server.
architecture: docs/architecture.md#control-network
files: schemas/control.qsql, packages/cadre-core/src/control-schema.ts, packages/cadre-core/src/peer-record.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/types.ts, packages/cadre-core/test/control-schema-drift.spec.ts, docs/architecture.md
----

# A machine's address record says what kind of machine it is

## Why

`remove-a-device-or-app-from-a-cadre` (split into the `11.x` tickets) adds a "Devices and nodes" list where an owner removes a machine. A row in that list today carries only a peer id, an owner flag and an address. Nothing replicated says whether a row is a phone app or an always-on node, so the owner cannot tell the stolen phone from the server. Labels the user types are a separate, blocked decision (`decide-party-private-labels-and-app-state`); the machine's kind is a fact the machine itself knows, from its node profile.

## Design

- **Column.** `CadrePeer` gains `Profile text null` with a check `Profile is null or Profile in ('transaction', 'storage')`. The values are `NodeProfile` (`types.ts`): `'transaction'` is an app (phone, browser), `'storage'` is an always-on node. Null means the machine has not self-published yet (an owner-inserted row before the machine's first publish, `addDrone`'s unsigned row).
- **Self-declared, self-signed.** The value comes from the publishing node's own `CadreNodeConfig.profile`. It is part of the `'publish'` digest: `digest('CadreControl.CadrePeer', 'publish', party_id(), new.PeerId, new.Multiaddr, cast(new.UpdatedAt as text), coalesce(new.Profile, ''))`, mirrored in `peerRecordSignedPayload` / `signPeerRecord` (`peer-record.ts`), so a resolver that re-verifies a record verifies the profile too.
- **Who may change it.** The self branch of `CadrePeer.AuthorizedUpdate` lets the machine change its own `Profile` (a machine re-deployed with another profile republishes). The owner re-vouch branch must keep it: add `coalesce(new.Profile, '') = coalesce(old.Profile, '')` to that branch, null-safe as the other proof columns are.
- **Inserts.** Every `CadrePeer` insert is owner-vouched or invitation-admitted; `AuthorizedInsert` has no self branch and does not check `Sig`. Two writers matter: `publishSelfRecord`'s insert path (`cadre-node.ts` ~2845, an owner node inserting its own row, already signed by `signSelfRecord`) writes its own profile; `authorizePeer`, `addDrone` and invitation redemption insert someone else's row and write `Profile` null, which that machine fills on its next self-publish (an update). `AuthorizedInsert` does not constrain `Profile` beyond the value check: an owner could only mislabel a machine it already has full authority over, and the machine's own next publish corrects it. Say so in the column comment.
- **Read side.** `PeerAddressRecord` and whatever reads `UpdatedAt` / `Sig` for a record (`ControlDatabase.queryPeerRecord`) carry `profile: NodeProfile | null`. `CadrePeerRow` does not need it; the machine listing in `cadre-node-removes-a-machine` reads it.
- **Embedded copy.** `control-schema.ts` mirrors `schemas/control.qsql`; the drift spec enforces this.

Constraint text changes, so existing control stores fail warm start and parties are recreated (no-backwards-compatibility policy, as with every control schema change).

## Edge cases & interactions

- **Profile absent on old rows**: none survive (stores recreated). By inspection.
- **Owner re-vouch (`reauthorizeCadrePeer`) after the machine published a profile**: the owner branch keeps it. Covered by the one test below.
- **Seeds** (`SeedPeer`, `projectSeedPeers`) do not need the profile; leave them alone.
- **Consult budgets** (`control-founding-consult-budget.spec.ts`): adding a column should not change storage consults. If the pinned numbers move, re-measure and explain in the handoff; do not loosen.
- **Resolvers** that verify a record (`resolvePeerAddrs` and anything calling `verifyPeerRecord` or equivalent) must pass the profile into the digest, or every record will fail verification. The existing address-resolution tests catch a miss.

## Tests

- One case in the existing CadrePeer constraint spec (wherever the self-publish and re-vouch branches are already tested; `control-revocation-replay.spec.ts` or the peer-record spec): a self-published row with `Profile = 'storage'`; an owner re-vouch that tries to change it is refused, one that keeps it succeeds. That pins the one new branch.
- No test for the column check or the digest field: the drift spec and the existing record-verification tests cover them.

## TODO

- Schema: column, check, digest field, insert `Profile is null`, owner-branch keep; mirror in `control-schema.ts`.
- `peer-record.ts`: digest and signer take the profile; every verifier passes it.
- `cadre-node.ts`: `signSelfRecord` / `publishSelfRecord` publish `this.config.profile`.
- `control-database.ts`: the self-record writes and `queryPeerRecord` carry `Profile`.
- `types.ts`: `PeerAddressRecord.profile`.
- `docs/architecture.md`: the `CadrePeer` row of the control table list names the column and why it is self-declared.
- `yarn workspace @serfab/cadre-core build`, `test`, `typecheck`; `yarn lint`. Run the integration scenarios that publish records (`enrollment-e2e`, `owner-anchor-follows-owner-changes`) once.
