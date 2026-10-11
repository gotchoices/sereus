description: A running strand node now redials the strand's other members itself whenever it is connected to none of them, giving each dial the time a relayed connection needs on the host's declared link, so two phones that restart on a slow relayed link reconnect and a change saved before the restart reaches the other side.
architecture: docs/strands.md#joining-no-writes-before-the-first-sync
files: packages/cadre-core/src/strand-peer-redial.ts, packages/cadre-core/src/strand-fret-addrs.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/test/strand-peer-redial.spec.ts, packages/cadre-core/test/fret-record-helpers.ts, packages/integration-tests/src/scenarios/joiner-first-commit-over-slow-relay.integration.ts, docs/architecture.md, docs/strands.md, docs/testing.md
----
# Strand peers redial on the declared link budget

## What was built

After a restart, the only thing that redialed another member's strand node was FRET's maintenance traffic, which allows 2 000 ms per call with the connection opening included. A relayed dial on a slow link needs longer (about 9 s on a 20 ms frame cap with a 70%-busy event loop), so two restarted relay-only phones never reconnected and a write made alone before the restart never reached the other side (gotchoices/sereus#44). The upstream half stays `blocked/fret-maintenance-ping-dial-budget-below-a-relayed-dial`.

`packages/cadre-core/src/strand-peer-redial.ts` runs one loop per strand runtime. `StrandInstanceManager.buildStrandRuntime` starts it right after the relay supervisors, and `releaseRuntime` stops it. While the strand node is connected to no member, the loop dials every member it knows at once. Each address gets `relayedDialBudgetMs` (21.5 s at the default declared link). A round that reaches nobody waits a backoff that starts at that budget and doubles up to 5 minutes. A disconnect ends a normal wait between checks early, but never ends a backoff early. "Known" means a verified signed record in the FRET table, or the launch seed. Configured relays (excluded by peer id), peers FRET labels `'foreign'` and revoked peers are never dialed and never count as a connected member. `strand-fret-addrs.ts` gained `strandFretMembership`, which reads FRET's labels without verifying signatures. The implement commit is `ticket(implement): strand-peers-redial-on-the-declared-link-budget`.

Proof: the fifth arm of `joiner-first-commit-over-slow-relay` (a restart that stays on the slow link) failed at its 180 s gate before the change and passes after it. `strand-peer-redial.spec.ts` pins whom the loop dials, when it dials nobody, and the backoff.

## Review findings

**Checked:** I read the implement diff in full: the new module, the FRET table reader, the manager wiring and teardown order, the ten fake-node spec edits, the scenario's fifth arm, and the three docs. Things I traced:
- The loop's concurrency. `tick` clears `watching` before its first await, so a disconnect cannot start a second tick. `stop()` during a round discards the result. The failed-build path and a stop during the database phase both stop the loop through `releaseRuntime`.
- Relay exclusion. `strandNodeAddrs` returns relays as direct `<host>/p2p/<relay>` addresses, so `groupAddrsByPeerId` keys them by the relay's peer id and the exclusion holds.
- Error handling. A look that throws is logged and retried after the normal check interval.
- `dialPeerAddrs`, which is async, so a failed member dial reaches `allSettled` as a rejection rather than a synchronous throw.

**Defect found and fixed: a revoked node kept dialing.** After this node's own party was revoked, the loop kept dialing the strand's peers, the launch-seed addresses included. The strand keeps running for the session after a self-revocation, and `CadreNode.forgetRevokedJoin` states the rule this broke: "a removed party must not keep dialing the strand's peers". The implement handoff had listed this as optional. It is a broken contract, so I fixed it: `lookAndDial` now dials nobody while `isRevoked(self)` holds, and dialing resumes on its own if the node is re-admitted. I added one spec case, `dials nobody once its own party is revoked, though it still knows members`, and confirmed it fails when the check is removed. The rule is now in `docs/architecture.md` → "Who it dials and who counts as connected".

**Tripwire parked:** the launch seed is read once, when the runtime is built. Addresses a re-formation carries while the strand runs reach the peerStore but not this loop until the runtime is rebuilt. Recorded as a `NOTE:` on `StrandRedialDeps.seed`. No ticket, because nothing has shown it to matter yet.

**Already parked by the implementer, left as they are:**
- A round that fails within milliseconds still waits a full backoff, which keeps the third scenario arm `it.fails`. `NOTE:` on `nextBackoff`.
- A member that left is redialed every 5 minutes for as long as FRET keeps its record. Stated on `STRAND_REDIAL_MAX_BACKOFF_MS`.

Both are conditional, so a tripwire note is the right home for them.

**Docs:**
- `docs/strands.md` → "Joining: no writes before the first sync" said a write made alone "reaches another member when this machine next connects to one" but did not say what makes that connection happen. It now points to the redial.
- `docs/architecture.md` gained the self-revocation rule.
- `docs/testing.md` already described the fifth arm.

**Tests:**
- The four implementer cases each pin real branching: whom it dials, ineligible peers, the backoff ladder, and a disconnect while watching versus during a backoff. None restates a mock, so I kept them all.
- The fake-node edits in ten specs only add inert members the loop now calls (`getConnections`, `addEventListener`, `removeEventListener`). They are necessary.

**Validation run:**
- `yarn lint`: clean. cadre-core typecheck: clean.
- cadre-core: 162/162 files pass (2431 tests passed, 1 skipped, the skip not from this change).
- After rebuilding cadre-core, the fifth scenario arm (`-t "still on the slow link"`) passes in 96 s, with the rows on the founder 45.7 s after the restart.
- Not re-run: the rest of the integration suite. It is beyond an agent run's wall-clock limit, and the implementer ran the strand scenarios most exposed to this change.

**Nothing filed:** no finding met the filing bar. Each was fixed inline, parked as a tripwire, or already parked.
