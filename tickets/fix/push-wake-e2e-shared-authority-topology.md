description: A push-wake test pretends two machines in the same party can each crown themselves the boss, but now that they share one replicated control database only the first one wins — so the test needs to be reworked around a single shared authority.
prereq: control-db-network-backed
files: packages/integration-tests/src/scenarios/push-wake-e2e.integration.ts (the skipped "NAT'd receiver over a circuit-relay" test ~257; makeOwnAuthority ~154; the direct-dial sibling ~212), packages/cadre-core/src/control-database.ts (insertAuthorityKey / ensureAuthorityKey), packages/cadre-core/src/control-schema.ts (AuthorityKey.Authorized bootstrap branch ~18-27)
difficulty: medium
----

## Background

`control-db-network-backed` made the `CadreControl` tables a **party-shared, replicated**
store (default vtab → Optimystic network transactor). A direct consequence: a party now
has ONE shared `AuthorityKey` table, so two nodes can no longer each self-appoint as a
genesis authority via `makeOwnAuthority` (which calls `insertAuthorityKey` and relies on
the schema's bootstrap branch `(select count(1) from AuthorityKey) <= 1`).

The push-wake e2e scenario `delivers a wake to a NAT'd receiver over a circuit-relay`
bootstraps BOTH the sender `S` and the NAT'd receiver `Rx` to the same relay `L`, so the
control-collection cohort forms during start. By the time `makeOwnAuthority(Rx)` runs, `S`'s
`AuthorityKey` has already replicated into the shared collection, so Rx's genesis insert
sees `count = 1` (S's key) and the bootstrap branch is false — Rx has no cross-authority
signature, so the deferred `Authorized` CHECK fails with `CHECK constraint failed: Authorized`.

This is the **correct** shared-authority semantic, not a regression in the network-backing
work. The test was authored for the in-memory era when each node had an ISOLATED control DB
and could be its own authority. It was **skipped** (with a pointer to this ticket) when
`control-db-network-backed` landed so the integration suite stays green; this ticket
re-authors it for the network-backed world.

Note the direct-dial sibling test (`wakes a hibernating member over a real direct control
dial`) still passes: its nodes have NO `bootstrapNodes`, so they genesis BEFORE forming a
cohort and each commits its `AuthorityKey` local-only. That timing-luck pass is itself
fragile and worth revisiting here.

## Expected behaviour to design for

In a network-backed party there is a single authority lineage. The receiver's wake gate
must recognise the sender as a member via the **shared, replicated** control state, not via
the receiver self-appointing as an independent authority. Options the implementer should
weigh (this overlaps `2-push-wake-replication-backed-authorization`, which owns the
production authorization flow — coordinate, don't duplicate):

- Have ONE node (e.g. `S`) be the party authority; it `authorizePeer`s both itself and `Rx`,
  and the membership/peer rows replicate so `Rx`'s wake gate sees `S` over the shared store.
- Or give both nodes the SAME authority key (a shared founder), so neither re-genesises.

The fix is a test/topology rework (and possibly a small helper for "join an existing party's
authority" rather than `makeOwnAuthority`). Do not weaken the `AuthorityKey.Authorized`
bootstrap semantics — two independent self-genesis authorities SHOULD collide on a shared
network.

## Acceptance

- The circuit-relay NAT'd-receiver push-wake scenario is un-skipped and passes against the
  network-backed control DB, exercising the real relayed wake delivery.
- The authority/membership setup reflects a single shared party authority (no two-node
  self-genesis in one party).
- The direct-dial sibling remains green (and ideally no longer depends on genesis-before-cohort
  timing luck).
