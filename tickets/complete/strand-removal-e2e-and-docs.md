----
description: Removing a party from a shared workspace is now proved on a real network to cut its machines off, and the docs say plainly what that guarantees and what it still does not.
files: packages/integration-tests/src/scenarios/strand-removal-cuts-network.integration.ts, packages/integration-tests/src/harness/node-fixtures.ts, packages/integration-tests/src/harness/topology.ts, packages/cadre-core/src/strand-revocation-enforcer.ts, docs/strands.md, docs/architecture.md, docs/testing.md
----

# Strand removal, proved end-to-end and written down

Third and last ticket of the plan `removal-must-cut-the-network-not-just-the-row`. The
per-strand revoked-peer gate (`strand-revoked-peer-gate`) and the teardown sweep
(`strand-revocation-teardown`) had already landed but were asserted only against stubs.
Implement commit `e01a2ca`; review fixes in the commit carrying this ticket.

## What is true now

- **The claim is proved on real nodes.** `strand-removal-cuts-network.integration.ts`
  (three tests, ~68 s) asserts against real libp2p nodes, real strand databases and real
  replication that a removal hangs up **every** machine of the removed party on each
  remaining machine that has processed it; that a machine which has not processed it keeps
  serving (the documented fail-open direction, asserted deliberately); that the remaining
  cohort still commits and reads back among itself; that the removed party can neither pull
  that write nor push one back; that a removed node is told on its own poll interval
  (`strand:revoked`) with nothing torn down on its behalf; and that an open strand running
  in the same two processes is untouched.
- **The harness can control revocation timing.** `revocationPollMs` on `ControlNodeOpts`
  and `TopologyMachineSpec` forwards to `CadreNodeConfig.strandRevocationEnforcement.pollIntervalMs`.
  Set long, it suspends a machine's own refresh so every cut is attributable to the one the
  test drove; set short, it exercises the interval route. Purely additive.
- **The docs answer the question an app author actually has.** `docs/strands.md` →
  Removing Members gained three sub-sections: what removal does to the network, what the app
  must call (`CadreNode.refreshRevocationEnforcement`) and what the removed party is told,
  and what removal still does not do — first among which is that per-party removal is not
  reachable from an app until `feat-strand-party-identity` lands, because production writes
  no device records and every party presents the founding member identity. The device-record
  bullet now says clearing an orphan also forgets the network denial, and the stale "relay
  willingness deferred" bullet is split into its landed revocation half and its still-deferred
  admission half. `docs/architecture.md` cross-references from the `revokeMember` writer
  bullet and names the config knob; `docs/testing.md`'s scenario map carries the new scenario
  and its relay gap.
- **Post-removal write latency is recorded where it will be met.** The remaining cohort's
  first write after a cut fails three or four times over 3.5-4.3 s (`BlockUnavailableError …
  peers-unreachable`) before committing, because the cohort must downsize off the removed
  party's now-unreachable machines. Stated at the budget constant, at `tearDownRevoked`, and
  in plain terms for app authors in `docs/strands.md`. It recovers on its own; a write that
  never commits, or `cluster-fetch:no-quorum`, is the upstream (Optimystic) tripwire.

## Review findings

The implement diff was read before the handoff summary.

### Fixed in this pass

- **A swallowed read error** (`strand-removal-cuts-network.integration.ts`). `insertWithRetry`'s
  post-failure read-back was `dataValue(...).catch(() => undefined)` — a silent swallow, against
  the repo rule and against the sibling 2×2 scenario, whose equivalent logs. Replaced with a
  named `rowLanded` helper that warns. It fired on the very next run, which is the point: the
  log now shows the read-back failing for the same `peers-unreachable` reason as the insert.
- **A vacuous assertion** (test 2). `expect(revokedOnA).toEqual([])` — "the remaining party is
  not told it was removed" — ran while a[0]'s poll was suspended and a[0] had never derived a
  deny set, so it could not have fired either way. Kept as a baseline, and the load-bearing
  copy added after a[0]'s refresh, where a[0] holds a deny set containing b[0] and still does
  not signal itself.
- **A negative assertion with no visible subject** (test 1, the removed party's push-back).
  Both outcomes were treated as the cut, correctly, but nothing said which one happened, so
  "a[0] never converged on the pushed row" could mean the row never existed. The author's own
  read-back is now logged beside the write outcome. Measured: on this fixture the removed
  party's write fails outright and is not readable back even locally, so that pair of negative
  assertions is currently vacuous — honest, and now visible in the log rather than implied.
  Not asserted either way: requiring a particular shape would make it a flake, since a write
  that fails outright is equally the cut.
- **A non-null assertion at every connection read.** `strandMachine` already validated
  `instance.libp2pNode`, then `strandConnectionsTo` re-asserted it with `!`. The handle is now
  captured once on `StrandMachine`.
- **An over-precise measurement.** The docs, the enforcer `NOTE:` and the test's budget doc all
  stated the post-cut write as "failed four times … ~4.1 s". Two further runs measured 4 failures
  / 4295 ms and 3 failures / 3461 ms, so all three sites now state the range over four runs. The
  shape of the claim — it fails repeatedly and then recovers — reproduced every time.
- **An undocumented config knob.** `CadreNodeConfig.strandRevocationEnforcement` (cadence, and
  `enabled: false` to disarm) appeared in no doc, unlike its sibling `strandBackfill`. Added to
  `docs/architecture.md`'s `revokeMember` bullet.
- **Two unasserted behaviours, stated at the site** rather than left for the next reader to
  wonder about: that test 1's fail-open arm pins "has not PROCESSED the removal" and not "has
  not RECEIVED it" (racing replication needs a partitioned fixture and pins a strict sub-case),
  and that the removed party's two machines stay connected to each other throughout — correct,
  since a node never hangs itself up and neither has refreshed against the other, but asserted
  nowhere.

### Filed as an arm on an existing ticket

- **Helper duplication** — a third arm on `debt-hoist-strand-read-helpers-integration`, which
  already tracks this class. The new file adds a third `memberKeys` / `freshKeyPair`, a fifth
  `GATE`, a thirteenth `SIMPLE_SCHEMA` and a second `insertWithRetry`. Its `expect`-based
  connection helpers hit the same "harness modules do not import vitest" decision that arm two
  recorded, which is why the hoist stays that ticket's job and not a review-pass edit.

### Checked and found sound

- **The docs' claims against the code.** Every hook the "refuses … at the connection, stream,
  dial and relay-reservation hooks" sentence names exists (`denyInboundEncryptedConnection`,
  `denyDialPeer`, `denyInboundRelayReservation`, `authorizeStream`); `refreshRevocationEnforcement`
  really does await the sweep, so "closes the sessions before it returns" is true; the 30 s
  default matches `DEFAULT_REVOCATION_POLL_INTERVAL_MS`; the delegate-grant paragraph agrees with
  the relay-willingness section it cites; every cross-reference anchor resolves; and both ticket
  slugs the docs point at (`feat-strand-party-identity`, `feat-strand-invitee-bound-invites`) are
  open in `backlog/`.
- **The harness change.** `revocationPollMs` reaches the enforcer (`CadreNodeConfig` →
  `StartStrandConfig.revocationEnforcement` → constructor). It is per-machine only, with no
  spec-level convenience — considered and declined: `strandWatchMs` is the sole spec-level knob
  and every other per-machine knob (`reconcileMs`, `enableRelay`, `listenAddrs`) is machine-only,
  so the new one follows the majority shape.
- **No missed call site.** Nothing outside `cadre-core` and the tests calls `revokeMember` or
  `leaveStrand` today (cadre-host's "revoke" is trust-circle and donation grants, unrelated), so
  the docs' "call `refreshRevocationEnforcement` right after the write" guidance has no existing
  caller it should have been applied to.
- **Unit coverage behind the e2e.** `strand-revocation-enforcer.spec.ts` (42 tests) covers the
  arms the e2e deliberately does not re-prove: re-admission clearing the deny set, the
  self-revoked latch re-arming, multi-connection hangUp, the mid-read join skew, and every
  composed-gater failure direction.
- **Scenario 3's indirect assertion.** The handoff asked for a second opinion on asserting "no
  enforcer is armed on an open strand" through its consequences rather than directly. Left as
  is: whether an enforcer object exists is genuinely not observable — `refreshRevocationEnforcement`
  is quiet for an unarmed strand and an unknown one alike — and a stronger assertion would mean
  widening the public API for a test. The two consequences it asserts instead (an open strand can
  hold no deny record at all, and its traffic survives a closed-strand removal in the same
  processes) are the observable content of the claim.

### Not filed, by category

- **Major findings: none.** No behaviour defect was found in the enforcer, the harness change or
  the scenario; every fix above is in the test or in prose.
- **Tripwires: none new.** The implementer's tripwire at `NO_CONVERGENCE_BUDGET_MS` (four
  sequential negative arms spend ~40 s; run them concurrently before shortening the budget)
  still reads correctly and is left where it is. The two site NOTEs added above are
  clarifications of asserted/unasserted scope, not conditional concerns.
- **Accepted tradeoffs: none re-opened.** The `NOTE:` at `createRevocationConnectionGater`
  (uniform fail-open swallowing a base gater's throw) states its revisit condition — an embedder
  shipping a gater whose throw is a meaningful deny — and nothing in this diff trips it.

### Known gap, carried forward deliberately

Every connection under test is DIRECT. The relay-mediated variant — a removed party reached over
`/p2p-circuit`, where `hangUp` must also drop the relay reservation riding the connection — is
still asserted only against a stub. Staging it needs the relay-only two-party fixture of
`blind-relay-phone-to-phone-e2e.integration.ts` (dedicated relay, `listenAddrs: []` on both ends,
a bound invitation, formation over the circuit), a second topology rather than an option on this
one. Named in the new file's header and in `docs/testing.md` → scenario map, per the implement
ticket's own instruction to report rather than force it. No ticket filed; it is recorded as an
uncovered scenario alongside the other three in that map.

## Validation

Run at review, all green: `yarn lint` (0), `@serfab/integration-tests typecheck` (0),
`@serfab/cadre-core test strand-revocation` (42/42), the new scenario twice (3/3 each,
54.7 s and 64.1 s for test 1), the new scenario plus `strand-membership-closed-strand-e2e`
(12/12 — the regression guard, because that file clears orphaned `MemberPeer` rows, which are
now the deny record), and `harness-topology` plus `strand-membership-second-machine` (8/8, the
other two `bootTopology` consumers). No pre-existing failures surfaced.
