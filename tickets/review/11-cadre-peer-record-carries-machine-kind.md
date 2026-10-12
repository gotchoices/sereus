description: Each machine of a cadre now publishes whether it is an app (phone, browser) or an always-on node in its own signed address record, so an owner looking at the cadre's machines can tell which one is the phone and which is the basement server.
architecture: docs/architecture.md#control-network
files: schemas/control.qsql, packages/cadre-core/src/control-schema.ts, packages/cadre-core/src/peer-record.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/seed-bootstrap.ts, packages/cadre-core/src/types.ts, packages/cadre-core/test/control-revocation-replay.spec.ts, packages/cadre-core/test/peer-record.spec.ts, packages/cadre-core/test/digest-variadic-parity.spec.ts, docs/architecture.md
----

# A machine's address record says what kind of machine it is

## What changed

- **Schema** (`schemas/control.qsql`, mirrored in `control-schema.ts`). `CadrePeer` has a new column `Profile text null` and a check `KnownProfile`: `new.Profile is null or new.Profile in ('transaction', 'storage')`. `'transaction'` is an app, `'storage'` an always-on node (the values of `NodeProfile`). Null means the machine has not self-published yet.
- **Signed.** The self-publish digest in `CadrePeer.AuthorizedUpdate` gains a last field, `coalesce(new.Profile, '')`. `peerRecordSignedPayload(partyId, peerId, multiaddr, updatedAt, profile)` mirrors it (null signs as `''`). `signPeerRecord` now takes `Omit<PeerAddressRecord, 'sig'>`, so callers must say which profile they sign. `verifyPeerRecordSignature` passes `record.profile`, so every resolver (`resolvePeerAddrs` and the cohort/dial paths that read `queryPeerRecord`) verifies the profile without further changes.
- **Who may change it.** The self branch lets the machine change its own `Profile`. The owner re-vouch branch requires `coalesce(new.Profile, '') = coalesce(old.Profile, '')`. Inserts do not constrain it beyond `KnownProfile`; the column comment says why (an owner could only mislabel a machine it already fully controls, and the machine's next self-publish corrects it).
- **Writers.** `CadreNode.signSelfRecord` signs `this.config.profile`; both publish paths (`insertSelfPeerRecord` for an owner node's first row, `updateSelfPeerRecord` afterwards) write it. `insertCadrePeer`'s row type gains `profile`; `authorizePeer` (and therefore `addDrone`) passes null. Invitation redemption omits the column (null).
- **Reader.** `PeerAddressRecord.profile: NodeProfile | null`; `ControlDatabase.queryPeerRecord` selects it. `CadrePeerRow` / `queryCadrePeers` are unchanged — `cadre-node-removes-a-machine` widens that read itself.
- **Docs.** `docs/architecture.md`: the `CadrePeer` row of the control table list names `Profile` and why it is self-declared; step 4 of node startup lists it among the signed fields.

Constraint text changed, so existing control stores fail warm start and parties are recreated (no-backwards-compatibility policy).

## Tests

- **Added** — `control-revocation-replay.spec.ts`, "CadrePeer: an owner re-vouch keeps the profile the machine self-published, and may not rewrite it": a machine self-publishes `Profile = 'storage'`; an owner re-vouch that also sets `Profile = 'transaction'` is refused by `AuthorizedUpdate`; the plain re-vouch passes and the profile is still `'storage'`. I checked that it fails when the owner-branch clause is removed from the schema. It lives in this spec, not `peer-record-resolution.spec.ts`, because the lint rule against raw `CadrePeer` SQL exempts only the constraint-fixture specs, and this one already holds the other owner re-vouch test.
- **Extended, no new test cases:** `peer-record.spec.ts` (the payload-shape test now signs `'storage'`; the tamper test also asserts that a changed `profile` fails verification) and `digest-variadic-parity.spec.ts` (the JS/SQL parity case carries a non-empty profile field). The drone self-update case in `peer-record-resolution.spec.ts` now publishes `'storage'`, which exercises the self branch moving `Profile` from null to a value.
- Mechanical: every other `signPeerRecord` / `insertCadrePeer` call in tests gained `profile`. Two replay-guard cases in `peer-record-resolution.spec.ts` sign with `current!.profile` so that the clause they mean to test (monotonic `UpdatedAt`, wrong key) is still the only one that fails.

## Validation run

- `yarn workspace @serfab/cadre-core build`, root `yarn typecheck` (all workspaces), `yarn lint`: clean.
- `yarn workspace @serfab/cadre-core test`: 165 files, 2448 passed, 1 skipped. That run had the new test in `peer-record-resolution.spec.ts`. After moving it, I re-ran `control-revocation-replay` and `peer-record-resolution`, and both pass. `control-founding-consult-budget.spec.ts` passed with its pinned numbers unchanged.
- Integration: `enrollment-e2e` (7), `owner-anchor-follows-owner-changes` (1) and `push-wake-e2e` (4; its signer was edited) pass. `control-write-degraded-cohort-member` had a one-line signer edit (`profile: before!.profile`) and was typechecked only, not run.

## Known gaps / things for the reviewer

- **The profile can be trusted only on a verified record.** No insert rule constrains `Profile`, and the owner branch does not require `Sig` to verify, so a row's `Profile` is the machine's own claim only when its `Sig` verifies. `queryPeerRecord` returns the column as stored. The machine listing in `cadre-node-removes-a-machine` should show a profile only for a record whose signature verifies, or accept the tradeoff written in the column comment. Today no writer sets a non-null profile except the machine's own publish.
- `reauthorizeCadrePeer` is still not run on rows that carry a self-`Sig` (its caller skips them). The new owner-branch clause matters only for a future re-vouch path, or for a hand-written update like the one in the test.
