# Cadre Control Consistency Model

**Status**: Design exploration. Not yet implemented. Captures a target architecture for the cadre control network's consistency model, intended to sit between Optimystic's synchronous quorum semantics and Quereus Sync's eventually-consistent CRDT semantics.

## Motivation

The cadre control network has two pressures that the current toolkit doesn't fully reconcile:

1. **Cadre members are often unreachable.** Mobile devices, sleeping laptops, NAT'd nodes — a super-majority quorum at transaction time means an authority holder with several offline nodes can be locked out of their own cadre.
2. **Some changes are still constraint-bearing.** Membership, role assignment, formation invites, and key revocation aren't arbitrary writes — they have integrity rules that the network as a whole should respect.

Optimystic's `Right-is-Right` ([details](../../optimystic/docs/right-is-right.md)) solves the second concern with cluster validation + escalation, but synchronously: a dispute blocks the transaction. Quereus Sync ([details](../../quereus/docs/sync.md)) solves the first with offline-first CRDT replication, but discards SQL constraints and transactional atomicity in the process.

The cadre control network needs **both** properties: a holder of a locally-integrity-satisfying change should be able to commit and proceed, and a holder of new information that invalidates a previously-accepted change should be able to reconcile without violating convergence.

## Two Layers

The design separates two concerns that have been conflated in earlier discussion:

| Layer | Concern | Mechanism |
|-------|---------|-----------|
| **Authority** | Quorum requirement for committing a change | Asynchronous Right-is-Right (this doc) |
| **Replication** | Propagating committed changes between cadre members | Quereus Sync with transactional extensions (this doc) |

They meet at one specific place: when a sync apply discovers that an arriving change is inconsistent with locally-known state, the reconciliation procedure invokes the authority layer (compensation + optional dispute).

## Authority Model: Asynchronous Right-is-Right

### Default Mode

The cadre control network runs in **asynchronous validation mode** by default:

1. The originator validates the change locally against its own integrity rules (signatures verified, single-record CHECKs satisfied, schema-shape correct).
2. If locally valid, the change commits **immediately at the originator**. No quorum required.
3. The change propagates to other cadre members lazily (via the replication layer).
4. Each receiving member re-validates the change against its own state.
5. If re-validation passes, the receiver records it as a committed change.
6. If re-validation fails, the receiver emits a **compensating change** (see below) and may optionally raise an **asynchronous dispute** against the originator.

A change is therefore "locally committed" at the moment of authoring, "tentatively replicated" while in flight, and "globally committed" once it has propagated to all live cadre members without compensation. There is no synchronous quorum decision.

### Validity Has a Causal Context

In synchronous Right-is-Right, a peer rejecting validity means "this change is wrong." In the asynchronous model, the meaning weakens:

- The originator's endorsement now means *"valid given the state I had observed at HLC = H."*
- A receiver rejecting at HLC = H′ with more information is not asserting that the originator was malicious or buggy — they are noting that **the global picture invalidates the change**.
- Each change carries a `causalContext` field: the set of HLCs (or transaction IDs) the originator had observed at commit time. This lets the receiver distinguish "concurrent conflict" (no fault) from "should-have-known violation" (originator's fault).

### Outcomes of Re-Validation

When a member re-validates an incoming change against current local state, the outcome is one of three:

| Outcome | Meaning | Response |
|---------|---------|----------|
| **Pass** | Change is consistent with local state | Apply, mark committed |
| **Concurrent-invalid** | Two locally-valid changes conflict because their authors didn't see each other (causally concurrent) | Emit compensation; no penalty |
| **Should-have-known invalid** | The originator's `causalContext` included the information that would have rejected the change | Emit compensation **and** raise async dispute; reputation penalty on originator |

The distinction between concurrent-invalid and should-have-known is the only thing the `causalContext` field is for. It is not consulted during normal operation.

### Asynchronous Dispute

When the should-have-known case is detected, the existing Right-is-Right escalation machinery applies almost unchanged:

- A dissent coordinator is selected deterministically from cadre members that have observed the offending change.
- The dispute escalates by enlisting additional cadre members (and, if needed, additional rings).
- The disputed claim is *"did the originator have causal access to the rejecting information?"* — a deterministic, post-hoc question. All re-validators reach the same answer given the same causal evidence.
- Resolution applies reputation penalties and, in repeat cases, ejection from the cadre.

Disputes never block subsequent transactions. They run alongside normal traffic.

## Convergence Primitive: Compensation, Not Rollback

A change that has been propagated cannot be unaccepted — peers may have derived state, signed artifacts, or made downstream changes based on it. The convergence primitive is therefore **compensation**:

- A receiver discovering an invariant violation issues a new change, signed by themselves, with a higher HLC, that restores the invariant. Concrete examples:
  - Two members concurrently granted the same exclusive role to different parties → compensator revokes the role assignment with the lower HLC.
  - Member X added by A; member X simultaneously banned by B → compensator records the membership as `revoked` regardless of which arrived first.
  - Duplicate identity insertions → compensator keeps the lower-HLC identity, marks the other a duplicate-of pointer.
- The original change remains in history (auditable, traceable to the originating signature).
- Live state reflects the compensated form.
- Compensations propagate like any other change. Replicas converge on `(C, then compensation)` — same end state regardless of arrival order.

This pattern is the same one used by financial systems: bad transactions are not rewound; they are corrected forward with traceable adjustments.

## Replication Layer: Sync with Transactional Extensions

The replication layer is Quereus Sync, extended in three ways so that the authority layer above can rely on it:

### 1. Transaction-Grouped HLC

Today, each column change carries its own HLC. Extension: a single HLC per `ChangeSet`, shared by all changes in that transaction.

- The `ChangeSet` already groups by `transactionId` (`quereus-sync/src/sync/protocol.ts`).
- Promote `hlc` from per-`Change` to per-`ChangeSet`.
- Consequence: a "transaction" is now a meaningful unit that the apply procedure can be atomic about.

### 2. All-or-Nothing Apply Through SQL

Today, the store adapter (`quereus-sync/src/sync/store-adapter.ts`) writes column changes directly to the KV store, bypassing the SQL execution layer. Constraints don't fire.

Extension: route remote applies through SQL inside a single store transaction.

- Per-column CHECK and NOT NULL constraints fire and can reject a change-set as a whole.
- A failed constraint check causes the whole change-set to be rejected at the receiver (which then either compensates or escalates per the authority layer).
- Uses `MultiStoreWriteBatch` for cross-table atomicity.

This is a precondition for the authority layer's "re-validate against local state" step.

### 3. Causal Delivery

Today, Sync orders by HLC but does not strictly enforce causal predecessors. Extension: each `ChangeSet` carries a `predecessors: HLC[]` field. A receiver defers applying T₂ until all of T₂'s predecessors have arrived locally.

This guarantees that re-validation runs against the same causal universe the originator saw, which is what makes the `causalContext` field meaningful for the should-have-known determination.

## Schema Discipline: I-Confluent by Default

The fundamental theorem (Bailis et al., "Coordination Avoidance in Database Systems") states that an invariant can be maintained without coordination if and only if it is **I-confluent** — i.e., mergeable states preserving the invariant. UNIQUE, multi-row CHECK, and most FK invariants are not I-confluent in the general case.

Cadre control schema design therefore commits to expressing operations in I-confluent form wherever possible:

| Naive form | I-confluent form |
|---|---|
| `Member.id` user-chosen, `UNIQUE` | `Member.id = hash(publicKey)` — uniqueness by construction |
| "Only one admin" (`SoleAdmin` row) | Threshold of M-of-N signers count as admin authority — grow-only set |
| `Role.member_id REFERENCES Member.id` (snapshot FK) | Tombstone-aware FK: reference valid if member ever existed and tombstone HLC ≥ role HLC |
| Global quota counter | Escrow-style bounded counter: each replica holds a share, rebalanced lazily |
| `Permission.granted_at < Permission.revoked_at` (multi-column CHECK) | Two separate facts (`Granted`, `Revoked`) with HLCs; live state = `Granted ∧ ¬Revoked` |

When an operation cannot be expressed I-confluently (rare, but real for some irreversible transfers), the schema author explicitly opts that operation out of asynchronous mode. Those changes go through the **synchronous Right-is-Right path** (existing Optimystic semantics) and require quorum at commit time. The mode is a per-operation declaration, not a global setting.

## Anatomy of a Cadre Control Change

Putting it all together, a change in this regime has the following shape on the wire:

```typescript
interface CadreControlChange {
  // From Quereus Sync (transaction-grouped extension)
  hlc: HLC;                          // Single HLC for the whole transaction
  predecessors: HLC[];               // Causal predecessors
  transactionId: string;
  changes: Change[];                 // Grouped, atomic

  // Authority layer additions
  signature: Signature;              // Originator's signature
  signerKey: PublicKey;              // For verification
  causalContext: HLC[];              // What originator had observed at commit
  validationMode: 'async' | 'sync';  // Per-operation mode declaration
  validityClaim: {                   // What invariants the originator asserts hold
    invariants: string[];            // Symbolic names
    evidence?: object;               // Optional evidence for replay
  };
}
```

### Apply Procedure (Receiver)

```
applyCadreControlChange(change):
  1. verifySignature(change)                       // auth gate
  2. checkCausalReadiness(change.predecessors)     // defer if missing
  3. if validationMode == 'sync':
       → defer to synchronous Right-is-Right path
  4. beginStoreTransaction()
  5. for c in change.changes:
       applyViaSQL(c)                              // CHECK / NOT NULL fire here
  6. evaluateInvariants(change.validityClaim.invariants)
  7. if any violation:
       rollback
       classify: concurrent-invalid | should-have-known
       emit compensation
       if should-have-known: raiseAsyncDispute(change)
     else:
       commit
       emit remote events
```

Steps 1, 2, 3, 6, 7 are new relative to today's Sync apply path. Step 5 replaces the direct-KV-patch with a SQL-routed apply (see `quereus-sync/src/sync/store-adapter.ts:270-329` for the current direct-KV implementation).

## What This Does Not Solve

- **Truly non-I-confluent operations** still need synchronous quorum. The design does not eliminate that need; it scopes it to the rare cases that genuinely require it.
- **Byzantine cadre membership.** A cadre member who lies about their `causalContext` can avoid should-have-known classification. The signed-history and reputation mechanisms make repeated dishonesty expensive, but the model assumes the cadre is *mostly* honest. (The cadre is a party's own nodes plus their formation partners — this is a much weaker assumption than for an open network.)
- **Pathological concurrency.** Many simultaneous concurrent changes can produce a cascade of compensations. In practice cadre control writes are rare; if pressure exists in a specific subdomain it is a signal to either (a) introduce I-confluent schema for that subdomain or (b) opt that subdomain into `sync` mode.

## Implementation Sequence (when this lands)

Approximate order of work, each step independently useful:

1. **Quereus Sync: transaction-grouped HLC.** Promote `hlc` from per-`Change` to per-`ChangeSet`. No behavioral change in default Sync mode; enables (2).
2. **Quereus Sync: SQL-routed apply.** New `mode: 'sql' | 'kv'` on the store adapter. Per-column constraints start firing on remote applies.
3. **Quereus Sync: causal delivery.** `predecessors: HLC[]` on `ChangeSet`; receiver deferral.
4. **Cadre control schema audit.** Convert non-I-confluent invariants to I-confluent form (or explicit `sync` mode flag).
5. **Authority layer wrapper.** Wrap Sync's apply with the cadre-specific re-validation, compensation, and async-dispute hooks.
6. **Optimystic: async dispute path.** Extension of existing Right-is-Right dispute machinery to support "did the originator have causal access" claims as the disputed proposition, with the change already committed at the originator. Most of the existing escalation / dissent-coordinator / reputation code carries over.

## References

- [Optimystic: Right-is-Right](../../optimystic/docs/right-is-right.md) — synchronous validity dispute and escalation
- [Quereus: Sync](../../quereus/docs/sync.md) — CRDT replication module
- Bailis, Fekete, Franklin, Ghodsi, Hellerstein, Stoica — *Coordination Avoidance in Database Systems* (VLDB 2015) — I-confluence theorem
- Terry et al. — *Bayou: Managing Update Conflicts in a Weakly Connected Replicated Storage System* (SOSP 1995) — tentative/committed states, dependency checks, merge procedures
