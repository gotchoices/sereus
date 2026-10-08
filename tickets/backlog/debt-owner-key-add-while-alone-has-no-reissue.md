description: Adding a second owner while the owner's phone has no connection to the rest of the cadre commits only on that phone and is never re-sent later, unlike a device addition or a removal, so the new owner may never reach the other machines.
prereq: owner-anchor-revocation-signer-and-owner-writers
architecture: docs/architecture.md#writes-made-while-alone
files: schemas/control.qsql, packages/cadre-core/src/control-schema.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/seed-bootstrap.ts
repro: static
tradeoffs: The owner-online flows add owners while connected, an invitation carries its own row in the bundle so the admitting member seats it, and the fix needs a re-issue counter and an update branch on a table whose no-update rule is load-bearing; a maintainer may prefer to refuse the add while alone instead.
----

# An owner-key add committed while alone has no re-issue path

`docs/architecture.md` → "Writes made while alone": a write committed with no control connection is local-only and forks this node's history unless it is re-issued on the next cohort-growth edge. `CadrePeer` rows are re-touched through an owner-signed `UpdatedAt` bump (`reauthorizePeer`); deletes ride their re-issuable `Revocation` tombstone. `OwnerKey` has neither: `NoUpdate` forbids any update (an update branch would let the sole owner be re-pointed at another key under a post-image count of one), and a repeated insert matches an existing row.

`CadreNode.addOwner` (landed by `owner-anchor-revocation-signer-and-owner-writers`) therefore logs loudly when it commits alone and does nothing more. The founder's genesis row has the same property and is harmless only because the first joiner receives the whole store by catch-up push; an add made by an owner that already has siblings, while disconnected from all of them, is the case this ticket is about.

What would confirm it: `control-write-while-alone-convergence.integration.ts` extended with an `addOwner` made while the owner is alone, then a reconnect; the row is expected not to reach the reader.

## Options

- A `ReissuedAt` counter on `OwnerKey` with an `AuthorizedReissue` update branch that pins every other column (`Key`, `StampId`, the three vouch columns) and moves only the counter upward under a distinct `'reissue'` digest, exactly as `Revocation` does; `CadreNode` queues the key in `noteControlWrite` and the growth drain bumps it. `NoUpdate` becomes "no update but the re-issue".
- Refuse `addOwner` while the node holds no control connection and the party has other members (`authorizedControlPeers` non-empty). Simpler; the owner retries once connected. Costs the solo-founder-adds-a-second-key flow nothing, because a party with no siblings cannot fork.

The second is the smaller change and fits how the apps add owners (through an invitation, or while connected to the always-on node).
