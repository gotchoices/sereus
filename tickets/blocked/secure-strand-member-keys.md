priority: 3
description: A team decision is needed on whether (and how) to protect closed-strand membership private keys on mobile — today they sit unencrypted in a database copied to every one of a party's own nodes, which is what makes any node able to serve the strand, but also means a stolen phone leaks them.
blocked-reason: design-sign-off
files: packages/cadre-core/src/strand-member-key.ts, packages/cadre-core/src/strand-formation-protocol.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/control-schema.ts, packages/cadre-core/src/key-store.ts, schemas/control.qsql, docs/architecture.md, docs/strands.md
difficulty: hard
----

> **Status: blocked on human/architecture sign-off.** The plan pass below resolved the
> research and the available options, but the call that must come first is a *threat-model /
> resourcing* decision with no defensible single default an agent can pick. Once the team
> answers **Decision 1** (and, if hardening is wanted, **Decision 2**), unblock this back into
> `plan/` and the concrete plan/implement chain in "What each answer unblocks" can be written.

## The one decision that gates everything

**Do we treat the at-rest exposure of closed-strand `MemberPrivateKey` on mobile as in-scope to fix now, or accept it as residual risk?**

This is not a mechanical port of the keystore work. It is a security/availability trade-off, and the cheapest real fix depends on infrastructure that does not exist yet (see below).

### Current state (verified this pass)

- `generateStrandMemberKey()` mints an Ed25519 key, base64-protobuf encoded (`strand-member-key.ts:14`). Formation issues the same shape and **delivers it over the wire** to the initiator in `FormationProvisionResult.memberPrivateKey` (`strand-formation-protocol.ts:58-68`), disclosed only after token + disclosure validation.
- It is persisted as **plaintext** in the control DB: `Strand.MemberPrivateKey` is a nullable `text` column (`control-schema.ts:42-50`, `schemas/control.qsql:31-50`), read back by `control-database.ts` `queryStrand()/queryStrands()` and loaded into `StrandInstance.memberPrivateKey` / the founder bootstrap (`strand-instance-manager.ts:201,297`).
- The control DB is an Optimystic database **replicated across all of the party's own cadre nodes** — this is deliberate and load-bearing: it is *what makes cadre nodes fungible* for closed strands. Any node has the key, so any node can serve/participate.
- **There is no cadre-wide shared-secret infrastructure.** The `KeyStore` seam (`key-store.ts`: `get/set/delete/list` over string slot ids like `cadre/identity`) and its RN secure-store backend are strictly **per-device**. There is no "party key" / "cadre key" / envelope key anywhere in the codebase. (This is exactly why member keys are plaintext-replicated: there is currently no other way to make a secret available to every node.)
- The keystore work (`keystore-interface-core` + `keystore-rn-secure-store`) already hardens the **peer identity key** (and the authority key derived from it) at rest. Those are the single-point-of-compromise node-identity keys. Member keys are per-strand and, by design, widely replicated — a different risk class.

### Why this can't be auto-resolved into an implement ticket

The plan rules say to pick the best defensible default and proceed. Here, the only option that does **not** sacrifice the deliberate fungibility property (envelope encryption, Decision 2 below) **requires building cadre-wide secret distribution first** — getting one shared envelope key into every node's enclave, including nodes that join the cadre later. That sub-problem is the *same* "share a secret across the cadre" problem member keys themselves embody, and it carries its own onboarding/availability/exposure design. So even committing to the most architecturally appealing option does not produce a self-contained, agent-runnable implement ticket — it commits the team to a foundational build. That is a resourcing + threat-model call, not a default.

## Recommendation (for the sign-off)

**Decision 1 — recommend: ACCEPT residual risk for now; defer hardening.** Rationale:

- The member key's at-rest exposure is bounded by the *same* app-storage boundary (mobile LevelDB) that holds the rest of the control DB's strand data. Protecting only the member key while the surrounding strand metadata stays in LevelDB is partial hardening for significant new machinery.
- The higher-value, harder-to-rotate keys (peer identity + derived authority) are *already* protected by the shipped keystore work. Member keys are per-strand, rotatable by re-forming, and intentionally replicated.
- Every real fix needs cadre-wide secret distribution that doesn't exist; building it speculatively, before there's a second consumer for it, is premature.

If sign-off **accepts residual risk**: the action is documentation only — record the explicit threat-model decision and the residual risk in `docs/strands.md` (closed-strand key handling) and the security notes in `docs/architecture.md`, and close this out. No code change.

**If sign-off instead wants hardening**, then **Decision 2 — recommended target: envelope encryption** (preserves fungibility), accepting that it pulls in a cadre-wide-key prerequisite.

## Decision 2 options (only if hardening is chosen)

| Option | Fungibility | At-rest protection | New infra required |
|---|---|---|---|
| **A. Per-device enclave only** (member key lives in one device's enclave, `keyId` ref in DB) | ❌ breaks — strand bound to that device | ✅ strong | enclave slot `strand/<id>/member` (exists conceptually) |
| **B. Replicate key to a chosen subset of nodes' enclaves** | ⚠️ partial (quorum of nodes) | ✅ strong | a key-distribution protocol to selected nodes' enclaves |
| **C. Envelope-encrypt the DB column with a per-cadre key held in each node's enclave** *(recommended)* | ✅ preserved | ✅ protects the DB-at-rest copy | **cadre-wide envelope-key provisioning + distribution to every node's enclave, incl. late joiners** |
| **D. Store only `keyId` ref in DB; resolve material from local enclave** | ❌ reduced availability | ✅ strong | per-node enclave material + miss-handling when a node lacks it |

Option C is the only one that keeps the deliberate fungibility property, which is why it's recommended *if* hardening proceeds — but its prerequisite (cadre-wide secret distribution) is the real cost and the reason this needs a deliberate go-ahead.

### Cross-cutting concern for any hardening option: the formation handshake

`strand-formation-protocol.ts` currently puts the raw `memberPrivateKey` on the wire (`FormationProvisionResult`, line 58-68) and the initiator records it into its control DB. Any hardening direction must answer how formation delivers the secret:
- Option C: the initiator must envelope-encrypt the received key under *its* cadre key before persisting — so the wire still carries raw material; protection is purely at-rest on each side. (Simplest; the wire trust model is unchanged.)
- Options A/B/D: formation may need to deliver to a specific enclave / subset rather than "record in DB," changing the provision-then-record contract.

## Edge cases & interactions (carry forward into whichever plan follows)

- **Late-joining cadre node**: how does a node added to the party *after* a closed strand exists obtain the ability to serve it? (Plaintext-replication answers this for free today; A/B/C/D each must re-answer it.)
- **Cadre key rotation / compromise** (Option C): rotating the envelope key means re-encrypting every strand's column across the replicated DB.
- **Enclave-unavailable / biometric-invalidated** (A/C/D): a node whose enclave slot is wiped (the gated-slot regeneration-guard case already handled for identity keys) must fail closed, not silently regenerate or lose strand participation.
- **Mixed-platform cadre**: a party with both Node (FileKeyStore) and RN (secure-store) nodes — the envelope/distribution scheme must work across both KeyStore backends.
- **Backward/data migration**: existing plaintext `MemberPrivateKey` rows must migrate to whichever scheme is chosen (or the decision explicitly scopes to new strands only).

## What each answer unblocks

- **Decision 1 = accept residual risk** → unblock to `plan/` (or directly do the doc edits): a small doc-only ticket recording the threat-model decision in `docs/strands.md` + `docs/architecture.md`. Done.
- **Decision 1 = harden, Decision 2 = C** → unblock to `plan/`: write a **`prereq:`-chained pair** — (1) `cadre-shared-key-distribution` (foundational: provision a per-cadre key + distribute to every node's enclave, incl. onboarding) and (2) `envelope-encrypt-strand-member-key` (depends on #1: encrypt the `Strand.MemberPrivateKey` column on write, decrypt on `queryStrand`, migrate existing rows, update the formation record step).
- **Decision 1 = harden, Decision 2 = A/B/D** → unblock to `plan/`: write the corresponding plan against that option's availability model, including the formation-contract change.

## TODO once unblocked (do NOT start before sign-off)

- Record the Decision-1 (and Decision-2, if any) answer at the top of this ticket, then move it back to `plan/`.
- Write the follow-on plan/implement ticket(s) per "What each answer unblocks", carrying the "Edge cases & interactions" list into each as the adversarial surface.
