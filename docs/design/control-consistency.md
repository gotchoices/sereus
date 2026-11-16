# Cadre Control Consistency Model

Design, not built. Nothing here is implemented.

A control write commits only when a super-majority of the party's connected machines approves it, so a machine that is slow or silent delays or fails changes the owner is entitled to make. This design lets a node commit a locally valid control change at once and replicate it afterwards, and corrects a change that later proves inconsistent with a new, compensating change. It would move the control database from Optimystic's cluster replication to Quereus Sync, and keep cluster consensus only for operations declared synchronous. The shipped behaviour it would replace is in [Control database replication](../cadre/control-replication.md) and [Deadlines and the link budget](../network/deadlines.md).

## Motivation

Optimystic replicates the control database to every machine of the party, and a control write commits when 0.75 of the block's cluster approves it ([Replication cluster size](../cadre/control-replication.md#replication-cluster-size)). Two pressures follow that the shipped system does not reconcile:

1. **A party's machines are often slow or unreachable.** Phones are suspended, laptops sleep, and many nodes are reached through relays. Every connected machine is in every control cluster, so in a three-machine party one connected but silent machine fails a control write, and a slow one delays each write. The shipped mitigations are a bounded retry ([Control-write retry](../cadre/control-replication.md#control-write-retry)) and deadlines sized to the link ([Deadlines over Optimystic's reads and commits](../network/deadlines.md#deadlines-over-optimystics-reads-and-commits)).
2. **Some changes carry constraints.** Machine membership, owner keys, formation invitations and revocations have integrity rules that all of the party's machines should respect. They are not arbitrary writes.

Two existing systems each meet one of these:

- **Optimystic** meets the second by deciding validity at commit time. A transaction commits when a super-majority of the cluster approves it. Its dispute design, Right-is-Right ([`docs/right-is-right.md`](https://github.com/gotchoices/Optimystic/blob/main/docs/right-is-right.md)), holds a transaction whose validity a cluster member rejects until a wider set of nodes rules on it. The dispute protocol is off by default (`disputeEnabled`).
- **Quereus Sync** ([`docs/sync.md`](https://github.com/gotchoices/quereus/blob/main/docs/sync.md)) meets the first with offline-first replication that merges column values by last-writer-wins. It applies a remote change without re-running SQL constraints.

The control network needs both properties. A node holding a change that satisfies integrity locally should be able to commit and proceed. A node holding new information that invalidates an accepted change should be able to reconcile without breaking convergence.

## Two Layers

The design separates two concerns:

| Layer | Concern | Mechanism |
|-------|---------|-----------|
| **Authority** | The quorum needed to commit a change | [Asynchronous Right-is-Right](#authority-model-asynchronous-right-is-right) |
| **Replication** | Carrying committed changes between the party's nodes | [Quereus Sync with transactional extensions](#replication-layer-sync-with-transactional-extensions) |

They meet in one place. When a sync apply finds that an arriving change is inconsistent with state the receiver holds, the receiver calls the authority layer, which compensates and may open a dispute.

## Authority Model: Asynchronous Right-is-Right

### Default Mode

Under this design the control network runs in asynchronous validation mode by default:

1. The originating node validates the change against its own integrity rules: signatures verify, single-row checks pass, and the row has the schema's shape.
2. If the change is locally valid, it commits at the originator at once. No quorum is required.
3. The replication layer carries the change to the party's other nodes later.
4. Each receiving node validates the change again against its own state.
5. If that validation passes, the receiver records the change as committed.
6. If it fails, the receiver emits a [compensating change](#convergence-primitive-compensation-not-rollback) and may raise an [asynchronous dispute](#asynchronous-dispute) against the originator.

A change is therefore locally committed when it is authored, tentatively replicated while it is in transit, and globally committed once it has reached every live node of the party without compensation. There is no synchronous quorum decision.

### Validity Has a Causal Context

In synchronous Right-is-Right, a peer that rejects validity is saying the change is wrong. In the asynchronous model the meaning is weaker:

- The originator's endorsement means "valid given the state I had observed at HLC H", where HLC is the hybrid logical clock that orders changes across replicas.
- A receiver that rejects at a later HLC, with more information, is not asserting that the originator was malicious or faulty. It is noting that the wider state invalidates the change.
- Each change would carry a `causalContext` field: the set of HLCs (or transaction ids) the originator had observed when it committed. The field lets the receiver tell a concurrent conflict, which is nobody's fault, from a violation the originator should have known about.

### Outcomes of Re-Validation

When a node validates an incoming change against its current local state, the outcome is one of three:

| Outcome | Meaning | Response |
|---------|---------|----------|
| **Pass** | The change is consistent with local state. | Apply it and mark it committed. |
| **Concurrent-invalid** | Two locally valid changes conflict because neither author had seen the other's. | Emit compensation. No penalty. |
| **Should-have-known invalid** | The originator's `causalContext` included the information that should have rejected the change. | Emit compensation and raise an asynchronous dispute. The originator takes a reputation penalty. |

Distinguishing the last two outcomes is the only use of `causalContext`. Normal operation does not consult it.

### Asynchronous Dispute

When a receiver detects the should-have-known case, the Right-is-Right escalation applies with one change to what is disputed:

- A dissent coordinator is chosen deterministically from the nodes that have observed the offending change.
- The dispute escalates by enlisting more of the party's nodes.
- The disputed claim is "did the originator have causal access to the rejecting information?" That question is deterministic and asked after the fact, so every node that validates the same causal evidence reaches the same answer.
- Resolution applies reputation penalties and, for a repeat offender, ejection from the control network.

A dispute never blocks later transactions. It runs beside normal traffic.

## Convergence Primitive: Compensation, Not Rollback

A change that has propagated cannot be un-accepted, because other nodes may have derived state from it, signed artifacts over it or made later changes that depend on it. The convergence primitive is therefore **compensation**: a receiver that finds an invariant violated issues a new change, signed by itself, with a higher HLC, that restores the invariant. For example:

- **Two nodes concurrently grant the same exclusive role to different holders.** The compensating change revokes the assignment with the lower HLC.
- **One node admits a machine while another removes it.** The compensating change records the machine as removed, whichever change arrived first.
- **Two nodes insert the same identity.** The compensating change keeps the identity with the lower HLC and marks the other as a duplicate of it.

Three properties follow:

- **The original change stays in history.** It remains auditable and traceable to the signature that authored it.
- **Live state shows the compensated form.**
- **A compensation propagates like any other change.** Replicas converge on the change followed by its compensation, with the same end state whatever the arrival order.

Financial systems use the same pattern: a bad transaction is not reversed in place but corrected by a later, traceable adjustment. Optimystic's reversal of a transaction proven invalid takes the same form, an appended invalidation entry that never rewrites the log.

## Replication Layer: Sync with Transactional Extensions

The replication layer would be Quereus Sync (`packages/quereus-sync` in the Quereus repository), which Sereus does not depend on. The authority layer needs three properties from it: a transaction is one unit, a receiver can validate what it applies, and a change is applied only after the changes it depended on. Sync provides the first, part of the second and none of the third.

### What Quereus Sync Provides

**A transaction is a unit.** Sync takes one HLC tick per committed transaction. Every fact of the transaction shares that base clock value and differs only in a sequence number within the transaction. A `ChangeSet` (`src/sync/protocol.ts`) carries one transaction's changes, a `transactionId` derived from the base clock value, and an `hlc` that is the transaction's commit boundary. No extension is needed here.

**Apply is atomic.** A receiver admits a batch of change sets as one unit: table data first, replication metadata second. If any change fails to land, the receiver commits no metadata and applies the whole batch again on the next sync.

**The authority layer must identify a transaction by `transactionId`.** One reply can split a transaction into two change sets with the same id, when the serving replica recorded part of it at a later clock value. The unit of atomic apply is also the batch, which is coarser than one transaction.

### Receiver-Side Validation

Sync applies remote changes on the stated assumption that the origin enforced every declared constraint. Its store adapter writes incoming rows directly to table storage inside one engine call (`Database.ingestExternalRowWrite`) and does not run the statement executor. No row-level `check`, `not null`, `unique` or child-side foreign-key constraint is evaluated on apply.

One class of rule is evaluated: global assertions, at commit, in report mode. A violated assertion is collected, the batch still commits, and the host is told through an `onAssertionViolation` event. Sync lets the data land because a receiver that refuses merged data diverges from the state the other replicas converge on. That is the same reasoning as [compensation](#convergence-primitive-compensation-not-rollback), and the event is where a compensating change would be emitted for an invariant written as a global assertion.

The extension this design needs is validation of the rules that are not global assertions: the row-level checks of an incoming transaction, evaluated against the receiver's state, with a verdict for each transaction. The control schema's authorization rules are row-level checks, so this covers the rules that matter most.

Whether a failing transaction is refused or applied and then compensated is an [open question](#open-questions). Sync constrains the answer: a batch that fails every time it is applied blocks replication from that peer until the host intervenes.

### Causal Delivery

Sync orders changes by HLC and does not track causal predecessors. It can hold a change it cannot apply yet, but only for a table the receiver does not have.

The extension is a `predecessors: HLC[]` field on each change set. A receiver defers applying a transaction until all of its predecessors have arrived locally. Validation then runs against the same causal history the originator saw, which is what gives `causalContext` its meaning in the should-have-known decision.

## Schema Discipline: I-Confluent by Default

An invariant can be maintained without coordination if and only if it is **I-confluent**: merging two states that each satisfy the invariant gives a state that satisfies it (Bailis et al., "Coordination Avoidance in Database Systems"). `unique` constraints, checks that span rows, and most foreign-key invariants are not I-confluent in general.

The control schema would therefore express operations in I-confluent form wherever possible. The table gives generic examples, not control tables:

| Naive form | I-confluent form |
|---|---|
| `Member.id` chosen by the user, `unique` | `Member.id = hash(publicKey)`: unique by construction |
| "Only one admin" (a `SoleAdmin` row) | M-of-N signers hold admin authority: a set that only grows |
| `Role.member_id references Member.id`, checked against a snapshot | A reference is valid if the member ever existed and its tombstone HLC is not below the role's HLC |
| A global quota counter | An escrow counter: each replica holds a share of the quota, rebalanced later |
| `Permission.granted_at < Permission.revoked_at`, a check over two columns | Two facts, `Granted` and `Revoked`, each with an HLC; the permission is live when granted and not revoked |

The shipped control schema has some of this form. A removal is a separate `Revocation` row that retires a stamp, and several tables are insert-only ([Stamps and tombstones](../cadre/control-schema.md#stamps-and-tombstones)). It also has invariants that are not I-confluent, such as an invitation's use cap, which counts rows.

Some operations cannot be expressed in I-confluent form, such as certain irreversible transfers. The schema author opts such an operation out of asynchronous mode explicitly. It then takes the synchronous path, Optimystic's cluster consensus, and requires a quorum at commit time. The mode is declared per operation and is not a global setting.

## Anatomy of a Cadre Control Change

A change under this design has the following shape on the wire:

```typescript
interface CadreControlChange {
	// From Quereus Sync's ChangeSet
	hlc: HLC;                          // The transaction's commit boundary
	transactionId: string;
	changes: Change[];                 // One transaction, applied atomically

	// Causal-delivery extension
	predecessors: HLC[];               // Causal predecessors

	// Authority layer additions
	signature: Signature;              // Originator's signature
	signerKey: PublicKey;              // For verification
	causalContext: HLC[];              // What the originator had observed at commit
	validationMode: 'async' | 'sync';  // Declared per operation
	validityClaim: {                   // The invariants the originator asserts hold
		invariants: string[];            // Symbolic names
		evidence?: object;               // Optional evidence for replay
	};
}
```

### Apply Procedure (Receiver)

```
applyCadreControlChange(change):
  1. verifySignature(change)                       // authorization
  2. checkCausalReadiness(change.predecessors)     // defer if any is missing
  3. if validationMode == 'sync':
       → hand over to the synchronous path
  4. begin the apply batch
  5. for c in change.changes:
       apply c and evaluate its row-level checks
  6. evaluateInvariants(change.validityClaim.invariants)
  7. if any violation:
       classify: concurrent-invalid | should-have-known
       emit compensation
       if should-have-known: raiseAsyncDispute(change)
     else:
       commit
       emit remote events
```

Signature verification, the causal-readiness check, the hand-over to the synchronous path and the handling of a violation are additions to Sync's apply path. Evaluating row-level checks adds to the direct row write in Sync's store adapter (`src/sync/store-adapter.ts`), and `evaluateInvariants` extends its report-mode evaluation of global assertions to the invariants the change names.

## What This Does Not Solve

- **Operations that are not I-confluent still need a synchronous quorum.** The design does not remove that need. It confines it to the operations that require it.
- **A dishonest node in the control network.** A node that lies about its `causalContext` avoids the should-have-known classification. Signed history and reputation make repeated dishonesty expensive, but the model assumes that most nodes are honest. That assumption asks much less of a control network than of an open one, because its nodes are one party's own machines.
- **Heavy concurrency.** Many simultaneous conflicting changes can produce a cascade of compensations. Control writes are rare. If one part of the schema does see such pressure, that part should be given an I-confluent form or declared `sync`.

## Open Questions

- **Refuse, or apply and compensate.** [Compensation](#convergence-primitive-compensation-not-rollback) keeps the original change in history, which implies applying it. Refusing an invalid transaction instead would conflict with Sync, where a batch that always fails blocks its peer. If the transaction is applied, readers see the invalid state until the compensation commits.
- **Authorization evidence.** A control table authorizes a write with a check over values supplied with the statement (`context.Signature`, `context.OwnerKey`). A Sync change carries cell values only, so a receiver cannot run that check again. The approval must be stored in the row or carried in `validityClaim.evidence`.
- **One database, two paths.** Control tables are Optimystic collections ([Control tables are network-backed](../cadre/control-replication.md#control-tables-are-network-backed)). How operations declared `sync` keep cluster consensus while the same tables are replicated by Sync is unspecified.
- **Who arbitrates.** Right-is-Right resolves a split by enlisting nodes outside the disputing cluster. A control network admits only one party's machines, often two or three, so there may be nobody further to enlist.

## Implementation Sequence

An approximate order of work. Each step is useful on its own.

1. **Quereus Sync: receiver-side validation.** An apply mode in which the store adapter evaluates the row-level checks of incoming rows and reports a verdict for each transaction.
2. **Quereus Sync: causal delivery.** `predecessors: HLC[]` on `ChangeSet`, and deferral at the receiver.
3. **Control schema audit.** Convert invariants that are not I-confluent to I-confluent form, or declare their operations `sync`.
4. **Authority layer.** Wrap Sync's apply with the control network's validation, compensation and dispute calls.
5. **Optimystic: asynchronous dispute.** Optimystic's dispute design includes a challenge to a transaction that has committed, and a durable reversal. The extension is a new disputed proposition, "did the originator have causal access", for a change that committed at its originator without a cluster vote.

## References

- [Optimystic: Right-is-Right](https://github.com/gotchoices/Optimystic/blob/main/docs/right-is-right.md): validity disputes and escalation.
- [Quereus: Sync](https://github.com/gotchoices/quereus/blob/main/docs/sync.md) and [Sync: Transactions](https://github.com/gotchoices/quereus/blob/main/docs/sync-transactions.md): the replication module, its transaction grouping and its apply rules.
- Bailis, Fekete, Franklin, Ghodsi, Hellerstein, Stoica, *Coordination Avoidance in Database Systems* (VLDB 2015): the I-confluence theorem.
- Terry et al., *Bayou: Managing Update Conflicts in a Weakly Connected Replicated Storage System* (SOSP 1995): tentative and committed states, dependency checks, merge procedures.
