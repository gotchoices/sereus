----
description: Shared-workspace network nodes now refuse the machines of a party that was removed, so removing someone starts meaning "we stop talking to you" instead of only deleting a record.
files: packages/cadre-core/src/strand-revocation-enforcer.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/membership-connection-gater.ts, packages/cadre-core/src/strand-network-config.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/strand-membership-writer.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/strand-revocation-enforcer.spec.ts, packages/cadre-core/test/strand-instance-manager-revocation.spec.ts
----

# Strand revoked-peer gate — complete

First of three tickets under `plan/4-removal-must-cut-the-network-not-just-the-row`
(gotchoices/sereus#4; owner ruling 2026-09-09: enforce at the connection and stream
layer). Siblings remain in `implement/`: `strand-revocation-teardown` (close the
connections a revoked peer already holds) and `strand-removal-e2e-and-docs` (real-network
proof + `docs/strands.md`).

## What landed

A closed strand's node materializes an in-memory **deny set** of peer ids belonging to
removed members — every `Strand.MemberPeer.PeerId` whose `MemberKey` has no live
`Strand.Member` row, minus any peer id that also serves a live member — and refuses those
peers at two layers:

- **Per-stream (primary, fail-closed).** `authorizeInboundStream` on the strand's libp2p
  node gates all four `/optimystic/strand-<id>/*` protocols; upstream aborts a denied
  stream before decoding anything. This is also what catches a revoked peer arriving over
  a relayed or pre-revocation connection.
- **Per-connection (secondary, opportunistic).** `createRevocationConnectionGater`
  composes deny-iff-revoked onto `denyDialPeer`, `denyInboundEncryptedConnection` and
  `denyInboundRelayReservation` over whatever gater the embedder supplied — every base
  hook preserved, deny from either denies, errors and slow decisions fail open.

The set refreshes on a poll (default 30 s) plus an explicit `refresh()`; refreshes are
serialized, a failed read keeps the previous snapshot, and the snapshot starts empty so
bring-up and resume are never blocked or wrongly denied. Armed only for `Type === 'c'`
strands; open strands keep the raw configured gater byte-for-byte. Knob:
`CadreNodeConfig.strandRevocationEnforcement` → `StartStrandConfig.revocationEnforcement`
(`{ enabled: false }` restores the old behaviour). Lifecycle follows `PeerJoinBackfill`:
built in `buildStrandRuntime`, started after the strand DB initializes, stopped and
dropped in `releaseRuntime`.

The design record — why a deny-list on positive revocation evidence rather than an
allowlist, which fail direction each state takes, and exactly what did and did not
transfer from the control network's membership gater — lives in the module doc of
`strand-revocation-enforcer.ts`, not here.

## Review findings

Reviewed the implement diff (`c81dac1`) before the handoff summary. Lint clean;
`@serfab/cadre-core` build + typecheck clean; tests **114 files / 1921 passed, 1 skipped**
(the skip is `key-store.spec.ts`'s platform guard, `skipIf(win32)`, pre-existing and
unrelated). Baseline was 1919; the two added tests are below. No pre-existing failure
surfaced, so nothing was written to `tickets/.pre-existing-error.md`.

**Fixed in this pass (minor):**

- **Read skew between the two membership scans could revoke a brand-new member.**
  `readStrandRevocationRows` issued two independent scans with nothing holding them to one
  snapshot, and read `Strand.Member` first. A join commits as `Member` row then
  `MemberPeer` row (`MemberExists` forces that order), so a join landing between the two
  scans produced a binding whose member key was missing from the older key set — the
  joiner classified as REVOKED and denied at the fail-closed stream gate until the next
  poll. That is the one fail-CLOSED outcome the module exists to avoid, and it
  contradicted the module doc's own "a joining party mid-admission is admitted". Fixed by
  scanning `MemberPeer` **first**, which inverts every skew window to fail-open (a new
  binding is simply absent from the older bindings snapshot; a revocation is still seen,
  because the key is missing from the newer key scan). The ordering is now load-bearing
  and says so in the function doc, decomposed into `scanBindings` / `scanMemberKeys`.
- **Two test gaps closed** in `strand-revocation-enforcer.spec.ts`: a behavioural
  regression guard for the scan ordering (a `Database` double whose tables gain a joined
  member between the two scans — asserts the joiner is admitted), and one asserting a read
  that resolves after `stop()` is discarded rather than repopulating a torn-down
  enforcer's snapshot.
- **Stale doc.** `strand-network-config.ts` still claimed `NetworkConfig.connectionGater`
  is "inherited unchanged by the caller"; that is now true only for open strands.
  Corrected with a pointer to the composition.

**Recorded as an accepted tradeoff (not filed):**

- The three composed gater hooks **swallow a base gater's throw and admit**, whereas
  `createMembershipConnectionGater` lets it propagate (fail-closed there). The divergence
  is deliberate — uniform fail-open per hook, and the shape the plan's test list specified
  — but it means an embedder gater that throws is honored on an open strand and silently
  admitted on a closed one. A `NOTE:` at `createRevocationConnectionGater` records the
  decision with its revisit condition (an embedder shipping a gater whose throw is a
  meaningful deny, or the two gaters being unified). Not re-filed.

**Routed to the sibling ticket (not a new ticket):**

- **The gate is one-directional.** It judges streams a revoked peer opens to us and
  refuses new connections; nothing stops THIS node pushing over a connection that is
  already open, and `PeerJoinBackfill` does exactly that for the life of a connection. So
  a removed party that stays connected can keep receiving blocks until teardown lands.
  `hangUp` closes both directions, so no separate outbound gate is warranted — appended as
  an arm on `implement/strand-revocation-teardown`'s edge-case list, with a note that a
  test should assert the push stops after the sweep.

**Checked and clean (explicitly, with the reason):**

- **Wiring correctness.** The `authorizeInboundStream` contract in
  `@optimystic/db-p2p/inbound-authorization.ts` matches what is passed: same
  `(remotePeerId: string, protocol: string) => boolean` shape, peer id encoding is
  `PeerId.toString()` on both sides, fail-closed on false/throw/timeout, and a synchronous
  predicate skips the deadline machinery entirely. Only one strand libp2p node is created
  in the repo (`strand-instance-manager.ts:473`), so there is no second site that should
  have been armed and was not.
- **Lifecycle and cleanup.** The enforcer is registered before the `try`, so the
  `buildStrandRuntime` failure path tears it down through the same `releaseRuntime`
  rollback as every other runtime component; quiesce, resume and `stopStrand` all route
  through it. The `readRows` closure reads `instance.database` through the instance
  record (not a captured handle), and `stop()` runs before the database closes. The
  default scheduler `unref()`s its interval, so an armed enforcer never holds a process
  open. No leak found.
- **Refresh state machine.** `doRefresh` never rejects, so the serialization chain cannot
  break permanently; both the pre-read and post-read `stopped` guards are present; a
  failure keeps the prior snapshot. Interval ticks skip rather than queue while a refresh
  is in flight — the unbounded-chaining concern the handoff raised is bounded in practice
  by that skip plus rare on-demand calls, and it is documented at the method. Left as is.
- **Config surface.** `strandRevocationEnforcement` is not exposed in the
  CLI/host/provider config schemas — checked, and neither is `strandBackfill` or
  `controlBackfill`, so this is consistent rather than an omission.
- **Source hygiene.** New module 399 lines (now 433 with the ordering doc and the two
  extracted scan helpers); `strand-instance-manager.ts` at 855 lines after +79. Neither is
  at the size where a split earns itself, and no size-debt ticket claims either file.
- **Docs.** `docs/strands.md`'s "revocation is forward-looking only" paragraph is now
  partially stale (the network IS cut), and its deferred-`MemberPeer` note at line 134 has
  been overtaken. Both are explicitly owned by `implement/strand-removal-e2e-and-docs`
  (its `files:` names `docs/strands.md`), so they were left alone rather than
  half-rewritten ahead of the e2e proof. The code-site NOTEs carry the story meanwhile.
- **No tripwires recorded this pass** beyond the accepted-tradeoff NOTE above: the two
  conditional concerns at these sites — the twice-per-refresh full table scan and the
  bounded staleness of the poll — already carry NOTEs from the implement pass, and the
  cost tripwire at `readStrandRevocationRows` names its real fix (a reliable filtered
  read, gated on `debt-composite-pk-point-lookup-unreliable-untracked`).

**Known limits carried forward, unchanged and already documented:**

- **Inert on production strands today.** Formation gives every party the same
  `MemberPrivateKey`, so a real closed strand has one founding `Member` and no
  `MemberPeer` rows — the deny set is empty and behaviour is exactly as before. The gate
  is exercised by tests minting distinct member keys.
  `backlog/feat-strand-party-identity` owns the identity work.
- **No real-network assertion here.** Stream-gate wiring is asserted at the
  `createLibp2pNode` options level only; the two-live-nodes proof is
  `implement/strand-removal-e2e-and-docs`.
- **Already-open connections survive** a revocation until
  `implement/strand-revocation-teardown` lands (see the routed finding above).
- **A resume opens a short admit window** until the first read completes — the accepted
  fail-open posture, documented at the class.
