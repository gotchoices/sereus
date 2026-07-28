----
description: Accepting a control-network invitation to join a group no longer trusts owner keys that arrived through the shared database, where a stranger could plant their own. It now uses the tamper-proof list kept on the device itself, and a key approved once is remembered so it need not be supplied again.
files:
  - packages/cadre-core/src/seed-trust-policy.ts
  - packages/cadre-core/src/seed-bootstrap.ts
  - packages/cadre-core/src/cadre-node.ts
  - packages/cadre-core/src/types.ts, src/index.ts
  - packages/cadre-core/test/{seed-bootstrap,cadre-node-seed-trust,ed25519-key}.spec.ts
  - docs/architecture.md, docs/cadre-host.md, docs/reference-app-rn.md, docs/STATUS.md
----

# Complete: seed trust anchored on the node-local store (step 5 of the membership chain)

Step 5 of the six-ticket membership chain. Steps 1–4 moved *membership* off the
replicated `CadreControl.OwnerKey` table onto the node-local, non-replicated
`TrustedOwnerStore`. This ticket did the same for the other consumer of that
false anchor: accepting a control-network seed.

## What shipped

**The anchor swap.** `SeedBootstrapConfig.trustedOwners` supplies
`SeedTrustContext.knownOwnerKeys` for every `applySeed`, replacing
`ControlDatabase.getOwnerKeys()`. `CadreNode` passes `getTrustedOwnerStore()`
into all three `SeedBootstrapService` construction sites (`initializeSeedBootstrap`,
`enableSeedListener`, and the throwaway service `applySeed` builds when no
service exists). A key that reached a node only by replication now authorizes no
seed.

**`dbAnchoredTrustPolicy` → `anchoredTrustPolicy`**, with the rejection reason
following it (`...not an anchored owner (anchored trust policy)`). The old name
asserted the wrong anchor in a security-critical default.

**Pin/TOFU acceptances persist.** `SeedTrustDecision.anchorAs` lets a policy that
trusted a signer via something other than the anchor report how to record it
(`pinnedKeyTrustPolicy` → `'invite'`, overridable; `tofuTrustPolicy` →
`'operator'`); `applySeed` then calls `trustedOwners.trust(...)`. A persist
failure is logged and does not fail the seed — `trust()` reflects in memory
synchronously, so only cross-restart durability is at stake.

**`createInvite` no longer hands out the replicated table.** The invitee anchors
whatever arrives in `CadreInvite.ownerKeys`, so sourcing those pins from the
pollutable table would have let a stranger's genesis-inserted key ride an
otherwise-legitimate invite into a fresh node's anchor. Invites now carry the
issuer's own anchor **and nothing else** (see findings — the review removed the
implementer's table fallback).

## Left in place deliberately

- `SeedPeer.isOwner` in seeds, and the owner-peer *preference* in
  `CadreNode.reconcileControlCohort`, still read the replicated table. Both are
  dial hints the receiver re-judges against its own anchor, so pollution costs a
  wasted dial while anchoring would drop legitimate co-owners a node never
  pinned. Both sites now carry a `NOTE:`.
- `dialInvite`'s temp service gets no store: it does not apply seeds.

## Review findings

### Checked

The implement diff read cold before the handoff; all three service-construction
sites and the anchor's lifecycle in `start()`; the inbound libp2p seed handler;
the invite-minting path; every remaining `getOwnerKeys()` caller in the repo; the
downstream consumers (cadre-cli, cadre-host donation, cadre-provider,
reference-app-rn, reference-app-web); every doc the change touched **and the ones
it should have**; source hygiene; and the test suite's coverage of happy path,
the security regression, error paths and the three wiring seams.

### Fixed in this pass (minor)

- **`createInvite` had a fail-open fallback to the replicated `OwnerKey` table**
  when no anchor was wired. That is the exact source the ticket exists to
  distrust, kept alive only because directly-constructed services (tests) have no
  anchor. Removed — `createInvite` is now anchor-only, and an issuer with no
  anchor mints an invite with no `ownerKeys` (an extra out-of-band step for the
  invitee, versus silently anchoring an unvouched key). `invitableOwnerKeys()`
  collapsed back into its one call site.
- **A test still asserted the OLD table-sourced invite behaviour.**
  `ed25519-key.spec.ts` → "includes the enrolled key in invite.ownerKeys" drives a
  `CadreNode` whose anchor is never wired, so it kept passing *through the
  fallback above* and its doc comment still claimed `ensureOwnerKey` is what puts
  keys in an invite. Rewritten as three tests that lock the real invariant: the
  invite carries what `initializeSeedBootstrap` genesis-anchored, never a
  replicated-only key, and nothing at all when the anchor is empty.
- **`enableSeedListener`'s anchor wiring was untested** — the one path with no
  per-call policy override, i.e. the inbound network path. The existing tests
  covered only policy *forwarding* at that site. Added a `CadreNode`-level test:
  a key inserted into the live `OwnerKey` table is refused, and a `trustOwnerKeys`
  pin flips the identical service to accept.
- **`pinnedKeyTrustPolicy`'s new `anchorAs` argument had no caller and no test.**
  Added one asserting an operator-sourced pin is recorded as `'operator'`, not
  `'invite'`. (Left in the API: cadre-cli pre-anchors its `CADRE_OWNER_KEYS` so it
  never reaches this branch today, but the alternative — dropping the argument —
  would silently mis-record provenance for the first operator pin that isn't
  pre-anchored.)
- **A ticket-4 comment was falsified by this ticket and not updated.** The
  `initializeSeedBootstrap` NOTE justified letting non-founder members
  self-anchor their own key with "the store never replicates and a node trusting
  itself grants nothing to others". `createInvite` now exports the anchor, so a
  non-founder that minted an invite would hand out its own non-authority key as a
  cadre owner key. Comment corrected to state the new consequence and the
  condition that makes it reachable (see Tripwires).
- **`docs/cadre-host.md` was missed entirely by the implement diff.** Its
  node-donation section still explained the `CADRE_OWNER_KEYS` pin as needed
  "because its control DB has no owner keys yet" — the discarded model, and
  misleading in the worst way (it implies waiting for control-sync would work,
  when it now never will). Rewritten.
- `docs/architecture.md` and `docs/STATUS.md` updated for the anchor-only invite
  rule and the `reconcileControlCohort` exception.
- **Backlog housekeeping the implement stage deferred to here.**
  `seed-accepted-authority-persistence` carried its own instruction to be re-read
  after this ticket and "either delete it or reduce it to the residue"; the
  residue is empty (its persistence half landed here, its `seed.transactions[]`
  half is `backlog/later/seed-warm-cache-prepopulation`, and that surface was
  removed from the code long ago) — **deleted**, with its live in-code reference
  cleaned up. `host-tofu-seed-trust-confirmation` refreshed: pre-rename
  `AuthorityKey` naming, a line-numbered reference that had drifted, an
  open question this ticket settled (a TOFU-confirmed key now persists as
  `'operator'`), and a jargon-dense `description:` a human could not triage.

### Filed as new work (major)

- `backlog/debt-integration-tests-detect-stale-build` — scenarios that spawn the
  real `cadre-cli` binary run it from `dist`, so an unbuilt workspace silently
  tests the previous build. Hit live during this review:
  `cadre-host-node-donation` failed steps 4–5 and 6 with 30s/90s timeouts that
  read exactly like a seed-trust regression, and passed 5/5 unchanged after
  `yarn build`. Worst precisely when the change under test is a security
  behaviour change, because "the node no longer accepts the seed" is a plausible
  outcome of the edit.

### Recorded as tripwires, not tickets

- `seed-bootstrap.ts` `applySeed` — `seed.partyId` is never checked against the
  service's own party. Harmless now (trust keys on `signerKey` vs a party-scoped
  anchor, and only a caller-supplied pin for that signer could write into it), so
  a `NOTE:` says to reject a mismatch if applying a seed ever branches on its
  partyId or the anchor becomes multi-party.
- `cadre-node.ts` `initializeSeedBootstrap` — the non-founder self-anchor
  described above; NOTE names `createInvite` as the export path and says to gate
  the self-anchor on the real `OwnerKey` genesis insert once a non-owner node can
  mint invites. Unreachable today: only cadre-cli and cadre-host mint invites,
  and reference-app-rn's phone never does.
- `cadre-node.ts` `reconcileControlCohort` — new NOTE explaining the owner
  preference stays on the replicated table on purpose, matching the existing
  `queryPeers` NOTE so the pair is greppable.

### Judgement calls the handoff flagged — all confirmed

`createInvite` sourcing from the anchor: agreed, and taken further (fallback
removed). The `anchoredTrustPolicy` rename: agreed, the old name was an active
hazard. `anchorAs: 'operator'` for TOFU: agreed; a dedicated `'tofu'` source
would touch the persisted file format for no behavioural gain. Swallowing the
persist failure: agreed — it is logged, tested, and the in-memory effect is
synchronous, so the seed is genuinely unaffected.

### Looked at and deliberately NOT filed

`cadre-node.ts` is 2890 lines and `seed-bootstrap.ts` 1104. Both are oversized by
this repo's own standards, but both are pre-existing, this diff added ~25 net
lines and no new responsibility to either, and the new code is well-decomposed
(`anchorAcceptedSigner` is a short single-purpose method). Splitting them is a
separate architectural decision; filing it from this review would be noise
attached to the wrong change.

No correctness defect was found in the anchor swap itself, and no production path
was found that had been relying on the replicated table to accept seeds —
re-verified against cadre-cli (`--pin-owner-key` / `CADRE_OWNER_KEYS` seed both
the anchor and the policy), cadre-host's owner node (genesis), donated
foreign-party nodes and cadre-provider tenants (`CADRE_OWNER_KEYS` on every
spawn), and reference-app-rn (`trustOwnerKeys` from the invite, before the first
`applySeed`). Those categories are genuinely empty, not skipped.

## Validation

- `yarn lint` clean, `yarn typecheck` clean (both re-run after the review edits).
- `packages/cadre-core`: **702 passed / 1 skipped** (51 files) — up from 699 at
  the implement commit (net +3 from the review's coverage changes).
- `cadre-cli` 94, `cadre-host` 448 / 3 skipped, `cadre-provider` 97,
  `reference-app-rn` 133 — all passed.
- Integration scenarios, run individually: `enrollment-e2e` +
  `deliver-seed-cross-network` (14 passed), `cadre-host-trust-circle` (passed),
  `cadre-host-node-donation` (5 passed — a real `cadre-cli` child with
  `CADRE_OWNER_KEYS` POSTing a real seed to `/seed`), and `push-wake-e2e`'s two
  anchor-relevant cases (both passed: "rejects a wake ... whose voucher owner is
  unanchored", "wakes a member whose authorization ... learned by control-DB
  replication").
- **Pre-existing failures, already tracked — not re-reported.** `push-wake-e2e`
  "wakes a hibernating member over a real direct control dial" and "delivers a
  wake to a NAT'd receiver over a circuit-relay (signaling-first) dial" both fail
  on optimystic's `membership-not-admitted:low-confidence-downsize` cluster
  error. Both are listed verbatim in `tickets/.pre-existing-known.md` against
  `control-db-convergence-optimystic-p2p` (blocked), so no
  `.pre-existing-error.md` was written and nothing was skipped or loosened.
- **Not run:** the full `packages/integration-tests` suite and
  `packages/quereus-plugin-sereus` e2e — both dominated by that same blocked
  convergence failure.

## Known gaps carried forward

- The React Native anchor is still in-memory, so a phone loses its invite-pinned
  trust on process restart and must re-paste the invite. Tracked by
  `backlog/feat-rn-trusted-owner-anchor-persistence`; this ticket makes it more
  visible, since the anchor is now load-bearing for seeds as well as membership.
- No test drives the inbound libp2p seed protocol between two *real*
  anchor-backed nodes end-to-end. The handler path is covered with a mocked
  libp2p, and each construction site's anchor wiring is now covered individually,
  but a two-real-node case in `deliver-seed-cross-network` would be
  belt-and-braces.
- Owner key **rotation** remains unhandled, exactly as in step 4: a node that
  pinned only the old key rejects seeds signed by the new one. Tracked by
  `flip-strand-membership-rotation-known-gap`.
- Step 6 of the chain (`membership-connection-gater`) is still open: an outsider
  can still *write* control rows, they are simply no longer believed.
