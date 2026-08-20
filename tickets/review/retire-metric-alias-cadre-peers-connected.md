description: The node's metrics page used to report the same number twice under two names, the second only kept so older monitoring setups would not break. Nothing is monitoring us yet, so the duplicate is now dropped.
files: packages/cadre-cli/src/server/health.ts, packages/cadre-cli/test/health-server.spec.ts
difficulty: easy
----

# Drop the `cadre_peers_connected` metric alias — done

`HealthServer` (`packages/cadre-cli/src/server/health.ts`) no longer publishes
`cadre_peers_connected`. `cadre_connections_total` (same value, `paths.total`) is now the only
name for that counter.

## Changes

- `MetricsData` interface: removed the `cadre_peers_connected: number` field and its doc comment
  (was ~line 72).
- `getMetrics()`: removed the `cadre_peers_connected: paths.total,` entry (was ~line 197).
- `formatConnectionMetrics()`: removed the `cadre_peers_connected` HELP/TYPE/value triple and its
  leading `''` separator, leaving the `cadre_connections_total` triple's own separator intact —
  emitted Prometheus text has no leading/double blank line where the block used to be.
- Added `HealthServer.metricsBoundPort` getter (mirrors the existing `healthBoundPort`) — the test
  suite had no way to reach the metrics server when constructed with `metricsPort: 0`, and the
  ticket asked for a real `/metrics` GET, not a reach into `formatPrometheusMetrics` directly.
- `dist/server/health.d.ts` regenerated via `yarn workspace @serfab/cadre-cli build` — confirmed
  the alias field is gone from the rebuilt output; no hand-edit needed.

## Test added

`packages/cadre-cli/test/health-server.spec.ts`, new case under "with no seed token (default)":
GETs `/metrics` on the (now-reachable) metrics port, asserts body contains
`cadre_connections_total ` and does **not** contain `cadre_peers_connected`, and asserts no
`\n\n\n` (guards the separator edit — this is the only place in the suite that talks to the
metrics server at all; previously untested).

## Verification

- Re-grepped repo for `cadre_peers_connected` post-edit: zero hits outside this ticket file (now
  deleted on promotion) and the archived plan ticket. No consumer anywhere (`ops/`, `cadre-host`,
  `reference-app-*`, any `.yml`/`.json`) referenced it before or after.
- `yarn workspace @serfab/cadre-cli build` — clean.
- `yarn workspace @serfab/cadre-cli test` — 211/211 pass (16 files), including the new case.
- `yarn lint` — clean, repo-wide.

## Gaps / things the reviewer should know

- `metricsBoundPort` is new public API surface on `HealthServer`, added solely to make `/metrics`
  testable at all — pre-existing gap, not scope creep on the metric removal itself, but worth a
  second look since it wasn't explicitly requested by the ticket.
- Only one `/metrics` test case added (the one the ticket specified). No broader coverage of
  `formatPrometheusMetrics`/`formatStrandMetrics` output shape was added — pre-existing gap, out
  of scope here.
- No live deployment exists to canary this against; correctness rests on the repo-wide grep plus
  the new test, per the ticket's own reasoning for taking the break "for free" now.
