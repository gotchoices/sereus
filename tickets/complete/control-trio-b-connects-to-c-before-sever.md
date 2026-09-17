description: Two three-machine tests assumed nothing but the cohort reconcile routine could connect machine B to machine C, but other parts of the networking stack can dial C on their own, so the tests failed at random. The test harness now blocks B from dialling C except during the reconcile passes a test runs, and checks that the pass itself made the connection.
prereq: isolated-node-reads-unwritten-revocation-table-as-empty
files: packages/integration-tests/src/harness/peer-dial-gate.ts, packages/integration-tests/src/harness/control-trio.ts, packages/integration-tests/src/harness/index.ts, packages/integration-tests/src/scenarios/control-cohort-edge-carries-data.integration.ts, packages/integration-tests/src/scenarios/control-cohort-three-node-isolation.integration.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/control-cohort.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/cadre-node-control-cohort.spec.ts, packages/cadre-core/test/control-founding-consult-budget.spec.ts, packages/reference-app-rn/src/host-node-request.ts, docs/architecture.md
----

# Harness dial gate from B to C, and reconcile passes that report what they dialled (complete)

## Background

The A/B/C "control trio" scenarios claim that `CadreNode.reconcileControlCohort` is what connects B (listens on nothing) to C. They backed that claim with "B's peerStore holds no address for C". That premise is false. Optimystic's `ClusterService` merges C's address into B's peerStore when a cluster record from A names it, and FRET then dials addressed ring neighbours on its own. The sever of A in the edge scenario triggers FRET's `announceOnDeparture`, which dialled C within 1 ms in 3 of 9 traced runs. The earlier investigation, with stack traces, is recorded in the `harness/control-trio.ts` header under "B'S DIAL GATE".

## What changed

**cadre-core: `reconcileControlCohort()` now resolves to `ControlCohortReconcileResult { dialed: string[] }`** (`control-cohort.ts`, exported from the package index).
- `dialed` lists the peers the pass dialled whose dial resolved, in dial order. On a steady-state pass these are siblings; on a cold-start pass they are bootstrap peers (`dialColdStartBootstrap` now returns `string[]`).
- A peer already connected when the pass started is never listed.
- Early returns give `{ dialed: [] }`. A stop in the middle of the dial loop returns the peers dialled so far.
- A call that joins an in-flight pass (the single-flight guard) resolves to that pass's result.
- The timer and `self:peer:update` wrappers still `void` the result.
- Callers affected by the type change: the RN `HostNodeRequestNode.reconcileControlCohort` is widened to `Promise<unknown>`, and the consult-budget spec's `measurePhase` `op` is widened to `() => Promise<unknown>`.
- The `dialControlSibling` doc comment was wrong ("whether a dial was attempted"). It now says the function returns whether the dial resolved.
- Unit tests: every `.resolves.toBeUndefined()` in `cadre-node-control-cohort.spec.ts` now asserts the exact `dialed` list. New assertions cover four cases: dialled sibling reported; already-connected sibling not reported; failed dials not reported; the single-flight joiner gets the same result. The cold-start branch reports the bootstrap peer.

**Harness: `peer-dial-gate.ts` (new).** `peerDialGate()` is a gater with a changeable set of denied peers (`deny`, `allow`, `deniedCount`). It covers `denyDialPeer`, `denyDialMultiaddr` (last `/p2p/` component) and `denyOutboundConnection`. It replaces the edge scenario's private `severableDialGater`. `deniedCount` counts gater checks, not dials.

**Harness: `bootControlTrio`.**
- The `gaterB` option is removed; the edge scenario was its only user.
- B always boots with `gateB`, and C is denied on it before B starts.
- `ControlTrio` now also exposes `gateB` and `dialsToC`:
  - `allowDuring(fn)`: opens the gate while `fn` runs, using a depth counter so overlapping calls are safe.
  - `reconcile()`: runs B's boot-time `reconcileControlCohort` with the gate open. It records `{ dialed, outboundToC }`, where `outboundToC` holds B's open outbound connection ids to C, snapshotted before the gate closes.
  - `passes()`.
  - `openingPass()`: returns the first recorded pass whose snapshot contains B's current outbound connection to C.
  - `deniedCount()`.
- The strict check is `expect(dialsToC.openingPass()?.dialed).toContain(cPeerId)`. The gate is closed between passes, so the current connection formed during that pass. If FRET or the transactor had formed it earlier in that pass, the pass would have skipped C and left it out of `dialed`.
- The boot-time checkpoint "peerStore holds no addresses for C before C was vouched" (step 3) is kept.

**Scenarios.**
- Edge scenario:
  - The sever is now `gateB.deny(aPeerId)`.
  - The negative-window peerStore checkpoint is dropped. Every connection-count checkpoint is kept unchanged.
  - Step 6 polls `dialsToC.reconcile()` and asserts `openingPass().dialed` contains C.
  - The header's "WHY THE NEGATIVE WINDOW…" and PIN SCOPING prose are rewritten.
  - The `self:peer:update` NOTE is replaced.
- Isolation scenario, case 2 (load-bearing): both peerStore checks are dropped. The last-checkpoint `resolvePeerAddrs` non-empty check is kept, with new reasoning: `resolveControlDialAddrs` falls back to the peerStore only when the record resolves to nothing. The passes run through `dialsToC.reconcile()`, and the case asserts `openingPass`.
- Isolation scenario, case 1 (2 s timer): **not covered by the ticket's plan.** A closed gate would block the timer pass it tests. The case now sets `B.reconcileControlCohort = () => dialsToC.reconcile()` after boot, so B's own timer and `self:peer:update` passes run through the gate and are recorded. It then polls `openingPass() !== undefined` and asserts that the pass reports C. `dialsToC.reconcile` calls the method B had at boot, so the patch does not recurse.
- `docs/architecture.md` (control-cohort bullet): documents the reconcile result, the `openingPass`-style check, and why the gater is needed. `docs/testing.md` only lists the scenario by name, so it needed no change.

## Validation run (2026-09-16)

- `control-cohort-edge-carries-data`: 9 runs, 8 passed. Run 7 hit the known boot timeout `B resolves C's signed CadrePeer address record` (tracked by the blocked ticket `control-peer-row-refresh-invisible-to-third-node`, listed in `tickets/.pre-existing-known.md`). No other failure occurred. Runs 1-6 carried temporary logging, since removed:
  - Runs 2 and 3: the gate denied 4 dial checks to C during the window, and C's address was in B's peerStore. Before this change, these runs would most likely have failed the window check.
  - Runs 1, 4, 5 and 6: no C address in B's peerStore and 0 denials. This is why `deniedCount` is deliberately not asserted.
  - In every instrumented run, the opening pass's `dialed` was `[C]` and its snapshot held the single link connection.
- `control-cohort-three-node-isolation`: 3 runs, 6 of 6 tests passed.
- cadre-core `cadre-node-control-cohort.spec.ts`: 54 passed. `cadre-node-dial-past-dead-addresses` and `cadre-node-strand-addr-refresh`: 19 passed. RN `host-node-request.spec`: 32 passed.
- Typecheck is clean for cadre-core, integration-tests and reference-app-rn. cadre-core was rebuilt (`dist` carries the new return type). The root `yarn lint` is clean.
- **Not run:** the full cadre-core suite, and the full integration suite.
- Logs are in `tickets/.logs/b2c-gate-edge{1..9}.log` and `b2c-gate-iso{1..3}.log`.

Commands, from `packages/integration-tests`:
- `yarn vitest run src/scenarios/control-cohort-edge-carries-data.integration.ts`
- `yarn vitest run src/scenarios/control-cohort-three-node-isolation.integration.ts`

## Known gaps / things to look at hard

- **Residual race in `openingPass`** (a `NOTE:` on `DialsToC.openingPass`). Another subsystem's dial to C can start inside the pass *after* the pass lists its live connections and *before* the pass dials C. libp2p then hands the pass's dial that connection, or joins the in-flight dial, and the pass reports C, so the check passes falsely. This needs a millisecond-wide overlap and was not observed.
- **Isolation case 1 replaces a method on a production object instance.** An alternative is to open the gate permanently in that case. That is simpler, but the case would then only prove "B ends up connected to C", not "a reconcile timer pass dialled C". The reviewer should decide whether the patch is acceptable.
- **Public API change in cadre-core.** The return type changed only so these tests can check it. It is small and documented, and the unit tests are tighter for it, but it is still a production-surface change made for a test.
- The pre-sever `:217` arm from the original ticket was not reproduced. The gate covers it by construction, since every B→C dial before step 6 is denied.
- cadre-core passes `network.connectionGater` to strand nodes too, so `gateB` also gates B's strand networks. B runs no strands in these scenarios, so this has no effect here.
- `tickets/.pre-existing-known.md`'s 2026-09-16 delta names this ticket as the tracker for the failures "B held a connection the test forbids". That line can be retired once this completes.

## Review findings

Reviewed the implement diff (`ce6cb21`) before the handoff.

**Checked, no change needed**
- Correctness of `reconcileControlCohort`'s new result: every early return gives `{ dialed: [] }`, the dial loop and cold-start branch report only dials that resolved, and the single-flight joiner returns the in-flight promise's value. The type change reaches every caller: the RN interface is widened, the RN spec's fake `Promise<void>` still fits, and the other integration scenarios discard the value.
- Isolation case 1's instance patch (`B.reconcileControlCohort = () => dialsToC.reconcile()`) works because both the start pass and the `startRecordRefresh` triggers call `this.reconcileControlCohort()` at call time (`cadre-node.ts` ~2112, ~2357), and `dialsToCFor` binds the original method before the patch, so the patch cannot recurse. Accepted: it is an ordinary test spy on a test-owned node. Opening the gate permanently instead would stop the case from proving that a timer pass made the dial.
- Gate coverage: an address dial with no `/p2p/` component passes `denyDialMultiaddr` but is caught by `denyOutboundConnection` once the remote peer is known. An in-flight foreign dial that finishes after the gate closes is caught at the upgrader. `allowDuring`'s depth counter handles overlapping timer and `self:peer:update` passes.
- `openingPass` logic: a pass whose connection C's membership gate later refuses leaves a stale snapshot id that never matches a current connection, so a later pass is picked correctly.
- The public API change (`ControlCohortReconcileResult`) is small, documented, and makes the unit tests stricter. Accepted.
- Docs: the `docs/architecture.md` control-cohort bullet matches the new behaviour. `docs/testing.md` only names the scenarios, so it needed no change.
- Resource cleanup: the gate holds only two small maps per trio, and stop behaviour is unchanged.

**Fixed inline (minor)**
- `cadre-node-control-cohort.spec.ts`, "abandons the pass mid-loop when the node stops" (cold-start): now asserts `{ dialed: [first] }`. The handoff claimed that a stop mid-loop returns the dials made so far, but no test covered it.
- `tickets/.pre-existing-known.md`: marked the "B held a connection the test forbids" class resolved by this ticket, in both the 2026-09-16 delta and the edge-scenario entry, as the handoff asked.

**Tripwires (already parked by the implementer; not re-filed)**
- The residual race in which a foreign dial lands between the pass's connection snapshot and its own dial is recorded as a `NOTE:` on `DialsToC.openingPass`.
- Small window, noted and not changed: each scenario runs `openingPass()` again in an `expect` after its poll, so a connection that C's membership gate closes in between would fail with an unclear `undefined`. The same window already existed for isolation case 2's `expect(hasOutboundTo(...)).toBe(true)`, and no run has hit it.

**Major findings:** none. No new tickets filed.

**Validation (review pass)**
- Root `yarn lint`: clean. integration-tests `tsc --noEmit`: clean.
- `cadre-node-control-cohort.spec.ts`: 54 passed.
- `control-cohort-three-node-isolation` and `control-cohort-edge-carries-data` together, 1 run: 3 of 3 tests passed (log `tickets/.logs/b2c-gate-review.log`).
- Not run: the full cadre-core suite and the full integration suite, as in implement.
