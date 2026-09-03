description: A second machine joining a party could converge the shared membership database over the network yet never receive some of its underlying storage blocks, so restarting offline made whole tables read as empty; the control network now runs the same peer-join block catch-up the strand networks already had, and the review pass closed a race in the retry that catch-up depends on.
files: packages/cadre-core/src/peer-join-backfill.ts, packages/cadre-core/src/cadre-node.ts (startControlBackfill ~line 1157-1205, start() wiring ~line 852, refreshAuthorizedControlPeers ~line 1650, cleanup ~line 3523), packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/peer-join-backfill.spec.ts, packages/cadre-core/test/cadre-node-control-backfill.spec.ts, packages/cadre-core/test/strand-instance-manager-backfill.spec.ts, packages/integration-tests/src/scenarios/control-offline-read-after-restart.integration.ts, packages/quereus-plugin-sereus/src/cluster-size.ts, docs/architecture.md, docs/cadre-consistency.md
----

# Complete: control-network peer-join block catch-up

## What was wrong

A control block committed while its writer was alone has a cohort of one, forever. The named
collection-header blocks (`default/CadrePeer`, `default/OwnerKey`, each table's index headers)
are written exactly once, at the founder's solo genesis, and their revision never moves again,
so no later commit ever carries them anywhere. The control network had no peer-join block
catch-up (the strand networks did), so whether a joiner physically held a header was decided by
hash proximity between the fixed block id and the run's random peer ids. While connected the gap
was invisible — reads resolve a coordinator that answers from the founder's storage. The moment
that member restarted offline, every table whose header it never received read as **empty**,
silently: `isMember()` answered false for peers it demonstrably knew about before it stopped.
Measured before the fix as 8 of 11 isolated runs of
`control-delete-while-alone-convergence.integration.ts` failing at line 154.

## What shipped (implement pass, commit `50c39aa`)

- **`strand-backfill.ts` → `peer-join-backfill.ts`** — one shared module, no fork. `StrandBackfill`
  → `PeerJoinBackfill` and the matching `*Config/Deps/Result/PushClient` types; the deps field
  `strandId` became the neutral `label`. Copy logic byte-for-byte unchanged, plus an optional
  `authorizePeer` dep judged at PUSH time (fails closed on a throw; a denied run is never
  memoized), a public `scheduleConnectedPeers()`, and `denied` on the result.
- **Control wiring in `cadre-node.ts`** — one `controlNetworkName()` binding shared by the node
  options and the catch-up's `/optimystic/control-<partyId>` protocol prefix;
  `startControlBackfill()` from `start()` once the control DB is up; `authorizePeer` =
  `isAuthorizedMember`; stopped in `cleanup()` before the control DB closes and the node stops.
  The receiving side needed nothing: `createLibp2pNode` registers the block-transfer handler
  unconditionally, and the existing per-stream gate covers inbound pushes.
- **Membership re-arm** — `refreshAuthorizedControlPeers` drives `scheduleConnectedPeers()`,
  because the production join order is connect-then-authorize, so a joiner's first pass is denied
  while its connection stays up.
- **Control debounce default 250 ms** (strand stays 1000 ms), overridable via
  `CadreNodeConfig.controlBackfill`.
- **Docs** — `docs/architecture.md`, `docs/cadre-consistency.md`, and `cluster-size.ts`'s
  `CONTROL_REPLICATION_BREADTH` comment all had claims that the control network deliberately did
  not run the catch-up; those are replaced with the new truth.

## Review findings

Reviewed the implement diff first, then the surrounding code. Categories with nothing in them are
called out explicitly below rather than left silent.

### Fixed in this pass (minor)

- **A re-arm that arrived while the peer's own run was in flight was dropped, not deferred**
  (`peer-join-backfill.ts`, `schedulePeer`). `scheduleConnectedPeers()` skipped any peer with a
  run in flight, and the implement pass documented that as intentionally cheap. It is the exact
  race the re-arm exists to close: the gate check is `isAuthorizedMember`, a full `CadrePeer`
  query over the control database, so the membership commit that would authorize the joiner can
  land *after* that check and *before* the run ends. In that window the schedule was discarded and
  the denied joiner waited for a reconnect — the outcome the re-arm was added to prevent. Now such
  a schedule is remembered and replayed when the run finishes; `schedulePeer` re-checks `done`, so
  a run that finished clean re-arms nothing. Two new unit cases pin both halves.
- **`startControlBackfill` read the `controlStorage` memo field instead of calling the idempotent
  `resolveControlStorage()`.** It worked only because `start()` happens to build the control node
  options (which resolve the store) first. Any future reordering would have disarmed the catch-up
  silently, and the only symptom is the empty-table bug this ticket exists to fix. Now goes
  through the resolver, with a unit case that fails on a node where nothing resolved the store.
- **`scheduleConnectedPeers()` counted connections, not peers** — a peer holding several
  connections was scheduled repeatedly and over-counted in the `start()` log. Now de-duplicated;
  returns distinct peers. Cosmetic, but it also removed redundant timer churn.

### Test gap closed (this was the largest finding)

The control side had **no unit coverage of its own wiring** — the strand side has
`strand-instance-manager-backfill.spec.ts` for exactly that decision. Most importantly, nothing
failed if `authorizePeer` were dropped from the control wiring: the integration scenario
authorizes its joiner before the dial, so it would still pass while the node pushed the party's
whole membership, peer addresses and strand list to any peer the inbound gate admits for another
reason (seed delivery, an open enrollment window, an outstanding invitation, a configured
bootstrap or relay peer). New `packages/cadre-core/test/cadre-node-control-backfill.spec.ts`
pins: the gate is wired and is `isAuthorizedMember`; the network name, protocol prefix and store
identity; the 250 ms default and the embedder override; the three no-arm cases (disabled, no
storage, no keyNetwork) plus no control node; `cleanup()` stopping and dropping it so a restart
rebuilds; and that a membership refresh re-arms — but a *failed* refresh does not.

### Tripwires recorded (conditional — deliberately not tickets)

- **The 250 ms control debounce is reasoned, not swept.** `NOTE:` at the site in
  `startControlBackfill`, with the revisit condition in both directions: lower it first if the
  control gates start flaking on a joiner that stopped before being caught up; raise it if
  catch-up pushes ever show up as connection-churn noise.
- **Every membership refresh re-arms every connected, not-yet-caught-up peer, and each re-armed
  pass costs one `CadrePeer` query at the gate.** A connection that is admitted but never
  authorized — a configured bootstrap or relay peer, the steady state for a NAT'd node — is
  therefore re-judged on every membership write and every timed reconcile tick, forever.
  Negligible at a cadre's handful of connections. `NOTE:` at the call site in
  `refreshAuthorizedControlPeers` names the fix if it ever matters (skip peers whose last pass was
  denied under the same membership snapshot).

### Verified, no change needed

- **The inbound side really is gated.** The implement handoff claims the existing per-stream gate
  covers inbound pushes; that is a security claim, so it was checked upstream rather than taken on
  faith. `libp2p-node-base.ts` spreads one `inboundAuthorization` slice into all four
  database-protocol services, `blockTransfer` included, so `authorizeInboundControlStream` does
  cover the push protocol. (Its cold-start carve-out — an empty authorized snapshot admits
  everyone — is pre-existing, documented at the predicate, and outside this ticket.)
- **`isAuthorizedMember` excludes self and denies bootstrap/relay peers**, so the catch-up never
  pushes the control store to infrastructure peers. Correct and load-bearing.
- **Teardown ordering.** The catch-up is stopped before the control database closes and before the
  node stops; timers are cleared, the `connection:open` listener removed, and in-flight runs
  observe the stopped flag. The new deferred-re-arm set is cleared on stop too.
- **Docs.** `architecture.md`, `cadre-consistency.md` and `cluster-size.ts` were read in full at
  the changed passages; each previously asserted the control network deliberately had no catch-up,
  and each now states the new behaviour including the membership gate. `docs/testing.md` carries
  no scenario inventory, so it needed nothing. Integration scenarios are glob-discovered — no
  registry to update.

### Filed as tickets: none

Every finding above resolved at its own site inside this pass. Two adjacent concerns were checked
against existing tickets rather than re-filed:

- `cadre-node.ts` is now 5726 lines and this ticket added roughly 110 of them. The size debt is
  already owned by `backlog/debt-cadre-node-single-file-size`; the site-claim grep found it, so
  this is evidence on that ticket, not a new one.
- The whole-store push to every connected peer, and the unmeasured cost of `isAuthorizedMember`
  per gate check, already carry `NOTE:` tripwires written by the implement pass at their sites.
  Neither revisit condition has tripped.

### A residual failure in the same scenario file, already tracked

The five-round gate on `control-delete-while-alone-convergence` came back **9 of 10 cases green**,
not 10 of 10 as the implement pass measured. The failure this ticket fixed (the line-154
`isMember` assertion) appeared in **none** of the five rounds. The one red round threw
`SyncRetryExhaustedError { collectionId: 'default/CadrePeer', attempts: 10 }` out of
`Collection.syncInternal` — this file's *other*, older cause, owned by
`blocked/forked-control-collection-sync-livelocks`. That ticket asked to be re-measured once this
work landed; it now carries the measurement, and `tickets/.pre-existing-known.md` gained an Open
entry so the next agent does not read "resolved" as "this scenario is always green" or re-triage
the residue. Not re-filed: the root cause is upstream in `@optimystic/db-core`'s sync retry loop
and already blocked.

Also re-stated so a future pass does not re-file them:
`blocked/block-held-by-only-one-machine-is-unreadable` (different site; shares the solo-commit
origin, exposure reduced but not removed) and
`backlog/control-rereplication-broadcast-confirmation` (the row-level twin; not subsumed by this).

## Validation (all green)

| gate | result |
| --- | --- |
| `yarn lint` (root) | exit 0 |
| `yarn typecheck` (root) | exit 0 |
| `yarn build` (root) | exit 0 |
| cadre-core unit suite | 107 files, 1718 passed, 1 skipped |
| new `cadre-node-control-backfill.spec.ts` + `peer-join-backfill.spec.ts` | 36 passed |
| `control-offline-read-after-restart` ×3 isolated | 3/3 |
| `control-delete-while-alone-convergence` ×5 isolated | 4 files green, 9/10 cases — the one red is the separately-tracked fork livelock, not this fix |
| `control-write-while-alone-convergence` ×1 | 2/2 (no regression) |
| `strand-membership-closed-strand-e2e` ×1 | 6/6 (the rename regressed nothing strand-side) |
