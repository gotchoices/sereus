priority: 3
description: Decide how to protect closed-strand member private keys at rest given they currently live in the replicated control DB (secure-enclave per-device storage conflicts with cadre-node fungibility)
files: packages/cadre-core/src/strand-member-key.ts, packages/cadre-core/src/strand-solicitation.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/control-schema.ts, packages/cadre-core/src/strand-formation-protocol.ts, schemas/control.qsql, docs/architecture.md, docs/strands.md
----

The mobile secure-key-storage plan listed **strand member keys** (`StrandInstance.memberPrivateKey`) as needing the same at-rest protection as peer identity keys. Investigation surfaced a genuine design tension that needs a human/architecture call before any implementation, so it is parked here rather than emitted as an implement ticket.

### The tension

Closed-strand membership keys are Ed25519 private keys generated during strand formation (`generateStrandMemberKey()` in `strand-member-key.ts`; also `strand-solicitation.ts` formation path) and persisted in the **control database** as `Strand.MemberPrivateKey` (base64 protobuf text column; see `control-schema.ts` / `schemas/control.qsql`, read back by `control-database.ts` `queryStrands()`/`queryStrand()` and consumed by `strand-instance-manager.ts` to bring up the strand node).

The control DB is an Optimystic network **replicated across all of the party's own cadre nodes**. Storing the member key there is deliberate: it makes cadre nodes **fungible** — any of the party's nodes can serve / participate in the closed strand because they all have the membership key.

Moving member keys into a per-device platform secure enclave (iOS Keychain / Android Keystore), as the at-rest-protection goal implies, **breaks that fungibility**: only the single device that generated/holds the key in its enclave could participate in the strand. This is a real semantic trade-off (key-at-rest hardening vs. multi-node strand availability), not a mechanical port — which is why the `keystore-rn-secure-store` ticket scoped member keys out.

The `KeyStore` interface from `keystore-interface-core` *can* represent member keys (e.g. slot ids like `strand/<strandId>/member`), so the interface does not preclude any chosen direction — the open question is the **data-flow / availability model**, not the storage primitive.

### Questions to resolve (needs human/architecture sign-off)

- Is per-device enclave isolation of member keys actually desired, accepting that a strand becomes bound to specific device(s) rather than the whole cadre? Or is the control-DB replication of member keys an acceptable residual risk on mobile (the control DB itself sits in app storage, which on mobile is the LevelDB we're otherwise trying to move keys out of)?
- If hardening is wanted, what is the availability model? Options to weigh:
  - Replicate the member key to a chosen subset of nodes' enclaves (quorum/availability vs. exposure trade-off).
  - Keep the key in the control DB but encrypt it with a per-cadre key that itself lives in enclaves (envelope encryption) — preserves fungibility while protecting the DB-at-rest copy.
  - Store only a reference (keyId) in the control DB and resolve material from each node's local enclave, accepting reduced availability.
- Whichever direction: what happens to the provision-then-record formation handshake (`strand-formation-protocol.ts`), which currently delivers `memberPrivateKey` over the wire to the initiator and records it in the DB?

### Why backlog, not implement or blocked

This is adjacent hardening discovered during the mobile-key-storage pass, not active in-flight code awaiting a missing prerequisite. It needs a design decision (availability vs. exposure) with no defensible single default, so it should be promoted into `plan/` once the team decides the desired model — at which point a concrete plan/implement ticket can be written against one of the options above. The primary plan goal (protecting peer identity + derived authority keys at rest on mobile) is fully delivered by `keystore-interface-core` + `keystore-rn-secure-store` without touching this.
