description: The network that carries a group's membership list needs to know how many machines are enrolled before it starts, but that number is stored in a database that only exists once it has started; break the deadlock by remembering the number on disk between runs.
prereq: feat-repair-yardstick-strand-nodes
files: packages/cadre-core/src/enrolled-machine-store.ts (new), packages/cadre-core/src/enrolled-machine-store-file.ts (new), packages/cadre-core/src/node-local-snapshot.ts, packages/cadre-core/src/bootstrap-peer-store.ts, packages/cadre-core/src/types.ts (CadreNodeConfig), packages/cadre-core/src/cadre-node.ts (start, buildControlNodeOptions, refreshAuthorizedControlPeers), packages/cadre-core/src/index.ts, packages/cadre-core/package.json (exports), packages/cadre-cli/src/commands/start.ts, packages/reference-app-rn/src/cadre-phone.ts, packages/reference-app-rn/src/node-local-slots.ts, docs/architecture.md
difficulty: medium
----

# Declare the repair yardstick on the control node, across a restart

`feat-repair-yardstick-strand-nodes` lands `controlClusterPolicy(enrolledMachines)` and the rule
`max(MIN_CLUSTER_SIZE, min(enrolledMachines, replicationBreadth))`. Read that ticket's arithmetic
section before starting; it is not repeated here. This ticket makes the **control** node use it.

## The problem this ticket exists for

`CadreNode.buildControlNodeOptions` runs inside `start()`, before `createControlNode()`, which is
before the `ControlDatabase` holding the `CadrePeer` rows exists. The number is therefore not
readable at the moment it is needed. That chicken-and-egg is the reason the pin at 2 was correct when
it was written, and it is the whole of this ticket.

The pattern for "a small authenticated fact that must outlive the process and be readable before the
node is up" already exists twice in this package: the trusted-owner anchor (`trusted-owner-store.ts`)
and the cold-start bootstrap-peer store (`bootstrap-peer-store.ts`), each a `{ version, partyId, … }`
envelope over a `DurableSlot` the embedding app supplies (`node-local-snapshot.ts`). This is the
third such record, and the simplest: a single integer.

## Shape

A new module `packages/cadre-core/src/enrolled-machine-store.ts`, deliberately symmetrical with the
other two:

```ts
export interface EnrolledMachineStore {
  readonly partyId: string;
  /** Machines last recorded for this party, or undefined when nothing was ever recorded. */
  count(): number | undefined;
  /** Record the current count. Reflected by `count()` synchronously; the promise tracks durability. */
  record(count: number): Promise<void>;
}

export class MemoryEnrolledMachineStore implements EnrolledMachineStore { /* default when none injected */ }
export class PersistentEnrolledMachineStore implements EnrolledMachineStore {
  static open(slot: DurableSlot, partyId: string): Promise<PersistentEnrolledMachineStore>;
}
```

plus `enrolled-machine-store-file.ts` exporting `FileEnrolledMachineStore.open(dir, partyId)` behind
the `@serfab/cadre-core/enrolled-machine-store-file` subpath, exactly as the other two do, so
`node:fs` stays out of the React Native and browser entry graphs.

Persisted envelope, matching the existing shape but scalar rather than a map:

```json
{ "version": 1, "partyId": "<party>", "enrolledMachines": 3 }
```

**Why not `NodeLocalSnapshot`.** That class is a `key -> entry` map with no delete, so a count that
must go *down* after a removal does not fit it, and its load policy **throws** when the slot is
present but unreadable. Throwing is right for the anchor (a record that cannot be read in full is not
an anchor) and for the peer store (a failed read reported as absent would let the next snapshot-write
destroy a stranded node's only way home). It is wrong here: this record is not trust-bearing, holds
nothing that cannot be recomputed the moment the database is up, and refusing to start a node over an
unreadable *repair hint* is strictly worse than declaring today's 2. So this module snapshot-writes
the scalar over `DurableSlot` directly and, on any unreadable or unparsable slot, **logs and
cold-starts** — which yields `undefined`, which declares nothing, which is today's behaviour. Say all
of that in the module comment, including the deliberate divergence from its two siblings, so the
next reader does not "unify" the three and quietly import the throw.

## Wiring

- **`CadreNodeConfig`** gains `enrolledMachines?: { store?: EnrolledMachineStore }`, documented like
  the neighbouring `bootstrapPeers` block. Omitted means a `MemoryEnrolledMachineStore` — ephemeral,
  cold start on every launch, today's behaviour. No embedder is *forced* to change.
- **`CadreNode.start()`** reads `store.count()` into a field before `createControlNode()`;
  `buildControlNodeOptions` stays synchronous (its spec calls it directly) and reads that field,
  passing `controlClusterPolicy(count)` where it passes `CONTROL_CLUSTER_POLICY` today
  (`cadre-node.ts:1311`).
- **`CadreNode.refreshAuthorizedControlPeers`** already recomputes `authorizedControlPeers` after
  every committed membership write, every reconcile, and at start. Record `size + 1` there, with
  `void` on the un-awaited promise; the store logs its own persist failures. Do not add a second
  membership query.
- **Embedders**: `packages/cadre-cli/src/commands/start.ts` (alongside `FileBootstrapPeerStore.open`
  at line 142) and `packages/reference-app-rn/src/cadre-phone.ts` (alongside
  `PersistentBootstrapPeerStore.open` at line 173, with a new key helper in `node-local-slots.ts`
  beside `bootstrapPeersKvKey`). `cadre-host` opens neither of the existing stores and needs nothing.

## Deliberately not done

- **No forced restart on "add a backup".** Raising is the safe direction and a node still holding the
  old value is running at today's value, so the next natural rebuild is soon enough: the control node
  picks the count up on the next app launch. A quiesce/resume sweep to apply it sooner is an
  optimization to measure, not a requirement.
- **No runtime mutation of a live node.** Optimystic captures the number at construction and
  deliberately offers no setter; the accepted-tradeoff `NOTE:` recording that decision lives at its
  `resolveClusterPolicy`.
- **No first-launch rebuild.** A brand-new node's first run declares nothing and gets today's
  behaviour. Rebuilding the control node mid-`start()` once membership is readable would be
  disruptive for one launch's worth of benefit.

## Edge cases & interactions

- **Cold start, brand-new node**: no slot, no rows, `count()` is `undefined` -> base policy by
  identity -> today's behaviour, byte for byte. Assert the identity.
- **Slot present but unreadable** (`DurableSlot.load` throws): log and cold-start; never treat as
  "zero machines" and never throw out of `open`. This is the one place this record's policy diverges
  from its two siblings — cover it with a spec that asserts `open` resolves and `count()` is
  `undefined`, and one that asserts the failure was logged rather than swallowed silently.
- **Foreign `partyId` in the slot** (a slot reused across parties): cold-start, same as the siblings.
- **Junk payload** — `"3"`, `0`, `-1`, `2.5`, `null`, a missing key: each cold-starts rather than
  being coerced. One spec per shape; coercing `"3"` here would be the start of a parser.
- **A removed peer** leaves the count at *revocation*, not at reap: `queryCadrePeers` already drops
  rows whose `StampId` is retired, and `listAuthorizedMembers` reads through it. State this in the
  record site's comment — it is the reason there is no reap hook to write.
- **Two processes sharing one slot for one party** would each snapshot-write their own view, the same
  caveat `NodeLocalSnapshot` already carries. Repeat the `NOTE:`; every backend today gives each node
  its own directory or origin database.
- **Persist failure** leaves the in-memory count correct for this session and re-lands on the next
  refresh. Never let it reject out of `refreshAuthorizedControlPeers`, whose contract is never-rejects.
- **Party that shrinks below the slot's value**: the next refresh writes the smaller number; the node
  runs at the larger one until its next launch, which over-declares only the freshness-window
  denominator. Harmless and self-clearing.
- **The count exceeding `CONTROL_REPLICATION_BREADTH` (16)**: a party of more than 16 machines caps at
  16, which is also where its control cohort caps. Assert it.
- **Existing spec** `packages/cadre-core/test/cadre-node-control-node-options.spec.ts:140` asserts
  `options.clusterPolicy` *is* `CONTROL_CLUSTER_POLICY`. It must keep asserting identity for the
  unknown-count case and gain a structural arm for a known count.

## The one integration assertion

Two members of a three-node party that disagree about the count must still commit and still repair —
the yardstick is per-node and no node refuses another anything over it, but that is a claim worth
proving once rather than only reasoning about. Add it to the existing real-network harness
(`packages/integration-tests/src/harness/test-party.ts` builds control nodes with
`CONTROL_CLUSTER_POLICY` at line 63): one node declaring 2 while the other two declare 3, asserting a
control write commits and a lagging node converges. If wiring a per-node policy through that harness
turns out to be a larger change than the rest of this ticket put together, stop, land everything
else, and say so explicitly in the review handoff rather than shipping a weakened version of it.

## Human action, not code

GitHub issue `gotchoices/sereus#2` is stale — it claims `CadreNode` hardcodes `clusterSize: 3` and
declares no `assumedClusterSize`; neither has been true for some time. Someone should update or close
it and point it at this work. Not an implementation task; mention it in the review handoff so it
reaches a human.

## TODO

- Write `enrolled-machine-store.ts` (`EnrolledMachineStore`, `MemoryEnrolledMachineStore`,
  `PersistentEnrolledMachineStore`) with the module comment explaining the divergence from
  `NodeLocalSnapshot`'s throw-on-unreadable policy.
- Write `enrolled-machine-store-file.ts`; add the `./enrolled-machine-store-file` subpath to
  `packages/cadre-core/package.json` exports; export the cross-platform names from `src/index.ts`.
- Add `CadreNodeConfig.enrolledMachines` to `packages/cadre-core/src/types.ts`, defaulting to the
  memory store.
- Read the count in `CadreNode.start()` before `createControlNode()`; consume it in
  `buildControlNodeOptions` via `controlClusterPolicy`.
- Record `authorizedControlPeers.size + 1` from `refreshAuthorizedControlPeers`.
- Wire `FileEnrolledMachineStore` in `cadre-cli`'s `start.ts`; wire the persistent store and a new
  key helper in `reference-app-rn` (`cadre-phone.ts`, `node-local-slots.ts`, and the key-shape
  assertions in `test/node-local-slots.spec.ts`).
- Store specs modelled on `packages/cadre-core/test/bootstrap-peer-store.spec.ts`: round-trip across
  a reopen, party isolation in one directory, every junk-payload shape above, and the
  unreadable-slot case that must NOT throw.
- Control-node-options specs: unknown count passes the base policy by identity; a count of 5 declares
  5; a count of 1 declares 2; a count of 20 declares 16.
- The three-node divergent-yardstick integration scenario above.
- Update `docs/architecture.md` -> "Replication cluster size" with the control node's cold-start
  behaviour and the "applies on the next launch" contract; the strand half is already covered by the
  prerequisite ticket.
- Validate: `yarn workspace @serfab/cadre-core test`, `yarn workspace @serfab/cadre-cli test`,
  `yarn workspace @serfab/reference-app-rn test`, then `yarn lint` and `yarn typecheck` from the
  root. Run the integration scenario in the foreground with no redirection; if it exceeds roughly ten
  minutes of wall-clock it is not agent-runnable — document the deferral rather than truncating it.
