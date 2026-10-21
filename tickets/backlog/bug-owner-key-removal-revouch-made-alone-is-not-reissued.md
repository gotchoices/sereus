description: When an owner removes an owner key while their device has no connection to the rest of the cadre, the devices they chose to keep may still be dropped by every other machine once it reconnects, because the "keep" step is not re-sent the way the removal itself is.
architecture: docs/architecture.md#removing-an-owner-key
files: packages/cadre-core/src/cadre-node.ts (removeOwner, revouchDependents, ownerKeyWriteAlone, noteControlWrite, reissuePendingPeerWrites), packages/cadre-core/src/owner-keys.ts (OWNER_KEY_REMOVAL_REFUSAL_REASON), packages/cadre-core/src/types.ts (OwnerKeyRemovalRefusal), docs/architecture.md (Removing an owner key, Writes made while alone)
repro: static
severity: wrong-result
likelihood: unusual
tradeoffs: It needs the remover to be offline at the moment of removal while the party has other members, and refusing that case outright (the simplest fix) makes the unit specs, which run one node with no connections, need a connected setup for every re-vouch case.
----

# A re-vouch made by `removeOwner` while alone is not re-issued

## What happens

`CadreNode.removeOwner(key, { revouch: { peers } })` re-vouches the chosen `CadrePeer` rows under the remover's key (`revouchDependents` → `SeedBootstrapService.reauthorizePeer`), then removes the `OwnerKey` row. The removal's `Revocation` tombstone rides the committed-delete seam, so when the remover had no control connection it is queued and re-issued on cohort growth (`noteGuardedDelete` → `drainPendingRevocations`).

The re-vouches are not queued: `revouchDependents` never calls `noteControlWrite`. Even if it did, the re-touch the drain calls (`ControlDatabase.reauthorizeCadrePeer` in its `'rebroadcast'` mode) writes nothing over a row that carries a `Sig` and reports it self-published, on which `reissuePendingPeerWrites` clears the entry; a running device's row always carries one. The first-growth sweep re-touches only rows without a `Sig`. So after reconnecting, the other machines receive the tombstone (the removed key leaves their anchors) but not the new voucher, and every kept device whose row stood on the removed key stops passing their membership check.

The same applies to the remover's own row, which `removeOwner` re-vouches unasked when the removed key vouched it (`OwnerKeyRemovalPlan.revouchesOwnRow`), though there the remover's own heartbeat republish may carry it; that is unverified.

The doc comment on `revouchDependents` says "The peer re-touches are re-issued by the existing drain"; that is the claim this ticket finds false. `OwnerKey` re-vouches are already refused `alone` for the matching reason (no re-issue path).

## How to confirm

An integration scenario: A, B and C in one cadre, C's row vouched by B's owner key. Disconnect A, call `A.removeOwner(bKey, { revouch: { peers: [C] } })`, reconnect, and check whether B and C's other peers still list C as an authorized member once A's tombstone has replicated.

## Expected

A device the user chose to keep stays a member on every machine, whether or not the remover was connected when it removed the key. Either the re-vouch is re-issued on growth like the tombstone, or `removeOwner` refuses `alone` for any re-vouch (peer rows and the remover's own row included), as it already does for owner re-vouches, so the user retries once connected.
