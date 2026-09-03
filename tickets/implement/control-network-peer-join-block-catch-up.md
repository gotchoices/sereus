description: When a second machine joins a party, it can read the shared membership database over the network but never receives its own copy of some of the underlying storage. If that machine is later restarted while offline, the whole membership table reads as empty — silently, with no error — so it forgets who its own party is.
files: packages/cadre-core/src/strand-backfill.ts, packages/cadre-core/src/cadre-node.ts (buildControlNodeOptions ~line 1179-1210, startControlNode ~line 1098, handleControlConnectionChange), packages/cadre-core/src/strand-instance-manager.ts (lines 326-445 — the existing wiring to copy), packages/cadre-core/src/index.ts (line 115 export block), packages/integration-tests/src/scenarios/control-delete-while-alone-convergence.integration.ts, packages/quereus-plugin-sereus/src/cluster-size.ts (CONTROL_REPLICATION_BREADTH — the intent this ticket makes true), docs/architecture.md
difficulty: hard
repro: verified
----

# The control network needs the peer-join block catch-up that strands already have

## What is broken

A cadre member that has fully converged the party's control database over the network can
still be missing the *storage blocks* that database is made of. While it is connected that is
invisible — it reads those blocks from the sibling that holds them. The moment it restarts
with no connections, every table whose blocks it never received reads as **empty**, with no
error and no retry. `isMember()` answers false for peers it demonstrably knew about seconds
earlier.

This was found as the failure of
`control-delete-while-alone-convergence.integration.ts:154`, but the assertion there is only a
precondition. The defect is general: **any** cadre node that restarts offline can read its own
control database as empty.

## Measured evidence

Isolated runs of `control-delete-while-alone-convergence` at `@optimystic/db-p2p` 0.27.0,
sereus `df422d5`, `../optimystic` `67fc6b64`: **8 of 11 file runs red, 10 of 22 test cases red**,
all at line 154 (`expect(await B.isMember(ctx.xPeerId)).toBe(true)`, the first line of
`expectRemovalConverges`, before any reconnect).

A throwaway probe reproduced the same shape in four rounds without any of the delete
choreography — bring A and B up, converge a peer row onto B, stop both, restart B alone, read —
and dumped B's `MemoryRawStorage` block ids at each step. The correlation is exact:

| round | `default/CadrePeer` in B's store | `B.isMember(X)` after restart |
| --- | --- | --- |
| 1 | absent | **false** |
| 2 | absent | **false** |
| 3 | present | true |
| 4 | absent | **false** |

B's store does not change across the stop/restart (7 blocks before, 7 after) — nothing is lost
at shutdown. The block was never delivered in the first place. A's store held 15 blocks in every
round, including `default/CadrePeer` and `default/OwnerKey`; B held 7 or 11.

The same correlation holds in five `DEBUG` runs of the real scenario, counted by
`replica:save blockId=default/CadrePeer`: 0 saves → both tests red; 1 save → the first test green
and the second red; 2 saves → both green. Ten test cases, ten agreements.

## Root cause

Two facts combine.

**1. A block committed while its writer is alone has exactly one holder, forever.** A party's
first node genesises its control database by itself. Every commit in that window logs
`commit:solo-cohort { cohortSize: 1, soleIsSelf: true }` — the cohort is one node, so one node
gets the bytes. The named collection-header blocks (`default/CadrePeer`, `default/OwnerKey`, and
each `default/<table>/index/...`) are written **once**, at collection creation, and their
revision never moves again — so no later commit ever carries them to anyone. Nothing back-fills
them when the party grows.

**2. Nothing in the control network copies a peer's existing blocks to a peer that joins later.**
A joining node acquires such a block only by accident: optimystic's read-repair persists a block
when *this* node is the coordinator for it, and the coordinator is chosen by hash proximity
between the block id and the peers' ephemeral libp2p ids. `default/CadrePeer` is a fixed string
and the peer ids are random per process, so whether the joiner ends up holding it is a coin
flip — which is the whole of the observed intermittency.

Then, when that node restarts alone,
`../optimystic/packages/db-p2p/src/repo/coordinator-repo.ts:797-807` short-circuits:
`findCluster` returns only itself, so `fetchBlockFromCluster` logs `cluster-fetch:solo-self-skip`
and returns `absence: 'confirmed'` — an **authoritative** absent. The missing header is reported
as "this collection is empty", the SQL scan yields no rows, and no error is raised anywhere. That
short-circuit is correct in itself (there is genuinely nobody to ask); the defect is that the
node should have had the block.

**Sereus already solved exactly this for strands and never wired it for the control network.**
`packages/cadre-core/src/strand-backfill.ts` is a peer-join whole-store catch-up: on
`connection:open` it pushes every committed, materialized block in the local raw store to the new
peer, in chunks, with commit proofs. Its own header says it exists *because* Optimystic has no
cohort-join catch-up of its own. It is instantiated only in `strand-instance-manager.ts`
(lines ~420-445), per strand. The control network has no equivalent, which is why
`CONTROL_REPLICATION_BREADTH = 16` — documented as "in practice every control block lands on
every member of the party" — is not true for blocks written before the party grew.

## What to build

A control-network peer-join block catch-up, sharing one implementation with the strand one.

**Generalize the module, do not fork it.** `StrandBackfill` is already network-agnostic in
substance — its deps are a libp2p node, an `IPeerNetwork`, an `IRawStorage` and a protocol
prefix; only the names and the `strandId` log tag are strand-specific. Rename to something like
`PeerJoinBackfill` with a neutral label field, keep the strand call site behaviourally identical,
and add the control call site. Two copies of this logic is the outcome to avoid.

**Wire it on the control node.** The control libp2p node is built in
`CadreNode.buildControlNodeOptions` (`cadre-node.ts:1179`) with a `networkName` of
`control-` plus the party id, so the block-transfer protocol prefix is
`/optimystic/control-<partyId>`. Derive it from the same `networkName` expression rather than
re-spelling it, as `strand-instance-manager.ts:326-330` does. Start it after
`startControlNode()`, stop it in the node's teardown.

**Gate it on membership — this is the one place the control network differs from a strand.**
`StrandBackfill`'s header argues explicitly for having no membership gate: everything connected
on a strand's own libp2p network is already a cohort peer receiving replicas. That argument does
**not** hold here. The control network's inbound gate deliberately admits non-members in several
states (an un-enrolled node taking its seed, an open enrollment window, an outstanding
invitation, configured bootstrap/relay peers — see `docs/architecture.md`, the control-network
inbound connection gate). Pushing the whole control store to such a peer would hand a stranger
the party's entire membership, addresses and strand list. Push only to peers
`CadreNode.isAuthorizedMember` accepts, and re-check at push time rather than at schedule time.
Say so in the module comment, next to the strand argument it contradicts.

**Confirm the receiving side exists on the control node.** The push lands via
`BlockTransferClient.pushBlocks` against a handler the receiver registers under the same
protocol prefix. Verify `createLibp2pNode` registers that handler for the control network too
(it does for strands); if it is conditional on something the control node does not set, that is
part of this work.

## Tests

- **The property, not the instance.** A test that stands up two nodes, converges a control row
  onto the second, stops both, restarts the second **alone**, and asserts it still reads the
  row — for `CadrePeer` and for at least one other control table, so it covers the class rather
  than the one collection this was found on. Assert against the raw store as well (the restarted
  node's store must contain `default/CadrePeer`), because reading through its database is exactly
  the thing that can mask the gap.
- `control-delete-while-alone-convergence` must go green **5 runs in a row, isolated**. One green
  run proves nothing here; the pre-fix rate was ~45% of cases.
- Keep the existing strand backfill unit tests passing unchanged through the rename.

## What NOT to do

- **Do not weaken `control-delete-while-alone-convergence:154` into a `waitUntil`,** and do not
  move it after the reconnect. It is the assertion that found this.
- **Do not treat this as the corroboration-floor defect.**
  `blocked/block-held-by-only-one-machine-is-unreadable` was the standing hypothesis and it is
  **refuted** for this failure: across five traced runs there is no `responders: 1, required: 2`
  anywhere, and no `no-quorum` line at all on the failing read. The only `cluster-fetch:no-quorum`
  lines carry `holders: 0, absent: 1, required: 1` for `default/Revocation`, which is a genuinely
  empty table answering correctly. The two tickets do share an *origin* — solo-cohort commits
  producing single-holder blocks — and this work should reduce that ticket's exposure, but it is
  a different site and this ticket does not close it.
- **Do not add a Sereus-side knob to the corroboration floor.** Nothing here needs one.

## Interactions

- `backlog/control-rereplication-broadcast-confirmation` observes the row-level twin of this
  (optimystic only broadcasts when the block's cluster has two or more members) and its
  `prereq: control-write-ensure-replicated` chain is about re-issuing *rows*. Re-issuing a row
  writes tree blocks; it does not rewrite an untouched collection header, so that work does not
  subsume this one. Worth reading before starting.
- `backlog/debt-offline-read-of-post-dial-strand-rows` is the strand-side coverage gap of the
  same question. It is filed as "very likely to pass"; that expectation is reasonable **because**
  strands have the backfill this ticket adds to the control network. No change needed there.
- `blocked/forked-control-collection-sync-livelocks` names this same scenario file as its live
  reproducer. Its fork trigger is a different thing (two divergent histories after an alone
  write); re-measure it once this lands rather than assuming either way.

## TODO

- [ ] Rename/generalize `strand-backfill.ts` to a network-neutral peer-join catch-up; update the
      strand call site and the `index.ts` export block; keep existing unit tests green.
- [ ] Verify the block-transfer receive handler is registered on the control libp2p node.
- [ ] Instantiate the catch-up on the control node, protocol prefix derived from the same
      `networkName` expression `buildControlNodeOptions` uses; start after `startControlNode()`,
      stop in teardown.
- [ ] Gate control-network pushes on `isAuthorizedMember`, checked at push time; document why the
      strand module's no-gate argument does not carry over.
- [ ] Add the offline-read-after-restart property test over at least two control tables, asserting
      raw-store contents as well as query results.
- [ ] Run `control-delete-while-alone-convergence` isolated 5x; all green.
- [ ] Run `control-write-while-alone-convergence` isolated 5x (3/3 green pre-fix — confirm no
      regression).
- [ ] `yarn lint`, `yarn build`, `yarn typecheck`, plus the `cadre-core` unit suite.
- [ ] Update `docs/architecture.md`: the peer-join catch-up now covers the control network, and
      `CONTROL_REPLICATION_BREADTH`'s "every control block lands on every member" claim is made
      true by it rather than by cohort width alone.
- [ ] Update this scenario's entry in `tickets/.pre-existing-known.md` (move to Resolved) once the
      5-run gate is green.
