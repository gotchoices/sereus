description: Finish the code-review pass on the change that makes the shared party database copy data to every machine in the party. The assumptions behind it have been checked and hold; what remains is running lint and tests, four small documentation corrections, and filing two follow-up items.
prereq:
files: packages/quereus-plugin-sereus/src/cluster-size.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/test/cadre-node-control-replication.spec.ts, packages/integration-tests/src/harness/test-party.ts, docs/architecture.md, docs/cadre-consistency.md, tickets/blocked/replication-breadth-two-signoff.md
difficulty: medium
----

# Review (continued): control database replicates to the whole party

A prior review run read the full implement diff (`e3a41af` + `5ed6378`) and verified the upstream
Optimystic claims the design rests on. It hit the token budget before running lint/tests or applying
its findings. **Everything below is already established — do not re-derive it.** The earlier
handoff's own "what a reviewer should attack" list is superseded by the Verified section; read this
file, not that one, for those five points.

## Verified against `../optimystic` source (every claim in the diff holds)

Checked 2026-07-29. Each line names the file so a re-check is cheap.

- **A cohort is capped at real serving peers and downsized when unfillable — so 16 really is harmless
  headroom.** `db-p2p/src/libp2p-key-network.ts:618` — `nonSelfTarget = Math.max(0, clusterSize - 1)`,
  then `serves.slice(0, nonSelfTarget)` plus self. `libp2p-node-base.ts:721` defaults
  `allowClusterDownsize` to true and Cadre passes it explicitly. The doc comment is accurate.
- **`assumedClusterSize` really does default to 2.** `ClusterMember` itself has no default
  (`cluster-repo.ts:263` is a bare `consensusConfig?.assumedClusterSize`), but the node factory
  supplies one: `libp2p-node-base.ts:716,737` — `minAbsoluteClusterSize = 2` and
  `assumedClusterSize: options.clusterPolicy?.assumedClusterSize ?? minAbsoluteClusterSize`. So every
  comment and doc line saying "Optimystic's default of 2" is correct, and the new unit test's
  `toBeUndefined()` assertion means what it claims to mean.
- **Raising `clusterSize` to 16 cannot reintroduce `MEMBERSHIP_NOT_ADMITTED`.**
  `cluster-repo.ts:916-948` — the low-confidence path measures the declared set against
  `admissionFloor(assumedClusterSize)` = `max(2, ceil(0.75 x 2))` = 2, never against `clusterSize`;
  the confident path measures against the member's own derived `kEst`, itself bounded by real peers.
  `ceil(0.75 x 16) = 12` is the right arithmetic for the hypothetical the comment warns off.
- **No read-repair deadlock from the wider cohort.** `CoordinatorRepo` receives
  `{...consensusConfig}` (`libp2p-node-base.ts:823-829`), so its
  `assumedClusterSize = policy.assumedClusterSize ?? policy.clusterSize` (`coordinator-repo.ts:207`)
  resolves to **2**, not 16. Had it resolved to 16, `corroboratorCapacity(1, 16) = 15` would have put
  a two-corroborator floor on a two-node party that can only ever supply one responder — permanently
  dead read repair. It does not. Safe.
- **Churn/re-replication work does not scale with 16.** `network/network-manager-service.ts:324,351`
  cap the target at the FRET network-size estimate and at the candidate count respectively.
- **The `membershipOverfetch` tripwire is accurately scoped.** `libp2p-key-network.ts:757-758` —
  `max(clusterSize * 4, clusterSize + 16)`, so 64 candidates at breadth 16.
- **Enterprise deployment is 7 nodes**, so "16 is roughly twice the largest documented deployment"
  checks out (`docs/architecture.md:752-754` — phone + laptop + 3 cloud + 2 NAS).
- **The `strandClusterSize` rename has no loose-config escape hatch.** The only `CadreNodeConfig`
  construction sites outside cadre-core are `cadre-cli/src/commands/start.ts:153` and
  `strands.ts:49`, both `const nodeConfig: CadreNodeConfig = { ... }` — annotated, so the compiler
  catches a stale `clusterSize` key. No JSON / `Record` / spread path builds one; cadre-host and
  cadre-provider never construct one. Nothing left to grep.
- **No stale references to the removed names** anywhere in `packages/` or `docs/` — only historical
  prose in `tickets/complete/`, which is correct as a record.

## Findings to apply in this pass (all minor — fix, do not file)

**1. `docs/cadre-consistency.md:24` overstates the fix.** "Replicating to everyone removes the need
for read repair on the control path entirely" is false: a member *offline at write time* is not in
the cohort (`findCluster` admits only positively-serving peers), so it still catches up by read
repair, or by the write-while-alone re-replication queue in `cadre-node.ts`. Soften to the *routine*
dependence being removed, and name the two catch-up paths that remain.

**2. The docs describe `assumedClusterSize` only as the admission gate's yardstick; it is also the
read-repair corroboration floor's input.** Affected: `docs/cadre-consistency.md:28`,
`docs/architecture.md:63`, and the "Deliberately not `clusterPolicy.assumedClusterSize`" paragraph in
`cluster-size.ts`. `libp2p-node-base.ts:731-737` says it is read by the admission gate's fallback
path *and* by the read-repair/reconcile corroboration floor **unconditionally**. Since read repair is
the entire mechanism this change exists to route around, that second consumer belongs in the
sentence. One clause each — do not restate the analysis three times (see finding 4).

**3. The change also *strengthens* read repair on the control path — undocumented, and the more
interesting half of the result.** `corroboratorCapacity(cohortPeerCount, assumedClusterSize) =
max(cohortPeerCount, assumedClusterSize - 1)` (`quorum-restore.ts:91`), and `cohortPeerCount` is now
the whole party rather than one peer. In a party of three or more the capacity rises from 1 to N-1,
so the corroboration floor rises from 1 to `CORROBORATION_FLOOR` (2) and a lone stale — or lying —
peer can no longer be accepted as the cluster's truth. `selectQuorumRev` then takes the *highest*
corroborated revision, so repair genuinely converges. Two consequences, a sentence each, in
`docs/cadre-consistency.md`'s shipped-behaviour section:
- It retires the control-path half of `backlog/debt-read-repair-single-voter-corroboration` as a side
  effect. Read that ticket and narrow its scope to strand data if that is now its only remaining
  exposure — do not close it blind.
- The narrow flip side: in a party of three where two members were offline for a write, the returning
  majority sees only one peer holding the new revision, now *below* the floor of 2 where it used to
  sit at a floor of 1. The write-while-alone re-replication queue (`cadre-node.ts:1788`
  `drainControlReReplication`, fires on the 0→≥1 connection edge) is the backstop. Say so, so a
  future reader does not read the floor rise as unambiguously free.

**4. Source hygiene: the same reasoning is written out at length in three places.** The
`CONTROL_REPLICATION_BREADTH` docblock (~40 lines of `cluster-size.ts`'s 101),
`docs/architecture.md` § "Replication cluster size", and `docs/cadre-consistency.md`'s new section
each independently explain the read-repair-cannot-converge argument. Three copies to keep in sync —
and findings 1-3 have to be applied to all three, which is that cost showing up already. Make
`docs/architecture.md` the canonical explanation; trim the other two to the decision plus a link.
Move the mechanism detail, do not delete it.

## Findings to file as new tickets (major — not fixable in a review pass)

**A. `backlog/debt-` — nothing covers write availability with a degraded-but-connected cohort
member.** This is the cost side of the whole change and is untested. A member that is *connected but
slow or flaky* sits inside the cohort and counts against the super-majority, where at breadth 2 it
would have been outside the cohort and ignored. Distinct from
`debt-control-db-offline-peer-no-hang-coverage`, which covers *unreachable* peers (those never enter
the cohort at all, and the write commits self-only under `allowDownsize`) — say so in the ticket so
the two are not merged. Also distinct from `control-cohort-three-node-reconcile-isolation-test`,
which is about dial formation.

**B. `backlog/debt-` — the integration harness is more permissive than production about commit
approval.** `packages/integration-tests/src/harness/test-party.ts:57` sets
`clusterPolicy.superMajorityThreshold: 0.51`; `CadreNode` leaves Optimystic's default of `0.75`. In a
three-node cohort that is 2-of-3 in the harness versus 3-of-3 in production, so a commit-availability
regression can pass CI and fail in a real party — exactly the risk finding A describes.
Pre-existing, but the whole-party cohort is what makes it bite. The implement pass parked it as a
`NOTE:` at the override site and explicitly deferred the ticket-or-comment call to review: **file
it**, and leave the `NOTE:` in place pointing at the new ticket.

## Also needs updating (not a code finding)

`tickets/blocked/replication-breadth-two-signoff.md` is now **stale and would mislead the human it is
waiting on.** It asks "is two copies the right default?" and describes the setting as one number
governing everything. No longer true: the control database now replicates to the whole party, so the
open question is strand data only. Rewrite its `description:` and body to scope it to strand data and
reference `backlog/debt-strand-replication-breadth-ignores-party-count`. Leave it in `blocked/` — it
is still a human decision, just a narrower one.

## Not yet run — required before this ticket moves to `complete/`

None of this was reached. The previous ticket's own run was clean, but that was before the doc edits
above.

- `yarn lint` (root)
- `yarn typecheck` (root)
- `packages/cadre-core` and `packages/quereus-plugin-sereus` unit suites
- One `packages/integration-tests` run. Expect exactly one failure:
  `push-wake-e2e.integration.ts > ... > delivers a wake to a NAT'd receiver over a circuit-relay
  (signaling-first) dial`, already listed in `tickets/.pre-existing-known.md` against
  `fix/bug-strand-node-relay-reservation-denied-by-membership-gate`. Do not re-report it.
- **Rebuild `../quereus` and `../optimystic` first, and watch for `Stale build detected` aborts** — a
  concurrent editor in the sibling `../quereus` checkout corrupted a 20-run measurement during the
  validation pass. A bare exit code conflates a stale-build abort with a test failure.

## Checked and found nothing

- The eight upstream Optimystic assumptions above — none wrong.
- The `strandClusterSize` rename's blast radius — fully typed, no loose config path.
- Leftover references to `DEFAULT_CLUSTER_SIZE` / `resolveClusterSize` in shipping code — none.
- `docs/STATUS.md` — its cluster-size mention (`STATUS.md:669`) is historical narrative about an
  already-fixed optimystic selection-layer bug and remains accurate. No edit needed.
- The shipped-vs-speculative fencing in `docs/cadre-consistency.md` (the earlier handoff's main
  worry) — the blockquote at line 18 plus the status-line pointer at line 3 read clearly. No change
  needed beyond findings 1-4.

## Deliberately out of scope

`backlog/debt-strand-replication-breadth-ignores-party-count` (the strand path's own breadth
question), and the control commit sweep's non-atomicity across trees.
