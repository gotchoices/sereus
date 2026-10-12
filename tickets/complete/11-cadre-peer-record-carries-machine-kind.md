description: Each machine of a cadre now publishes whether it is an app (phone, browser) or an always-on node in its own signed address record, so an owner looking at the cadre's machines can tell which one is the phone and which is the basement server.
architecture: docs/architecture.md#control-network
files: schemas/control.qsql, packages/cadre-core/src/control-schema.ts, packages/cadre-core/src/peer-record.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/seed-bootstrap.ts, packages/cadre-core/src/types.ts, packages/cadre-core/test/control-revocation-replay.spec.ts, packages/cadre-core/test/peer-record.spec.ts, packages/cadre-core/test/digest-variadic-parity.spec.ts, docs/architecture.md
----

# A machine's address record says what kind of machine it is

## What was built

- **Schema** (`schemas/control.qsql`, mirrored in `control-schema.ts`). `CadrePeer` has a new column, `Profile text null`, and a check, `KnownProfile`: `'transaction'` (an app) or `'storage'` (an always-on node), the values of `NodeProfile`. The column is null until the machine first self-publishes.
- **Signed.** The self-publish digest in `CadrePeer.AuthorizedUpdate` ends with `coalesce(new.Profile, '')`. `peerRecordSignedPayload` / `signPeerRecord` / `verifyPeerRecordSignature` mirror it, so every resolver verifies the profile.
- **Who may change it.** The self branch lets the machine change its own `Profile`. The owner re-vouch branch must keep every column the machine declares itself: `PublicKey`, `Multiaddr`, `Sig` and `Profile`. The implement pass pinned only `Profile`; review extended this to all four (see findings). Inserts are constrained only by `KnownProfile`.
- **Writers / reader.** `CadreNode.signSelfRecord` signs `config.profile`. Both self-publish paths write it, and `authorizePeer` and invitation redemption leave it null. `PeerAddressRecord.profile` is read by `queryPeerRecord`.
- **Docs.** In `docs/architecture.md`, the `CadrePeer` row of the control-table list and step 4 of node startup.

Constraint text changed, so existing control stores fail warm start and parties are recreated (no-backwards-compatibility policy).

## Review findings

**Checked:** the implement diff (`ticket(implement): cadre-peer-record-carries-machine-kind`) in full. That covers the JS/SQL digest parity (null signs as `''`, and `KnownProfile` makes `''` an impossible stored value, so the two cannot collide), every `PeerAddressRecord` constructor and consumer (`grep PeerAddressRecord`; none is serialized over the wire, so no parser missed the field), and `CadreNodeConfig.profile`, which is required (`profile: NodeProfile`), so `signSelfRecord` never signs `undefined`. I also checked that `registerSelf` re-signs on every heartbeat, so a restart with a different profile republishes it, plus the docs the change touches and the schema-comment / doc-comment wording.

**Found and fixed (major, fixed inline because the fix sits in the constraint this ticket already edits):**
- The owner re-vouch branch of `CadrePeer.AuthorizedUpdate` can be replayed by any machine holding the row: the row's stored `VouchSig` is a valid re-vouch signature. Before review that branch left `PublicKey`, `Multiaddr` and `Sig` unconstrained, so a compromised member could rewrite another machine's key or addresses or blank its signature, and its records would fail to resolve until the next heartbeat. The implementer pinned only `Profile` for the same reason, which left the rule inconsistent. Now the branch pins all four columns the machine declares itself (`schemas/control.qsql` and `control-schema.ts`). The only legitimate owner-branch writer, `reauthorizeCadrePeer`, sets only `UpdatedAt` and the voucher columns, so nothing else changes. I updated its doc comment and the `docs/architecture.md` `CadrePeer` row.
- Test: I widened the implementer's test in `control-revocation-replay.spec.ts` (still one test) into "an owner re-vouch may not rewrite what the machine itself published". It tries each of the four columns, then checks that a plain re-vouch leaves the record exactly as published. I confirmed it fails with the `Multiaddr` clause removed.

**Tripwire:** the owner branch may still bump `UpdatedAt`, because the write-while-alone re-broadcast needs that. On a self-published row this leaves `Sig` unverifiable until the machine's next heartbeat re-signs past it. I recorded it as a `NOTE:` in the `AuthorizedUpdate` comment, with the fix to make if it ever matters: pin `UpdatedAt` when `old.Sig` is not null.

**Handed to a downstream ticket (an arm appended, not a new ticket):** `profile` and `lastPublishedAt` in the planned machine listing are trustworthy only on a row whose self-`Sig` verifies. I appended this to `tickets/implement/11.1-cadre-node-removes-a-machine.md`, the ticket that builds that listing.

**Tests:** the implementer's extensions to `peer-record.spec.ts` (tampering with the profile fails verification) and `digest-variadic-parity.spec.ts` (JS/SQL parity with a non-empty profile) each pin a contract, so I kept them. I cut nothing: the other test edits only add the `profile` field the new type requires.

**No findings:** error handling (a bad `profile` value fails loudly through `KnownProfile`), resource cleanup (no new resources), performance (one extra column and digest field), file size (no file grew materially).

**Validation:** `yarn workspace @serfab/cadre-core build`, `yarn lint` and `yarn typecheck` are clean. `yarn workspace @serfab/cadre-core test`: 165 files, 2448 passed, 1 skipped. I did not run the integration scenarios; the review changed only the owner branch, which the integration signer edits do not touch.
