----
description: The test that is supposed to prove a phone can rejoin a party after its first connection attempt is turned away still passes when the rejoin code it guards is switched off entirely — so that behaviour is currently unprotected and could break without anyone noticing.
prereq:
files: packages/integration-tests/src/scenarios/control-cohort-cold-start-retry.integration.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/bootstrap-peer-store.ts, packages/integration-tests/src/harness/node-fixtures.ts
difficulty: medium
repro: verified
----

# The cold-start redial scenario's regression assertion does not discriminate

`control-cohort-cold-start-retry.integration.ts` exists to be the acceptance proof for
`cold-start-control-redial`: its step 5 asserts that B, whose single seed dial was refused,
gets back in via `reconcileControlCohort`'s cold-start branch
(`CadreNode.dialColdStartBootstrap`, `cadre-node.ts:2417`). The module doc states the proof
outright — *"Without the cold-start branch in `reconcileControlCohort`, step 5 below times
out"*.

That is not true today. **With `dialColdStartBootstrap` neutralized, the scenario still
passes.** Some other dialer produces B's outbound connection to A, so the assertion cannot
tell the guarded branch from its absence, and the feature is effectively untested.

This is NOT the red that was triaged alongside it. The scenario's *failure*
(`Timeout waiting for B's cold-start seed dial is refused after 10000ms`) was a separate
fixture defect and is fixed — see "Relationship to the fix that landed". The scenario is
green. This ticket is about the green being hollow.

## How it was measured (2026-08-20, at `85715c3` plus the fixture fix)

Instrumented `packages/cadre-core/src/cadre-node.ts` behind an env flag, rebuilt
`@serfab/cadre-core`, ran the scenario, then restored the file:

1. Early-return at the top of `dialColdStartBootstrap`, with a `console.log` proving the
   suppression fired.
2. A `console.log` of the sibling list at `cadre-node.ts:2138`
   (`const siblings = members.filter(...)`).
3. A `console.log` in the step-5 dial loop (`dialControlSibling`, `cadre-node.ts:2192`).

Result, cold-start branch SUPPRESSED:

```
[teeth] reconcile: siblings=[]
[teeth] dialColdStartBootstrap SUPPRESSED
[teeth] reconcile: siblings=[]
[teeth] dialColdStartBootstrap SUPPRESSED
 ✓ ... B recovers from a refused seed dial and converges on a later reconcile pass 3513ms
```

So within the same run: B's `CadrePeer` table really is empty (`siblings=[]`, exactly the
premise step 5 relies on), the steady-state sibling dial loop therefore never runs, the
cold-start branch is suppressed — **and B still ends up with an open outbound connection to
A, and still pulls the X row in step 6.** No sereus-level reconcile dial happened at all.

With the branch enabled the same instrumentation shows `siblings=[]` and the cold-start
pass doing the dial, i.e. in normal operation the intended path *is* the one that runs. The
defect is only that the assertion does not require it.

## Root-cause hypothesis

Step 5 asserts on an outcome (`connectionsTo(B, aPeerId).some(c => c.direction === 'outbound')`)
that more than one subsystem can produce, while the doc reasons as though only one can. The
competing producer has been narrowed but not identified — ruled out by the instrumentation
above are `dialColdStartBootstrap` and the steady-state `dialControlSibling` loop. Remaining
candidates, in rough order of likelihood:

- **libp2p's own connection manager auto-dialing** B→A from the peerStore entries
  `SeedBootstrapService.applySeed` populated. B holds A's addresses regardless of the
  `CadrePeer` table, and `applySeed` seeds the peerStore precisely so
  `resolveControlDialAddrs`'s fallback (`cadre-node.ts:2318`) can use them.
- **Optimystic cluster/repo dialing** driven by B's own `listMembers()` pull-on-read at the
  top of the reconcile pass — that read tries to reach the cluster, and the transport layer
  may dial A from the peerStore to serve it.

Confirming which is a prerequisite for the fix, since the remedy differs: the first wants
the competing dialer suppressed or excluded in the fixture, the second means "B has no
sibling rows" never implied "nothing else will dial A".

## Design constraints

- **Do not weaken step 5 to make it discriminate.** The assertion must still prove a real
  reconnection, not merely that some internal counter moved. Strengthening means making the
  *connection* attributable to the cold-start branch, not replacing the connection check
  with a weaker proxy.
- **Do not neutralize the competing dialer in product code.** libp2p auto-dial and the
  optimystic read path are wanted behaviour; if one of them is what reconnects B, that is a
  fact about the system, and possibly a finding in its own right (the cold-start branch may
  be less load-bearing in this configuration than its doc claims). Suppress it in the
  FIXTURE, or assert something only the cold-start branch can produce.
- **Keep the "B listens on nothing" property.** It is what makes `direction === 'outbound'`
  meaningful; any redesign that gives B a listen address destroys the proof.
- **The scenario must keep failing when `dialColdStartBootstrap` is removed.** That is the
  acceptance test for this ticket — re-run the suppression measurement above and require a
  red, then restore.
- **`enableRelay: false` on node A stays.** See below; removing it re-breaks step 3.
- If the investigation concludes the cold-start branch is genuinely redundant in this
  configuration, that is a *finding about the feature*, not licence to delete the scenario —
  route it back through a ticket rather than resolving it in the test file.

No cross-cutting obligations identified: this is test-side only (no determinism edition
bump, byte-format vector, golden fixture, or migration), unless the investigation turns up
a product change, in which case re-evaluate.

## Relationship to the fix that landed

The scenario was red for an unrelated reason, root-caused and fixed in the same pass:

- `CadreNode.relayServerEnabled()` (`cadre-node.ts:1247`) defaults the circuit-relay server
  to `profile === 'storage'`. Node A is a storage node, so it ran the relay server, so its
  gate answered B's unvouched dial with `'admit-for-relay'` rather than a deny (the
  relay-reservation seam, landed in `6c87c5b`/`8180ebf` after this scenario was written).
  Measured: A admitted B, then aborted the connection at the 5 s not-reserving deadline —
  and B did not observe the abort for a further ~9 s (one connection-monitor ping), so
  step 3's poll for zero connections never saw one.
- `controlNodeConfig` could not express the fix, because
  `...(opts.enableRelay ? { enableRelay: true } : {})` dropped an explicit `false` on the
  floor, silently leaving the storage-profile default in place. That truthiness test was
  changed to `!== undefined`; `enableRelay: false` is a supported product config already
  covered by `packages/cadre-core/test/membership-connection-gater.spec.ts:594`.

Fixing that got step 5 *reached* for the first time — which is how the toothlessness became
visible at all. Before the fix, step 3 timed out and step 5 never ran.

Also worth a look while in here (observed, not filed separately): **B held the aborted
connection in `status: 'open'` for ~9 s after A aborted the underlying `MultiaddrConnection`**,
rather than observing the close promptly. Bounded and self-healing, but it means a node can
believe it has a live control link for several seconds after the far side killed it, and
`dialColdStartBootstrap` skips peers in `getConnections()` — so a phantom-open connection
suppresses the retry for that window. Same truthiness caveat applies to the local
`createTestNodeConfig` helpers in `rbac-signed-write.integration.ts:54`,
`strand-formation-e2e.integration.ts:131`, and
`strand-membership-closed-strand-e2e.integration.ts:185`, which still drop an explicit
`false`; no current caller passes one.

## TODO

- [ ] Identify the competing dialer: instrument B's libp2p `dial`/connection-open path (and
      the optimystic transport) with the cold-start branch suppressed, and attribute the
      connection observed in step 5.
- [ ] Decide the remedy per "Design constraints" — fixture-side suppression of the competing
      dialer, or an assertion only the cold-start branch can satisfy.
- [ ] Apply it, then prove teeth: suppress `dialColdStartBootstrap`, rebuild
      `@serfab/cadre-core`, and require the scenario to FAIL. Restore and require green.
- [ ] Run the scenario at least 3× green after the change (it currently completes in ~2.5 s,
      so a regression to a timeout is obvious).
- [ ] Update the module doc's claim to match whatever the assertion actually proves.
- [ ] Consider whether the ~9 s phantom-open connection warrants its own ticket.
