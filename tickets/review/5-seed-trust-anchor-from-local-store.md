description: Accepting a control-network seed no longer trusts owner keys that arrived through the shared database, because a stranger can put its own key there. Seed acceptance now uses the tamper-proof on-device list instead, and a key accepted from an invite or an operator confirmation is remembered so it does not have to be supplied again.
prereq: membership-authorized-predicate-and-gates
files:
  - packages/cadre-core/src/seed-trust-policy.ts (anchoredTrustPolicy rename, SeedTrustDecision.anchorAs, doc rewrite)
  - packages/cadre-core/src/seed-bootstrap.ts (SeedBootstrapConfig.trustedOwners, applySeed anchor source, anchorAcceptedSigner, invitableOwnerKeys, queryPeers NOTE)
  - packages/cadre-core/src/cadre-node.ts (store passed into all three SeedBootstrapService construction sites)
  - packages/cadre-core/src/types.ts, src/index.ts (export rename, CadreInvite.ownerKeys doc)
  - packages/cadre-core/test/seed-bootstrap.spec.ts, test/cadre-node-seed-trust.spec.ts
  - packages/cadre-cli/src/server/health.ts, packages/cadre-host/src/donation/donation-service.ts, packages/cadre-provider/src/service/orchestrator.ts (comments only)
  - packages/reference-app-rn/test-fixture/start.mjs (comment only)
  - packages/integration-tests/src/scenarios/{enrollment-e2e,deliver-seed-cross-network}.integration.ts (comments only)
  - docs/architecture.md, docs/reference-app-rn.md, docs/STATUS.md
difficulty: medium
----

# Review: seed trust anchored on the node-local store (ticket 5 of the membership chain)

Step 5 of the six-ticket membership chain. Steps 1–4 moved *membership* off the
replicated `CadreControl.OwnerKey` table onto the node-local, non-replicated
`TrustedOwnerStore`. This ticket does the same for the other consumer of that
false anchor: accepting a control-network seed.

## Naming note carried forward

Tickets 4/5/6 were written before the `AuthorityKey`→`OwnerKey` rename, so the
ticket text says `TrustedAuthorityStore` / `knownAuthorityKeys` /
`AuthorityKey`. The codebase spellings are `TrustedOwnerStore` /
`knownOwnerKeys` / `OwnerKey`. Same objects.

## What changed

**The anchor swap (the ticket's core ask).** `SeedBootstrapConfig` gained
`trustedOwners?: TrustedOwnerStore`. `applySeed` now builds
`SeedTrustContext.knownOwnerKeys` from `trustedOwners.all()` instead of
`ControlDatabase.getOwnerKeys()`. `CadreNode` passes `getTrustedOwnerStore()`
into all three service-construction sites (`initializeSeedBootstrap`,
`enableSeedListener`, and the throwaway service `applySeed` builds when no
service exists). No policy signature changed — the set is still injected.

**Rename: `dbAnchoredTrustPolicy` → `anchoredTrustPolicy`.** Beyond the ticket's
literal ask (it only required updating the header note), because a name
asserting "DB" is exactly the wrong instruction for the next reader of a
security-critical default. The rejection reason changed with it
(`...not an anchored owner (anchored trust policy)`), so two assertions in
`cadre-node-seed-trust.spec.ts` moved from `/DB-anchored trust policy/` to
`/anchored trust policy/`. The export is public; no non-test caller used it.

**Pin/TOFU acceptances now persist (the ticket's third TODO, done not deferred).**
`SeedTrustDecision` gained `anchorAs?: Exclude<TrustSource, 'genesis'>`. A policy
that trusted a signer via something OTHER than the anchor reports how to record
it: `pinnedKeyTrustPolicy` → `'invite'` (overridable via a second arg),
`tofuTrustPolicy` → `'operator'`. `applySeed` then calls
`trustedOwners.trust(signerKey, anchorAs)`. `anchoredTrustPolicy` never sets it
(already anchored ⇒ nothing to write), and a rejected signer never reaches the
call. A persist failure is logged and does NOT fail the seed — `trust()` reflects
in memory synchronously, so only cross-restart durability is at stake.

**Scope added deliberately: `createInvite` no longer hands out the replicated
table.** Not in the ticket. The invitee anchors whatever arrives in
`CadreInvite.ownerKeys` (`CadreNode.trustOwnerKeys(..., 'invite')`), so sourcing
those pins from the pollutable table let a stranger's genesis-inserted key ride
an otherwise-legitimate invite straight into a fresh node's anchor — the same
root cause, one hop upstream, and it would have defeated tickets 3/4/5 at
enrollment. `createInvite` now emits the issuer's own anchor, falling back to the
table only when no anchor is wired at all (a directly-constructed
`SeedBootstrapService`, i.e. tests). **This is the change most worth a second
opinion** — see "Judgement calls" below.

## What did NOT change

- The other half of backlog `seed-accepted-authority-persistence` — applying a
  seed's `seed.transactions[]` — is still deferred, per the ticket. Only the
  accepted-key-persistence half landed here.
- `queryPeers` still derives `SeedPeer.isOwner` from the replicated table. That
  flag is a dial hint the receiver re-judges against its own anchor, so pollution
  costs a wasted dial, while anchoring it would drop legitimate co-owners a node
  never pinned. Left with a `NOTE:` at the site (tripwire, see below).
- `CadreNode.reconcileControlCohort` still uses `getOwnerKeys()` to *prefer*
  owner peers when picking dial targets — same reasoning, not a trust decision.
- `dialInvite`'s temp service gets no store: it does not apply seeds.

## Use cases to test / validate

**The security property.** A key present ONLY via replication authorizes no
seed. Covered at two levels: mocked (`seed-bootstrap.spec.ts` — anchor holds the
owner, replicated set holds owner+attacker, attacker seed rejected and owner seed
still accepted in the same service) and against a live Quereus control DB
(`applySeed — anchored trust against a real control DB`, and
`cadre-node-seed-trust.spec.ts` → "a key present only in the replicated OwnerKey
table does not authorize a seed", which does a real `insertOwnerKey` of the
attacker key first).

**Cold-start invitee still works, and only needs the invite once.** RN
enrollment calls `trustOwnerKeys(invite.ownerKeys, 'invite')` before `applySeed`,
so pins are in the anchor before the first seed — verified by reading
`use-cadre.ts:289-295` and `CadreNode.start()` (the store is built at
`cadre-node.ts:412`, before any network bring-up). The persistence path is
covered by "a pin-accepted signer is anchored on the node, so a later seed needs
no pin" (`cadre-node-seed-trust.spec.ts`) and its service-level twin.

**Operator/donation deployments.** `cadre-cli start` seeds the anchor from
`--pin-owner-key` / `CADRE_OWNER_KEYS` AND builds a `pinnedKeyTrustPolicy` from
the same list, so both paths accept. Validated for real by
`cadre-host-node-donation.integration.ts` (5/5 green): it spawns an actual
`cadre-cli` child with `CADRE_OWNER_KEYS` and POSTs a real seed to `/seed`.

**The behavior change to look for in review:** a node whose anchor was never
seeded but whose `OwnerKey` table has synced now REJECTS seeds it previously
accepted. That is the fix, and every production path was checked to have a pin:
cadre-cli (pins/genesis), cadre-host owner node (genesis), donated foreign-party
nodes and cadre-provider tenants (`CADRE_OWNER_KEYS` on every spawn), RN
(invite). No path was found that relied on the replicated table alone.

## Judgement calls a reviewer should second-guess

- **`createInvite` sourcing from the anchor.** For a multi-owner cadre, a
  co-owner that is in the replicated table but NOT in this node's anchor now
  gets dropped from invites this node mints. That is fail-closed and consistent
  with the rest of the chain, but it is a real narrowing and it was my call, not
  the ticket's. If a reviewer disagrees, the revert is `invitableOwnerKeys()`.
- **The `anchoredTrustPolicy` rename** is churn the ticket did not ask for.
- **`anchorAs: 'operator'` for TOFU.** A human confirming at a console is closest
  to an operator pin, but `TrustSource` has no dedicated `'tofu'` value. Adding
  one would touch the store's persisted file format, so it was not done.
- **Persist failures are swallowed with a log.** Deliberate (the key is trusted
  for the session either way), covered by a test, but it is a "don't eat
  exceptions" judgement worth confirming.

## Tripwires (parked in code, not filed as tickets)

- `seed-bootstrap.ts` `queryPeers`: `NOTE:` explaining `SeedPeer.isOwner` stays
  on the replicated table on purpose, and what would have to become true
  (`isOwner` gating something the receiver trusts) to force a move.
- `seed-bootstrap.ts` `insertCadrePeerRow` / `reauthorizePeer` already carry
  ticket-2/4 `NOTE:`s about StampId replay and voucher rebinding; unchanged, but
  they sit in the same file a reviewer will read.

## Validation run

- `yarn lint` — clean. `yarn typecheck` — clean.
- `packages/cadre-core`: 699 passed / 1 skipped (51 files). Was 682/1 before;
  the delta is this ticket's new coverage.
- `packages/cadre-cli` 94, `packages/cadre-host` 448/3 skipped,
  `packages/cadre-provider` 97, `packages/reference-app-rn` 133 — all passed.
- Integration scenarios run individually: `enrollment-e2e` +
  `deliver-seed-cross-network` (14 passed), `cadre-host-node-donation`
  (5 passed), and the two anchor-relevant `push-wake-e2e` cases (both passed —
  "rejects a wake ... whose voucher owner is unanchored" and "wakes a member
  whose authorization ... learned by control-DB replication").
- **Pre-existing failures, already tracked — NOT re-reported.** Three tests in
  the run failed with optimystic's
  `membership-not-admitted:low-confidence-downsize` cluster error:
  `push-wake-e2e` "wakes a hibernating member over a real direct control dial",
  `push-wake-e2e` "delivers a wake to a NAT'd receiver over a circuit-relay
  (signaling-first) dial", and `control-cohort-auto-convergence` "B converges on
  an owner-written CadrePeer row ...". All three are listed verbatim in
  `tickets/.pre-existing-known.md` against `control-db-convergence-optimystic-p2p`
  (blocked), so no `.pre-existing-error.md` was written.
- **Not run:** the full `packages/integration-tests` suite (dominated by the
  blocked optimystic convergence failures above) and
  `packages/quereus-plugin-sereus` e2e (also on that blocked list).

## Known gaps handed to the reviewer

- The React Native anchor is still in-memory, so an RN phone loses its
  invite-pinned trust on process restart and must re-paste the invite. The
  persistence half of that is `backlog/feat-rn-trusted-owner-anchor-persistence`;
  this ticket makes it slightly more visible (the anchor is now load-bearing for
  seeds too, not just membership).
- No test drives the inbound libp2p seed-protocol handler with a real
  anchor-backed `CadreNode` end-to-end; the handler path is covered with a mocked
  libp2p (`cadre-node-seed-trust.spec.ts`, ack-reason test) and the
  configured-default forwarding is covered per-construction-site. A reviewer who
  wants belt-and-braces could add a two-real-node case to
  `deliver-seed-cross-network`.
- Owner key ROTATION remains unhandled here exactly as in ticket 4: a node that
  pinned only the old key rejects seeds signed by the new one. Tracked by
  `flip-strand-membership-rotation-known-gap`.
