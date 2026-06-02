----
description: Persist cold-start-accepted authority keys and apply seed transactions so trust becomes DB-anchored
files: packages/cadre-core/src/seed-bootstrap.ts, packages/cadre-core/src/control-database.ts, schemas/control.qsql
----

After `seed-trust-policy-and-authority-identity` lands, a cold-start node (empty `AuthorityKey` table) can only accept a seed when the signer key is supplied out-of-band as a pinned key (via `CadreInvite.authorityKeys` or operator config), or via opt-in TOFU. The accepted key is **not** persisted, so every subsequent seed on a not-yet-fully-synced node still needs the pinned anchor — it never transitions to the DB-anchored steady state on its own.

Two related gaps, both deliberately deferred from the trust-policy ticket:

- **Persisting the accepted signer key.** Once a node trusts a signer via pinned/TOFU anchor, that key should become part of the node's local trust anchor so future seeds are DB-anchored. The `CadreControl.AuthorityKey` table is governed by signed-transaction constraints (`schemas/control.qsql:22-34`) and a local genesis insert is only valid when the table is empty, so a node joining an *existing* party cannot simply insert the key. Establishing it correctly belongs to the broader control-sync design (synced, signed authority-key transactions) — or, as an interim, a separate node-local pinned-trust store distinct from the control DB.

- **Applying `seed.transactions[]`.** `applySeed` currently ignores the seed's optional signed-transaction payload entirely; it only populates the peer store and dials. Applying those entries is the intended mechanism for pre-populating the control cache (including authority keys) on a new node.

Use case: a phone enrolls from an invite, applies the first seed using the invite's pinned authority keys, then on later restarts / later seeds should already trust the cadre's authorities from synced control state without re-supplying the invite.

This is a future concern dependent on the control-sync design, not active work — promote to plan when control-sync transaction application is being designed.
