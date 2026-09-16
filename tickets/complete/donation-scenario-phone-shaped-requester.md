description: An automated end-to-end test now covers the case node lending exists for — a phone, which can only make outgoing connections, asking a self-hosted machine for a node and then staying connected to it across both a node restart and a phone restart.
files: packages/integration-tests/src/scenarios/cadre-host-donation-phone-requester.integration.ts, packages/integration-tests/src/harness/node-fixtures.ts, packages/integration-tests/test/control-node-config.spec.ts, docs/testing.md, docs/cadre-host.md, docs/architecture.md
----
# End-to-end: a phone-shaped requester borrows a cadre-host node

Implemented and reviewed. Both prereqs (`donated-node-reachable-by-phone`, `owner-keeps-dialing-node-it-added`) had already landed and are archived.

## What landed

**The scenario** — `packages/integration-tests/src/scenarios/cadre-host-donation-phone-requester.integration.ts`, nine ordered `it` steps so a failure names the step it broke on. In-process `GrantService` + `DonationService` + `HostProcessOrchestrator` spawning a real `cadre-cli` child, like the sibling `cadre-host-node-donation.integration.ts`. The difference is the requester: an in-process `CadreNode` with `listenAddrs: []`, WebSocket + circuit-relay transports only, no TCP, `profile: 'transaction'`, a persistent identity key, and owner genesis run on itself — the shape `packages/reference-app-rn/src/phone-node-config.ts` builds, minus WebRTC.

The nine steps: requester up and undialable; `provision` with `bootstrapNodes: []`; a `/ws` address on the child; vouch + seed; the requester dials in; rows cross both ways; the node respawns onto the same WebSocket port and the requester reconnects; the requester restarts on its retained identity, storage and dial targets and reconnects with no second donation request; `terminate`. Port band **20340–20499**, which no other scenario uses (confirmed by `grep -rn "portRange: { start" src`).

**One harness seam added** — `ControlNodeOpts.bootstrapPeerStore` in `src/harness/node-fixtures.ts`, forwarded to `bootstrapPeers.store`. Step 8 needs the restarted requester to hold the dial targets the first incarnation retained. Two unit tests in `test/control-node-config.spec.ts`: one that the store is forwarded verbatim, one that `bootstrapPeers` is left off entirely when no store is supplied.

**Docs** — `docs/testing.md`, `docs/cadre-host.md` and `docs/architecture.md` now describe the donation surface as it actually stands.

## Use cases this pins

- A phone that can accept no inbound connection can still borrow a node and reach it. The requester's `getMultiaddrs()` is asserted empty **before and after** the connection exists, so a regression that silently added a listener cannot make the file pass for the wrong reason.
- `POST /grants` with no bootstrap addresses works, and the empty list round-trips through `donations.json` as `[]` rather than `undefined`.
- A lent node's addresses are a **mixed** list — TCP and `/ws`, loopback and LAN — handed to `dial()` unfiltered. The requester has no TCP transport and the dial still lands.
- A respawned lent node comes back on the same WebSocket port, and the requester reconnects off its own reconcile pass with no further donation call.
- A restarted requester reconnects from what it carried across the restart alone.

## How to run it

```
yarn workspace @serfab/cadre-core build
yarn workspace @serfab/cadre-cli build
yarn workspace @serfab/cadre-host build
cd packages/integration-tests
yarn test src/scenarios/cadre-host-donation-phone-requester.integration.ts
```

## Review findings

Read the implement diff (`2507df2`) before the handoff summary, as the stage asks. Ran `yarn lint` (exit 0), `yarn workspace @serfab/integration-tests typecheck` (exit 0), the new scenario 9/9 twice, the sibling `cadre-host-node-donation.integration.ts` 6/6, and the package's unit specs 46/46 — all after the edits below.

**Checked and found sound — the two claims most worth attacking.**

- *Does step 6 actually prove a signed record crossed back, or could the requester's own retained dial targets satisfy it?* Read `CadreNode.resolvePeerAddrs` (`packages/cadre-core/src/cadre-node.ts:2430`). It is strictly control-DB-record-only: no `bootstrapPeerStore` fallback, and the record must pass a publicKey↔peerId binding, self-signature verification, freshness and the trust policy. Step 6's assertion is a real proof of the round trip, not a tautology.
- *Does the respawn leak an orchestrator handle, so that `getNode` or `afterAll` could act on the pre-respawn container?* `createContainer` drops prior handles for the same `containerId` (`packages/cadre-host/src/orchestrator/host-process-orchestrator.ts:269`) and reuses the workdir deliberately, which is why the peer id and port survive. No leak, and step 9's `getNode(...)` being `undefined` is meaningful.

**Minor — fixed in this pass.**

- `docs/architecture.md` was stale on two counts and was a file this change should have touched. Its `@serfab/cadre-host` heading and node-donation bullet still said the `/grants` HTTP routes and the `bin/host.ts` wiring "are still being added" — both landed (`packages/cadre-host/src/server/routes/grants.ts`, `packages/cadre-host/src/bin/host.ts`), and `docs/cadre-host.md` had already said so, so the two docs contradicted each other. Rewritten to state what has landed and to name both dial-direction scenarios.
- Step 5's node-side check was `connectionPaths.total >= 1`, which left "the requester reached it over `/ws`" an inference from the requester's transport list rather than something the lent node confirms. Tightened to also require `byTransport.websocket >= 1`. Re-ran: still 9/9, and the assertion is load-bearing (a missing field fails it rather than defaulting true). The comment now states plainly why the node-side check is transport-shaped rather than direction-shaped: `/status` drops the per-connection `paths[]` array to stay cheap (`packages/cadre-cli/src/server/health.ts:160`), so no per-connection direction is exposed on that surface at all.
- `docs/cadre-host.md`: "That scenario's requester…" opened a paragraph whose referent sat in the previous one. Named the scenario instead.
- `docs/testing.md`: the "cross-process nodes (real `cadre-cli` children)" bullet is the index for which scenarios spawn real children, and the new scenario does. Added it there, cross-referencing its own bullet below.

**Corrected from the handoff, no work needed.** The handoff listed "dial direction is asserted on the requester's side only" as something the plan asked for and the implementation missed. Re-reading the plan, what it asked for is *"the connection in steps 5, 7 and 8 must be outbound from the requester"* — which all three steps do assert (`hasOutboundTo` at 5 and 8, an explicit `direction === 'outbound'` at 7). The plan's "assert it anyway" refers to asserting that requester-side direction despite a lent node having nowhere to dial. Nothing is missing. Separately, a node-side *direction* assertion is not reachable without extending `cadre-cli`'s health surface, which would be a product change for a test's benefit; the transport assertion above is the available complement.

**Major — none filed, with reasons.**

- *Step 8 does not pin which dial source produced the reconnection.* Both survive the restart by construction (a fresh signed `CadrePeer` record in the preserved control storage, and the retained entry in the preserved dial-target store). This is not a defect and not new work: the plan explicitly ruled out aging a record inside this scenario and pointed at `owner-keeps-dialing-node-it-added`'s unit specs for the retained-hint branch. It is recorded as a tripwire — a `NOTE:` at the step-8 site saying both branches are live and that distinguishing them would mean disabling one, the way `control-cohort-cold-start-retry.integration.ts` strips a peerStore entry. No ticket.
- *The `DonationSupervisor` is still exercised only against a fake orchestrator.* True, disclosed in `docs/cadre-host.md`, and outside this ticket's diff — the plan never asked this scenario to cover it. Not a finding against this change.
- *Loopback only; strand replication onto a lent node untested.* Both already have open tickets (`backlog/feat-cadre-host-wan-grant-reachability`, `blocked/always-on-nodes-host-strands-of-apps-they-do-not-run`), both referenced from the file header and the docs. Evidence for those, not new tickets.

**Considered and deliberately not changed.**

- *DRY between the two donation scenarios.* Both build an orchestrator + `GrantService` + `DonationService` in `beforeAll`, about twenty lines in common. Left alone: the sibling runs two orchestrators plus an owner node, so a shared builder would be mostly parameters, and two instances is thin evidence for an abstraction.
- *`wsPortsOf` lives in the scenario rather than the harness.* One user today; moving it on a second user is the cheaper order.
- *The hand-rolled structural cast over `/status` JSON.* `HealthStatus` is not exported from `@serfab/cadre-cli`'s public entry, and both `cadre-host-node-donation` and `cadre-host-bootstrap` already read these endpoints the same way. Consistent with the package, so not churned.
- *Step 4 not asserting `peersAdded`.* Correct as written and already explained at the site: `applySeed` counts only seed peers carrying multiaddrs, and a phone-shaped owner contributes none, so the count would measure nothing here.

**Timing variance.** The handoff flagged an unexplained 7.2 s–39.4 s spread in test time across six green runs. Three further runs here came in at 6.99 s, 7.11 s and (sibling) 4.94 s — all at the low end, no failures. Nothing actionable surfaced; per-step budgets are 90 s, so there is ample headroom, and a future flake hunt should still start with the reconcile-pass cadence.

**Pre-existing failures.** None encountered. The `@serfab/integration-tests` typecheck failure the implement pass recorded (three `findCluster(...)` call sites needing a branded `RoutingKey`) was fixed at its root by the triage pass in `fceadbc`; `yarn typecheck` now exits 0 and `tickets/.pre-existing-error.md` is gone.
