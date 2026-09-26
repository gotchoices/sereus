description: When a machine checks with the others in its group before reading, it used to give each one a second to answer, which is not enough for two phones talking through a relay; it now gives five, and a host can change that.
architecture: docs/architecture.md#replication-cluster-size
files:
  - packages/quereus-plugin-sereus/src/cluster-size.ts (COHORT_READ_DEADLINE_MS added; both frozen policies declare it; both builders gained a third/second optional argument)
  - packages/quereus-plugin-sereus/src/index.ts (export)
  - packages/quereus-plugin-sereus/src/compose-strand.ts (one NOTE at the plugin's own createNode call)
  - packages/cadre-core/src/types.ts (NetworkConfig.cohortQueryTimeoutMs; the re-export block)
  - packages/cadre-core/src/cadre-node.ts (buildControlNodeOptions, ~line 1669)
  - packages/cadre-core/src/strand-instance-manager.ts (buildStrandRuntime, ~line 690)
  - packages/cadre-core/src/strand-network-config.ts (inherited-fields list)
  - packages/cadre-core/src/strand-first-sync-gate.ts (the first-sync band comment now names which deadline is in force)
  - packages/cadre-core/test/cadre-node-control-node-options.spec.ts (4 tests added)
  - packages/cadre-core/test/strand-instance-manager-cluster-size.spec.ts (2 tests added, 1 extended)
  - docs/architecture.md ("CadreNode Configuration" network block; the companion-policy bullet under "Replication cluster size")
  - docs/testing.md ("Where measurements live")
  - .release-notes.pending.md
----

# Cohort read deadline declared at 5000 ms on both networks, with a host override

## What this is

Before serving a read whose local copy may be stale, an Optimystic node asks the block's cohort which revision is newest and believes an answer only if it arrives inside a per-peer deadline. Optimystic 1.6.0 made that deadline configurable as `clusterPolicy.cohortQueryTimeoutMs` and deliberately left its default at 1000 ms — a LAN budget, shorter than one round trip between two phones that reach each other only through a relay. Sereus declared nothing, so both of its networks ran at 1000 ms; at a cohort of two there is exactly one peer to ask, so one late answer left the read with nothing to corroborate against and it was declined and retried.

Both policies now declare `COHORT_READ_DEADLINE_MS` (5000 ms), and a host can move both at once with `NetworkConfig.cohortQueryTimeoutMs`.

Upstream context: Optimystic GitHub #22, reported by a sereus-based chat app.

## What changed

**One shared constant, declared in both frozen policies.** `COHORT_READ_DEADLINE_MS = 5000` sits beside `MIN_CLUSTER_SIZE` in `cluster-size.ts`, and both `CONTROL_CLUSTER_POLICY` and `STRAND_CLUSTER_POLICY` carry `cohortQueryTimeoutMs: COHORT_READ_DEADLINE_MS`. The two policy objects stay separate as they were; this is the one field they agree on by argument rather than by coincidence, because the reason to widen it is a property of the link and a phone's control node and its strand nodes ride the same link. The constant's doc comment holds the measurement, the decline counts, the cost, and why 3000 is the fallback.

**One optional argument per builder.** `controlClusterPolicy(enrolledMachines?, cohortQueryTimeoutMs?)` and `strandClusterPolicy(clusterSize, servingMachines?, cohortQueryTimeoutMs?)`. Each returns the frozen base object **by identity** when neither the count nor the deadline is given, which is the production path today and what the existing identity assertions require; a value present on either makes a fresh frozen object, and the two spreads are independent so neither declaration can shadow the other.

**No second validation.** A host value that is not a finite number above zero, or is above Optimystic's `MAX_COHORT_QUERY_TIMEOUT_MS`, is passed straight through and throws where the libp2p node is constructed — inside `CadreNode.start()` for the control network, inside `addStrand` for a strand. The `NetworkConfig` field's doc says exactly that, so an embedder knows where the throw comes from.

**Threading.** `network?.cohortQueryTimeoutMs` at `buildControlNodeOptions`, `config.network?.cohortQueryTimeoutMs` at `buildStrandRuntime`. `CadreNode.addStrand` already passes `network: this.config.network` into `startStrand` and `resumeStrand` already retains it, so one field reaches both networks and survives a hibernation wake with no new plumbing.

## Use cases to check

**A host that configures nothing.** Both networks run at 5000 ms and both get the frozen constant by object identity. This is the path every existing test and every deployment takes; the identity is what makes it provable rather than asserted by shape.

**A host that sets `network: {}`** (transports or relays configured, no deadline). `config.network?.cohortQueryTimeoutMs` is then `undefined` because the key is absent, not because the host asked for the default — and it must still read as "asked for nothing", or every identity assertion breaks on every configured node. Pinned on both networks.

**A host that sets `network: { cohortQueryTimeoutMs: N }`.** N reaches both networks' `clusterPolicy`, replacing the declared 5000. The repair yardstick stays undeclared — a deadline is not a machine count.

**A control node with both a recorded machine count and a host deadline.** The one path where both conditional spreads run. Pinned: 5 and 12000 both land.

**A degenerate host value** (`0`, `NaN`, `1e12`). Deliberately not caught here; Optimystic throws at node construction. Not tested — see the gaps below.

**Anything that reads a stale block over a slow link.** A rejoining machine reading a row written while it was away is the reported shape; the declined-read count is what moves.

## Tests

| Test | What it verifies |
| --- | --- |
| `cadre-node-control-node-options.spec.ts` → "declares the cohort read deadline rather than taking Optimystic's LAN default" | The control node's policy carries `COHORT_READ_DEADLINE_MS`, and that the constant is above Optimystic's 1000 — the assertion that catches the whole change being reverted or the constant being "tidied" back to the upstream default. |
| same file → "lets a host replace the cohort read deadline for the control network" | `network.cohortQueryTimeoutMs` reaches `clusterPolicy`; the repair yardstick stays undeclared and `assumedClusterSize` stays 2; the result is not the frozen constant. |
| same file → "keeps the frozen policy by identity when a network block declares no deadline" | Present-but-undefined reads as "asked for nothing" on the control network. |
| same file → "declares a recorded count and a host deadline together" | Both conditional spreads run without shadowing each other. |
| `strand-instance-manager-cluster-size.spec.ts` → the existing shape test, extended by two lines | `STRAND_CLUSTER_POLICY.cohortQueryTimeoutMs` is the constant, and the constant exceeds 1000. |
| same file → "still passes STRAND_CLUSTER_POLICY BY IDENTITY when the network block declares no deadline" | The same present-but-undefined case on the strand path. |
| same file → "forwards a host cohortQueryTimeoutMs, replacing the declared deadline on the strand node" | The override reaches `createLibp2pNode`, deep-equal against the builder's own output so the absent yardstick is pinned in the same assertion. |

Six new tests plus one extended. **No integration scenario was added, deliberately** — see below.

## Known gaps, for the review pass

- **The decline-count measurement was not re-taken in this run.** 18 declines at 1000 ms and 2 at 5000 ms come from the reproduction pass of the `fix/` ticket that preceded this one (2026-09-26, same day, one Windows machine, blind-relay topology with the one-way delay raised to 900 ms after formation). Those logs were written to `tickets/.logs/` and are pruned on the usual schedule; the numbers in `COHORT_READ_DEADLINE_MS`'s comment are now the record. Nothing in this ticket re-verified them, and no committed instrument can — see the next point.
- **No committed scenario gates this, by design, and that decision is worth re-testing.** The journey passes at both 1000 ms and 5000 ms at 900 ms one-way delay, so a scenario there would gate nothing; above it a run breaks on redialling instead (`fix/strand-node-never-redials-through-a-relay-at-a-three-second-round-trip`). What moves at 900 ms is a count of debug log lines, not a pass/fail. The recipe and the shape to build are recorded in `docs/testing.md` → "Where measurements live" so the instrument is not rebuilt from scratch a fourth time. If the reviewer sees a way to make this assertable that the implement pass missed, that is the highest-value finding available here.
- **Every integration scenario now runs at 5000 ms**, because the harness's `test-party.ts` passes `CONTROL_CLUSTER_POLICY` directly and the plugin's e2e mesh passes `STRAND_CLUSTER_POLICY`. Three of the most exposed were run and pass (below); the rest of the suite was not, on wall-clock grounds. The scenarios worth a second look are any that assert a *duration* against a deliberately silent-but-connected peer, since a consult against one now costs 5 s rather than 1 s.
- **Nothing in this repository sets the new field.** `NetworkConfig.cohortQueryTimeoutMs` is covered by unit tests only; no reference app and no scenario exercises it end to end. That is the intended shape (it exists for an embedder), but it means the threading is proven by mock assertions rather than by a running node.
- **The degenerate-value path is untested.** Passing `0` or `NaN` through to Optimystic's throw is a deliberate non-behaviour, so no test pins it; a future reader who adds a check here would break the `NetworkConfig` doc's promise about where the throw comes from without failing anything. The reviewer may judge that worth one test.
- **The SQL plugin's own connect path has no override.** `compose-strand.ts` passes the frozen `STRAND_CLUSTER_POLICY`, so `StrandConnectionOptions` has no counterpart to `NetworkConfig.cohortQueryTimeoutMs`. Parked as a `NOTE:` at that call site rather than filed — every production strand comes up through cadre-core, which does thread the field.

## Tripwires parked (not tickets)

- **`NOTE:` at `COHORT_READ_DEADLINE_MS`** — this number and the 120 s first-sync budget are coupled, with about 2.6x margin today. If the deadline is raised again, or a deployment's first sync grows more collections than the two-table scenario measured, re-measure the first-sync band first. Nothing warns when the margin goes; the symptom is `StrandAwaitingFirstSyncError` on a join that was progressing normally — the very failure the upstream report named.
- **`NOTE:` at `compose-strand.ts`'s `createNode` call** — the plugin's own connect path takes the deadline with no override, and the call to reach for if an embedder ever needs one.

## One correction to the source ticket

The source ticket asked for the first-sync band (23-41 s at 1000 ms, 35-46 s at 5000 ms) to be recorded at the new constant. It was not duplicated there: the review of `1-first-sync-wait-too-tight-on-a-slow-relayed-link` had just cut three copies of that band down to one, on `DEFAULT_STRAND_FIRST_SYNC_TIMEOUT_MS`. The new constant states the cost and points at that single copy; the gate's own comment, which recorded the 5000 ms band as a hypothetical, now says which of the two bands is in force and that 120 s clears it by about 2.6x. The decline counts, which live nowhere else, are stated at the new constant.

## What was run

- `yarn lint` — exit 0.
- `yarn typecheck` (all workspaces, plus the three coverage checks) — exit 0.
- `yarn workspace @serfab/quereus-plugin-sereus build` / `typecheck` / `test` — 10 files, 113 passed, 1 todo.
- `yarn workspace @serfab/cadre-core build` — exit 0.
- `yarn workspace @serfab/cadre-core test` — 139 files, 2280 passed, 1 skipped (2274 before; 6 new).
- `yarn workspace @serfab/integration-tests exec vitest run control-write-degraded-cohort-member blind-relay-phone-to-phone-e2e strand-chat-participants-converge` — 3 files, 12 passed, 265 s. Chosen as the three most exposed to a wider read deadline: a deliberately silent cohort member, the relay-only two-party shape closest to the reported failure, and the arm whose joiner has no reachable host. Durations for comparison: the unreachable-joiner arm 10.6 s, the blind-relay loopback arm 3.4 s, its 10 ms arm 6.6 s. No pre-existing failure surfaced, so `tickets/.pre-existing-error.md` was not written.

The rest of the integration suite was not run — it is the slow set, and its wall clock puts it outside what a ticket run should attempt.

## Do

- Read the diff before this summary.
- Judge the no-test decision on the integration side, which is the one real judgement call in the change.
- Check the two `NOTE:`s say enough for the reader who meets them.
