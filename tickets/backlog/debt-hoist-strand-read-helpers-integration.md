description: Three of the network test files that read a strand's membership tables each keep their own copy of the same small set of read helpers, and the copies have already started to drift apart; give them one shared home.
files: packages/integration-tests/src/scenarios/strand-membership-closed-strand-e2e.integration.ts, packages/integration-tests/src/scenarios/strand-membership-second-machine.integration.ts, packages/integration-tests/src/scenarios/harness-topology.integration.ts, packages/integration-tests/src/scenarios/strand-removal-cuts-network.integration.ts, packages/integration-tests/src/scenarios/strand-two-party-two-machine.integration.ts, packages/integration-tests/src/scenarios/strand-party-removal-via-formation-e2e.integration.ts, packages/integration-tests/src/harness/index.ts
difficulty: easy
tradeoffs: Test-local duplication is cheap to read and impossible to break for anyone else, and a shared module in `src/harness/` is one more thing a scenario author has to know about — a maintainer may reasonably decide three copies of six short functions is under the threshold that justifies the indirection.
----

# One home for the `Strand.*` scan-and-filter read helpers

## The duplication, measured

`strand-membership-closed-strand-e2e.integration.ts` closes its "seal" section (line 1595)
with an explicit instruction:

> NOTE: these two tests share ~400 lines of private harness with the seven above
> (`bringUpClosedStrand`, `stopBoth`, `freshKeyPair`, `GATE`, the `scanColumn` family).
> They live here rather than in a sibling file for exactly that reason. If a THIRD
> scenario ever needs this harness, hoist it into `src/harness/` rather than duplicating
> it — a hoist is a refactor across nine passing network tests and wants its own ticket.

The third scenario has now arrived. `strand-membership-second-machine.integration.ts`
(landed 2026-09-08, `d96cf7a`) copied the `scanColumn` family across rather than hoisting it,
and `harness-topology.integration.ts` already carried a fourth shape of one of them.

Counted 2026-09-08 with
`grep -n "^function freshKeyPair\|^async function strandCount\|^async function scanColumn\|^async function memberKeys\|^async function inviteKeys\|^async function managerKeys\|^async function managerGeneration\|^type StrandTable" packages/integration-tests/src/scenarios/*.integration.ts`:

| helper | copies | where |
| --- | --- | --- |
| `freshKeyPair` | 2 | closed-strand-e2e:177, second-machine:93 |
| `type StrandTable` | 2 | closed-strand-e2e:184, second-machine:100 |
| `strandCount` | 3 | closed-strand-e2e:187, second-machine:103, harness-topology:56 |
| `scanColumn` | 2 | closed-strand-e2e:228, second-machine:110 |
| `memberKeys` / `inviteKeys` / `managerKeys` | 2 each | closed-strand-e2e:237/242/247, second-machine:119/124/129 |
| `managerGeneration` | 2 | closed-strand-e2e:269, second-machine:142 |

## The drift is already here

This is not three byte-identical copies waiting to be deduplicated. They have diverged in
three ways, on their first day:

- **`StrandTable` is a different type in each file.** The e2e's union carries `MemberPeer`;
  the second-machine copy does not, because that file happens not to count that table. A
  shared type would say what the strand schema has, not what one file used.
- **`strandCount` has three signatures.** Two take the named union; `harness-topology`'s
  inlines a narrower `'Header' | 'Member' | 'Manager'` literal at the parameter.
- **`managerGeneration` has two implementations.** The e2e routes through a `managerRow`
  helper that reads every column its callers need in ONE scan — deliberately, because the
  storage layer never promises two separate scans return rows in the same order. The
  second-machine copy re-implements the scan inline, reading two columns. The bodies agree
  today; the *reason* the e2e's shape exists did not travel with the copy.

That third point is the cost this ticket is really about. Each copy carries a long comment
explaining the scan-not-seek discipline (a where-equality on a full primary key is served by
the optimystic module as a point lookup that can MISS on a networked strand — see
`debt-composite-pk-point-lookup-unreliable-untracked`). A reader who meets one copy has no
way to know whether the others still agree with it, and a fix to the discipline has to be
found in three places.

## Expected end state

One module under `packages/integration-tests/src/harness/` exporting the read helpers and the
`StrandTable` union, re-exported from `harness/index.ts` like every other harness module, with
the scan-not-seek rationale stated ONCE on the shared `scanColumn`. All three scenario files
import it; no local copies left. Helper bodies do not change behaviour, only location, so any
test that flips is a real regression.

## Scope notes

- The e2e's `bringUpClosedStrand` / `stopBoth` bring-up harness is **not** part of this: it is
  two-node-specific and no other file wants it. Only the stateless read helpers move.
- The e2e's `memberPeerStamp`, `revocationExists`, `managerRow` and `managerStamp` have one
  caller each today. Move them with the family or leave them — either is defensible; say which
  in the implementation, and do not leave a file importing half its helpers and defining the
  other half.
- `SIMPLE_SCHEMA` (the one-table key/value sApp) has nine copies across the scenario directory
  and is a much older, wider pattern than this one. Deliberately out of scope — folding it in
  would turn a contained move into a sweep of nine files.
- `debt-hoist-strand-tombstone-helpers` is the same shaped problem in `packages/cadre-core/test`,
  and explicitly declares the `integration-tests` copies out of its scope. The two do not
  overlap and neither blocks the other.

## Second arm: the relay-path assertion helpers (added 2026-09-10)

The `blind-relay-phone-to-phone-e2e` review found the same class in a second family, and
the drift arrived with the copy, exactly as above. Counted 2026-09-10 with
`grep -ln "function expectAllPathsRelayed\|async function readDataRows" packages/integration-tests/src/scenarios/*.ts`:

| helper | copies | where |
| --- | --- | --- |
| `expectAllPathsRelayed` | 2 | `strand-circuit-same-party-e2e.integration.ts:99`, `blind-relay-phone-to-phone-e2e.integration.ts:124` |
| `readDataRows` | 5 | `blind-relay-phone-to-phone-e2e`, `strand-circuit-same-party-e2e`, `harness-topology`, `strand-late-cadre-join`, `strand-two-party-two-machine` |
| `isCircuit` / `GATE` | 2 each | the two relay scenarios |

The drift: the newer `expectAllPathsRelayed` additionally asserts `conn.limits` is
`undefined` — the live half of the dedicated relay fixture's `applyDefaultLimit: false`
parity contract with `ops/docker/libp2p-infra`. The older copy does not, so the same-party
relay scenario would not name that regression if it happened; it would only time out on
replication. Hoisting must keep the stronger body (the limits check holds for both, since
both use the same ungated fixture).

Why this was NOT fixed inline at review time: every module under
`packages/integration-tests/src/harness/` deliberately avoids importing `vitest` and
throws plain `Error`s instead (stated at `harness/control-trio.ts:37`). Hoisting an
`expect`-based assertion helper therefore needs a decision — either import `vitest` into
one harness module and say why, or restate these as throwing helpers and accept the loss
of vitest's assertion diffs. That decision belongs to this ticket, not to a review pass on
an unrelated scenario.

`SIMPLE_SCHEMA` (now twelve copies) stays out of scope for the same reason given above.

## Third arm: the removal scenario adds a fourth copy (added 2026-09-10)

`strand-removal-cuts-network.integration.ts` landed 2026-09-10 (`e01a2ca`) and, like the
second-machine file before it, copied the family rather than hoisting it. Counted
2026-09-10 with `grep -ln "<name>" packages/integration-tests/src/scenarios/*.ts`:

| helper | copies now | added by this file |
| --- | --- | --- |
| `freshKeyPair` | 3 | yes (closed-strand-e2e, second-machine, removal-cuts-network) |
| `memberKeys` | 3 | yes |
| `GATE` | 5 | yes |
| `insertWithRetry` (+ its read-back branch) | 2 | yes (with `strand-two-party-two-machine`) |
| `SIMPLE_SCHEMA` | 13 | yes (still out of scope, per above) |

Drift arrived with this copy too, in the same shape as the second arm's: the 2×2 file's
`insertWithRetry` reads back through a named `rowLanded` helper that LOGS a failed
read-back; the removal file's copy originally inlined `.catch(() => undefined)`, silently
swallowing it. Fixed at review time in the new file (it now has its own `rowLanded`), which
makes the two bodies agree again — and makes the case for one home rather than two agreeing
copies. The removal file's `insertWithRetry` also documents a DIFFERENT reason for
retrying (a post-removal cohort downsize, measured) than the 2×2's (an upstream
lost-conflict race), so a hoist has to keep both rationales, not pick one.

Also note for whoever does the hoist: `expectConnected` / `expectCut` /
`expectNeverConverges` in the removal file are `expect`-based like the second arm's
helpers, so they hit the same "harness modules do not import vitest" decision recorded
there.

## Fourth arm: the formation-removal scenario adds a fifth copy (added 2026-09-10)

`strand-party-removal-via-formation-e2e.integration.ts` landed 2026-09-10 and copied the family again rather than hoisting it — deliberately, because the hoist is a refactor across six passing network files and is this ticket's job, not that ticket's. Counted 2026-09-10 with `grep -c` over `packages/integration-tests/src/scenarios/*.integration.ts`:

| helper | copies now | added by this file |
| --- | --- | --- |
| `memberKeys` | 4 | yes |
| `GATE` | 6 | yes |
| `expectConnected` / `expectCut` / `expectNeverConverges` | 2 each | yes (with `strand-removal-cuts-network`) |
| `insertWithRetry` (+ `rowLanded`) | 3 | yes |
| `dataValue` / `awaitRowVisible` | 2 | yes |
| `SIMPLE_SCHEMA` | 14 | yes (still out of scope, per above) |

No drift this time: the bodies were copied from `strand-removal-cuts-network` unchanged, and the two files' `insertWithRetry` rationales are now the same one (a post-removal cohort downsize), so the hoist has three rationales to keep, not two. One genuinely NEW helper arrived with this file and is a candidate to move with the family: `memberPeerBindings` (scans `Strand.MemberPeer` and returns `MemberKey|PeerId` pairs, rather than the removal file's peer-ids-only `memberPeerIds` — the pairing is what a per-party binding claim needs). Prefer the pair-returning shape when hoisting; `memberPeerIds` is derivable from it, not the other way round.
