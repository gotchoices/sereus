----
description: When a shared workspace decides which machines hold copies of its data, it should spread them across different people, not just different machines — otherwise "four copies" can mean four devices in one person's house.
prereq: strand-node-binds-member-peer
files: packages/quereus-plugin-sereus/src/cluster-size.ts, packages/cadre-core/src/strand-revocation-enforcer.ts, docs/architecture.md
tradeoffs: The common production case is a one-party workspace where this changes nothing, and the selection half lives upstream in Optimystic (its cohort selection takes no grouping label today) — building the label resolver before upstream can consume it delivers no user-visible benefit.
----

# Spread a strand's copies across parties, not just machines

With `strand-node-binds-member-peer` landed, a closed strand knows which machines belong to which party (`Strand.MemberPeer` joined to a live `Strand.Member`). Copy placement should use it: replication breadth currently counts machines by hash proximity with no notion of owner, so a multi-party workspace can keep every copy of a block on one party's machines while the configuration numbers look like they promise otherwise (`docs/architecture.md` → "Replication cluster size" records this honestly).

**Upstream dependency**: Optimystic's cohort selection takes no grouping label. Requested as `optimystic/tickets/backlog/feat-cohort-selection-owner-aware-placement`; both selection sites need it (`findCluster` and `spread-on-churn.ts`), or the property leaks back out as peers churn. This ticket is the Sereus half — the label resolver and its wiring — and cannot finish before the upstream half exists.

## Design constraints already settled (plan pass on `debt-cohort-selection-party-blind`, 2026-08-03 — recorded so nobody re-derives them)

- **The label is `Strand.MemberPeer.MemberKey` joined to a live `Strand.Member` row.** No new schema, no new wire field. The join is mandatory: a revoked party's stale binding must not earn diversity credit.
- **A peer bound to two different member keys counts as neither** — treat as unlabelled and log; a machine countable as either party could fake diversity.
- **The resolver must never touch the database on the selection path.** Cohort selection runs inside reads/writes of the very database the rows live in; a querying resolver re-enters the transactor. Shape: an in-memory snapshot refreshed out-of-band (the revocation enforcer's 30 s poll already reads exactly these two tables — natural place to share), read synchronously; unknown peer → no label.
- **Too few distinct parties must degrade to today's placement** — a one-party workspace keeps working unchanged; open strands have no member rows and must degrade, not fail.
- **The control network is permanently out of scope** — a cadre is one party by construction.
- **Self-asserted labels are trustworthy enough on a closed strand**: minting a binding needs a live member; binding many machines to one member only reduces that party's own diversity credit; one party admitted as several members is the invitation system's residual risk, not placement's.
- **Machine uptime stays a separate concern** — no replicated, signed representation of a node's storage-versus-edge profile exists; folding an unverifiable claim into a rule whose value rests on signed labels would weaken it.
