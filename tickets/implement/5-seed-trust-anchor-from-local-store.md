----
description: Seed acceptance currently trusts any authority key that has synced into the shared database — but the spike proved a stranger can inject its own key there. Point seed-trust at the tamper-proof on-device anchor instead, closing the same hole on the seed path.
prereq: membership-authorized-predicate-and-gates
files:
  - packages/cadre-core/src/seed-trust-policy.ts (dbAnchoredTrustPolicy L53, pinnedKeyTrustPolicy L73, SeedTrustContext.knownAuthorityKeys L31)
  - packages/cadre-core/src/seed-bootstrap.ts (where applySeed builds SeedTrustContext.knownAuthorityKeys)
  - packages/cadre-core/src/control-database.ts (getAuthorityKeys L390 — the pollutable source to stop using as a trust anchor)
  - packages/cadre-core/src/cadre-node.ts (TrustedAuthorityStore wiring from ticket 3)
difficulty: medium
----

# Anchor seed-trust on the node-local store, not the replicated table

The spike in `membership-gate-authority-anchor-decision` surfaced a second consumer of
the same false anchor: `dbAnchoredTrustPolicy` (the *secure default* for accepting
control-network seeds) trusts a seed's signer iff its key is in
`SeedTrustContext.knownAuthorityKeys` — and `applySeed` sources that set from the
**replicated** `AuthorityKey` table (`control-database.ts getAuthorityKeys`). The spike
proved that table is polluted by a same-party self-authority. So a "secure default"
node can be made to accept a hostile seed by the same self-authority trick that beat
`isMember`. Same root cause, same fix: source the trust anchor from the node-local,
non-replicated `TrustedAuthorityStore` built in ticket 3.

## Change

Where `applySeed` populates `SeedTrustContext.knownAuthorityKeys`, source it from
`TrustedAuthorityStore.all()` instead of `ControlDatabase.getAuthorityKeys()`.
`dbAnchoredTrustPolicy` and `pinnedKeyTrustPolicy` need no signature change — they
already take `knownAuthorityKeys` as an injected set; we are only changing where that
set comes from. Update the `SeedTrustContext.knownAuthorityKeys` doc comment
(currently "sourced from its `AuthorityKey` table") to say node-local anchor, and
update the `seed-trust-policy.ts` header note (item 1 "DB-anchored") accordingly — the
anchor is now the local store, not the replicated table.

This also completes half of the deferred `seed-accepted-authority-persistence`: a node
that trusted a signer via a pinned/TOFU anchor persisted it into the local store
(ticket 3), so future seeds are anchored by that store without re-supplying the invite.
Note in the handoff whether the seed's `seed.transactions[]` application (the other half
of that backlog ticket) is still deferred (it is — do not pull it in here).

## Edge cases & interactions

- **Cold-start invitee** still accepts its first seed via the invite's pinned keys —
  because ticket 3 seeds those pins into the anchor at enrollment, `all()` already
  contains them. Verify the enrollment order: pins land in the anchor BEFORE the first
  `applySeed`.
- **TOFU path** (`tofuTrustPolicy`) unchanged, but a TOFU-accepted key should now be
  persisted into the anchor (ticket 3's `trust(k, 'operator'|'invite')`) so it sticks —
  confirm/wire, or note as the remaining `seed-accepted-authority-persistence` slice.
- **Steady-state enrolled node** behaves the same as before for *legitimate* authorities
  (they are in the anchor); the only behavior change is that a *replicated-but-never-
  pinned* authority is no longer trusted — which is the fix.
- **Existing seed-trust unit tests** that construct `knownAuthorityKeys` directly keep
  working (injected set); add/adjust an integration-ish test proving a
  replicated-only self-authority key does NOT make a seed acceptable.

## TODO

- Repoint `SeedTrustContext.knownAuthorityKeys` construction in `applySeed` to
  `TrustedAuthorityStore.all()`.
- Update the doc/header comments in `seed-trust-policy.ts` to name the node-local anchor.
- Ensure TOFU/pinned acceptances persist into the anchor (or explicitly scope out and
  reference `seed-accepted-authority-persistence`).
- Add coverage: a self-authority key present only via replication does not authorize a
  seed; a pinned/anchored key does.
- `yarn lint` / `yarn typecheck` / cadre-core + relevant integration tests green.
