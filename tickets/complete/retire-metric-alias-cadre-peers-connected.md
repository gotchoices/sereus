description: The node's metrics page used to report the same number twice under two names, the second only kept so older monitoring setups would not break. Nothing is monitoring us yet, so the duplicate is now dropped.
files: packages/cadre-cli/src/server/health.ts, packages/cadre-cli/test/health-server.spec.ts
difficulty: easy
----

# Drop the `cadre_peers_connected` metric alias — complete

`HealthServer` (`packages/cadre-cli/src/server/health.ts`) no longer publishes
`cadre_peers_connected`. `cadre_connections_total` (same value, `paths.total`) is the only name
for that counter. `GET /metrics` now has real test coverage where it previously had none.

## What shipped

Implement stage (commit `46edb95`):

- `MetricsData` interface: removed the `cadre_peers_connected: number` field and its doc comment.
- `getMetrics()`: removed the `cadre_peers_connected: paths.total,` entry.
- `formatConnectionMetrics()`: removed the `cadre_peers_connected` HELP/TYPE/value triple and its
  leading `''` separator, leaving the `cadre_connections_total` triple's separator intact.
- Added `HealthServer.metricsBoundPort` getter so the suite can reach the metrics server when it is
  constructed with `metricsPort: 0`.
- One `/metrics` test asserting the body contains `cadre_connections_total ` and not
  `cadre_peers_connected`, plus a `\n\n\n` guard for the separator edit.

Review stage (this pass) — all minor, fixed inline:

- Collapsed the two near-identical bound-port getters onto one module-level `boundPort(server,
  requested)` helper. The implementer's `metricsBoundPort` was a verbatim copy of `healthBoundPort`.
- Moved the `cadre_strands_total` HELP/TYPE lines out of `formatPrometheusMetrics` and into
  `formatStrandMetrics`, where its value line already lived. The section boundary previously cut a
  HELP/TYPE/value triple in half, so neither function owned a whole metric. Each section now owns
  its own leading blank-line separator, matching `formatConnectionMetrics`. Emitted text is
  byte-identical.
- Deleted the stale `// Continued in next sections due to line limit` comment — there is no line
  limit; the split is ordinary decomposition and the code reads as such without it.
- Made `MockNode.getConnectionPaths()` scriptable (a `connectionPaths` field) and added two
  `/metrics` cases: one asserting live non-zero counts and that zero-count transports are filtered
  out of the labelled series, one walking the whole body block-by-block to assert every block is
  `# HELP`, `# TYPE`, then at least one well-formed sample line.

## Review findings

**Checked:** the implement diff read before the handoff summary; full current `health.ts` (410
lines — not oversized, no split warranted); full `health-server.spec.ts`; repo-wide grep for
`cadre_peers_connected`; grep for `cadre_*` metric names across `docs/`, `ops/`, `schemas/`, and
every package README; consumers of `MetricsData`, `formatPrometheusMetrics`, and the two bound-port
getters; whether `dist/` is tracked; lint and the full `cadre-cli` suite.

**Correctness — nothing found.** The separator edit is right: `formatConnectionMetrics` now starts
with its own `''` and the emitted text has no leading or doubled blank line. The alias appears
nowhere outside the intentional negative assertion in the test and git-ignored files under
`tickets/.logs/`. No `.yml`/`.json`/dashboard/scrape config in the repo ever referenced it.

**Docs — no update needed, confirmed by reading rather than assumed.** No document anywhere in the
repo enumerates metric names. `packages/cadre-cli/README.md:222` mentions port 9090 and the
`/metrics` path only; `docs/architecture.md` mentions "metrics" as a capability, never a metric
name. Nothing went stale.

**Source hygiene — three minor findings, all fixed inline** (duplicated bound-port getter, the
triple split across the section boundary, the stale "line limit" comment). Listed above.

**Test coverage — one minor finding, fixed inline.** The implementer's single case was exactly
what the ticket asked for but leaned entirely on `MockNode` returning all-zero connection paths, so
it could not distinguish a correct value from a zero, and the zero-count-transport filter in
`getMetrics()` was untested. Two cases added, described above. Coverage now spans the happy path,
non-zero values, the filtered-out edge case, and output well-formedness.

**Major findings — none, so no new tickets were filed.** The change is a three-site deletion in one
file with no consumers; there is no class of defect behind it to climb to.

**Tripwire — one, parked in code.** `formatPrometheusMetrics` builds the exposition text from
string literals with no link back to the `MetricsData` field list, so a field added to the
interface but never formatted (or the reverse) is silent — the new well-formedness test only
validates lines that actually get emitted. Fine at this size; recorded as a `NOTE:` comment above
`formatPrometheusMetrics` saying to drive the text off a field table if the metric set grows much.
Not filed as a ticket.

**Handoff correction, no action:** the implement notes describe
`packages/cadre-cli/dist/server/health.d.ts` as committed build output. `git ls-files
packages/cadre-cli/dist` returns nothing — `dist/` is git-ignored. The rebuild the implementer ran
was harmless and the concern about hand-editing generated output never applied.

**Accepted-tradeoff `NOTE:`s at these sites:** none present, so nothing was re-filed against a
prior human decision.

## Verification

- `yarn workspace @serfab/cadre-cli build` — clean.
- `yarn workspace @serfab/cadre-cli test` — 213/213 pass across 16 files (211 before this pass,
  plus the two cases added here).
- `yarn lint` — clean, repo-wide.
- No pre-existing failures surfaced; `tickets/.pre-existing-error.md` not written.

## Follow-on notes

`metricsBoundPort` is new public surface on `HealthServer`, used only by the test suite — the same
shape as the pre-existing `healthBoundPort`, which is also test-only. Reviewed and kept: without it
the metrics server bound to port 0 is unreachable, and the alternative is reaching into the private
`formatPrometheusMetrics`, which would test the formatter instead of the endpoint.
