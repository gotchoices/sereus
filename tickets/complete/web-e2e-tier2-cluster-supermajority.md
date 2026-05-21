---
description: Threaded a `superMajorityThreshold` knob through the browser `StartNodeOptions` and the `optimystic` `reference-peer` CLI (`interactive`, `service`, `run`). Default in distributed-mode browser → `0.51`; e2e fixture passes `--super-majority-threshold 0.51` to bootstrap + service peers. Added a focused unit test in `@optimystic/db-p2p` that locks the `Math.ceil(peerCount * threshold)` math for the 3-peer / 0.67 vs 0.51 cases. The underlying `cluster-tx:supermajority-failed` bug is fixed; the residual 3-of-16 Tier 2 failures are a *different* timing race (`cluster-tx:consensus-broadcast-error`) and are tracked in the new `fix/web-e2e-tier2-consensus-broadcast-race` ticket.
files: ../optimystic/packages/db-p2p/test/cluster-coordinator-supermajority.spec.ts, ../optimystic/packages/reference-peer/src/cli.ts, ../optimystic/packages/reference-peer/README.md, packages/reference-app-web/src/lib/optimystic.ts, packages/reference-app-web/e2e/fixtures/reference-peer.ts, packages/reference-app-web/README.md
---

## Outcome

- Browser `StartNodeOptions` gains `superMajorityThreshold?: number`,
  defaulting to `0.51` in distributed mode and `undefined` (library
  default `0.67`) in solo mode. Forwarded via
  `clusterPolicy: { superMajorityThreshold }` on the `createLibp2pNode`
  config in `packages/reference-app-web/src/lib/optimystic.ts:145–161`.
- `@optimystic/reference-peer` CLI gains `--super-majority-threshold <number>`
  on `interactive`, `service`, and `run`. Parser rejects non-finite,
  `<= 0`, and `> 1` values with `--super-majority-threshold must be a
  number in (0, 1]`. Present → `clusterPolicy: { superMajorityThreshold }`
  on `createLibp2pNode`; absent → `clusterPolicy: undefined` (library
  default `0.67` preserved).
- E2E fixture (`packages/reference-app-web/e2e/fixtures/reference-peer.ts`)
  passes `--super-majority-threshold 0.51` to bootstrap and both
  service peers immediately after `--cluster-size 3`.
- New unit spec in db-p2p
  (`packages/db-p2p/test/cluster-coordinator-supermajority.spec.ts`)
  parametrises 3 cases: `(0.67, 3) → commit`,
  `(0.67, 2) → supermajority-failed`, `(0.51, 2) → commit`. Locks the
  `Math.ceil(peerCount * threshold)` math against regression.
- Docs updated:
  `packages/reference-app-web/README.md` (manual bootstrap recipe,
  Tier 2 fixture description, reproduce-e2e-locally snippet) and
  `../optimystic/packages/reference-peer/README.md` (`--super-majority-threshold`
  documented next to `--cluster-size` with rounding rationale).

## Review findings

### Threshold math — verified end-to-end (clean)

The unit spec in db-p2p exercises the exact code path the bug was on:
`ClusterCoordinator.executeClusterTransaction` → promise-phase tally
against `Math.ceil(peerCount * superMajorityThreshold)`. With 3 peers:

| threshold | ceil(3 * threshold) | approvals=3 | approvals=2 |
| --- | --- | --- | --- |
| `0.67` (library default) | 3 | commit | supermajority-failed |
| `0.51` (new distributed default) | 2 | commit | **commit** |

All three cases pass under
`yarn workspace @optimystic/db-p2p test:verbose --grep "super-majority threshold math"`.

`0.51 vs 0.67`: 0.67 sits at `3 * 0.67 = 2.01` — barely above 2, ceils
to 3, so a 3-peer cluster demands unanimity. `0.51` rounds the same
3-peer cluster down to 2-of-3, leaving one peer of slack. The chosen
default is also symmetric with the library's hard-coded
`simpleMajorityThreshold = 0.51`
(`libp2p-node-base.ts:322`), which lines up the promise-phase and
commit-phase thresholds at the same 3-peer / 2-quorum point under the
distributed-mode default.

### CLI parser — strict, symmetric with sibling (clean)

`parseSuperMajorityThreshold` (`cli.ts:69–76`) mirrors the
recently-tightened `parseClusterSize`:

```ts
if (options.superMajorityThreshold === undefined) return undefined;
const parsed = Number(options.superMajorityThreshold);
if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
    throw new Error('--super-majority-threshold must be a number in (0, 1]');
}
```

Verified rejections against
`interactive --super-majority-threshold {0, 1.5, foo} --offline`: all
three exit with `❌ Error: --super-majority-threshold must be a number
in (0, 1]`. The upper bound permits `1.0` (unanimity), which is
defensible — `ceil(n * 1.0) = n` matches the natural reading of "all
peers must approve" — and consistent with the README's documented
"fraction in (0, 1]".

### CLI registration — all three subcommands (clean)

`--help` confirms `--super-majority-threshold <number>` is registered
on `interactive`, `service`, and `run`. Console diagnostic on startup
(`🎯 Super-majority threshold set to <value>`) and
`logDebug('super-majority threshold override set', { … })` mirror the
`--cluster-size` style.

### `clusterPolicy` gating — preserves other defaults (clean, with a note)

Both the browser (`optimystic.ts:159–161`) and CLI (`cli.ts:367–369`)
construct `clusterPolicy` only when `superMajorityThreshold !== undefined`,
so the library defaults for `allowDownsize` and `sizeTolerance` are
preserved when the knob isn't set. If a future contributor adds another
`clusterPolicy` field without checking, they could accidentally couple
it to the threshold flag — worth a one-line guarding comment if either
file grows another field, but premature today (single-flag policy).

### Browser default asymmetry solo vs. distributed (intentional)

Solo mode keeps `superMajorityThreshold: undefined` → library default
`0.67`. That value is moot for a 1-peer cluster (`ceil(1 * 0.67) = 1`),
so the asymmetry has no observable effect. It mirrors the existing
`clusterSize: 1 vs 3` default at `optimystic.ts:144`, which is the
right precedent.

### Unit test verdict shape (clean)

The mock's `silent` verdict — returns the record unchanged with no
signature added — is the correct shape for the bug being locked in. The
real failure mode is a peer whose `getTransactionPhase` lands in
`Promising` (not `OurPromiseNeeded`) and returns successfully without
co-signing; a `reject` verdict would short-circuit the threshold tally
through the `'rejected by validators'` code path and miss it. The
implementer's docstring on the spec already calls this out.

### Fixture / browser agreement (clean)

`packages/reference-app-web/e2e/fixtures/reference-peer.ts` appends
`'--super-majority-threshold', '0.51'` to the bootstrap
(`interactive --offline`) and each service peer's argv, immediately
after `--cluster-size 3`. Matches the browser's distributed-mode
default at `optimystic.ts:145`. No mismatch surface.

### Docs (clean)

`packages/reference-app-web/README.md` — manual-bootstrap recipe and
Tier 2 fixture description both include `--super-majority-threshold 0.51`
with the `ceil(3 * 0.67) = 3` unanimity rationale. The "reproduce e2e
locally" snippet matches.
`../optimystic/packages/reference-peer/README.md` — flag documented
under "Interactive Mode" options with default `0.67`, rounding example
for 3-peer clusters, and the cross-mention that the value must match
across cluster peers. No stale references elsewhere
(`docs/architecture.md`, `docs/cadre-consistency.md`, `docs/STATUS.md`
each searched — the only out-of-tree mention of "super-majority" is the
general concept in `cadre-consistency.md:9` and is unrelated).

### Validation re-run (post-review)

- `yarn workspace @optimystic/db-p2p build` → exit 0.
- `yarn workspace @optimystic/db-p2p test` → **440 passing, 5 pending**.
  No regressions.
- `yarn workspace @optimystic/db-p2p test:verbose --grep "super-majority threshold math"` →
  **3 passing** (`0.67/3 → commit`, `0.67/2 → supermajority-failed`,
  `0.51/2 → commit`).
- `yarn workspace @optimystic/reference-peer build` → exit 0.
- `reference-peer {interactive,service,run} --help` → flag present on
  all three; description "Super-majority threshold as a fraction in
  (0, 1] (default 0.67)".
- Bad-input rejection: `--super-majority-threshold {0, 1.5, foo}` each
  exit with `❌ Error: --super-majority-threshold must be a number in
  (0, 1]`.
- `yarn workspace @serfab/reference-app-web typecheck` → exit 0.

### Tier 2 e2e — supermajority bug fixed; **different** residual race

The ticket's stated acceptance target was 16/16 Tier 2 specs passing.
The implement-stage run hit **13/16**; this review did not re-run the
full Tier 2 suite (it spawns 3 reference-peer processes per spec and
runs well over the agent's 10 min idle budget end-to-end, so it's not
agent-runnable as a routine check).

The implementer's debug evidence is convincing on the two questions
that matter:

- The `cluster-tx:supermajority-failed` event — the *exact* signature
  this ticket fixes — appeared **zero times** in two separate Tier 2
  runs with `OPTIMYSTIC_E2E_DEBUG=1`. Every `cluster-tx:start` in the
  trace progressed through `:promise-summary` → `:commit-majority-reached`
  → `:complete` on the threshold path.
- The remaining 3-of-16 failures surface a *different* event,
  `cluster-tx:consensus-broadcast-error` (cluster-coordinator.ts:537),
  raised on the post-majority broadcast and recovered via
  `scheduleCommitRetry` on a 2 s initial interval (cluster-coordinator.ts:584,
  `retryCommits` line 621). The retry window is wide vs. the e2e
  polling assertions, so a tab can sample the missed peer inside the
  gap.

This is **out of scope for this ticket** (its scope was the threshold
math, "option 1" in the source ticket's vocabulary). Filed as a fresh
fix-stage ticket so the work is tracked: `fix/web-e2e-tier2-consensus-broadcast-race.md`.

### Out-of-scope, not reviewed

The uncommitted optimystic working tree still carries the `--no-relay`
/ `effectiveRelay` / `🔁 Circuit-relay server: on/off` rework from
the earlier `web-e2e-tier2-data-convergence-relay` ticket, and the
`--cluster-size` plumbing from `reference-peer-cluster-size-cli`.
Untouched in this review; coexists cleanly with the
`--super-majority-threshold` threading (the full db-p2p and
reference-peer test suites pass with all three stacked).

## Follow-ups

- `fix/web-e2e-tier2-consensus-broadcast-race.md` — residual 3-of-16
  Tier 2 race from `cluster-tx:consensus-broadcast-error` on the
  post-majority commit broadcast. Mechanism documented; open design
  questions captured (retry tuning vs. connection reuse vs.
  coordinator-driven read repair vs. circuit-relay reservation
  lifetime).
