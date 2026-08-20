----
description: The node's metrics page reports the same number twice under two names, the second only kept so older monitoring setups would not break. Nothing is monitoring us yet, so drop the duplicate.
files: packages/cadre-cli/src/server/health.ts, packages/cadre-cli/test/health-server.spec.ts
difficulty: easy
----

# Drop the `cadre_peers_connected` metric alias

`HealthServer` publishes `cadre_peers_connected` and `cadre_connections_total` with the identical
value (`paths.total`). The alias is documented in-line as "kept for back-compat with existing scrape
configs". There are no existing scrape configs — no live deployment, no `ops/` dashboard, no
cadre-host UI read, no reference-app read. A repo-wide grep finds it in exactly one source file
plus that file's stale `dist/` build output.

Removing it is a public-surface change to `GET /metrics`, which is exactly the kind of break the
current no-live-instances window exists to take for free.

## What changes

`packages/cadre-cli/src/server/health.ts`, three sites:

- The `cadre_peers_connected: number` field on the `MetricsData` interface (~line 72) and its
  doc comment.
- The `cadre_peers_connected: paths.total,` entry in `getMetrics()` (~line 197).
- The three Prometheus text lines (`# HELP`, `# TYPE`, value) at the head of
  `formatConnectionMetrics()` (~lines 243-245), including the blank-line separator so the emitted
  text has no double blank line where the block used to be.

`cadre_connections_total` keeps its `# HELP` text as-is; it was never phrased in terms of the alias.

## Edge cases & interactions

- **The emitted text must stay well-formed Prometheus.** The `formatConnectionMetrics` array is
  built from `''` separators interleaved with HELP/TYPE/value triples. Deleting the first triple
  must not leave a leading `''` that joins into a blank first line of the connection block, and
  must not delete the separator that belongs to `cadre_connections_total`.
- **`packages/cadre-cli/dist/server/health.d.ts` also names the field.** That is committed build
  output, not source — do not hand-edit it; a rebuild regenerates it. If it does not regenerate,
  say so in the handoff rather than editing it by hand.
- **No consumer to update.** Confirmed by grep at plan time: `cadre_peers_connected` appears
  nowhere in `ops/`, `packages/cadre-host/`, `packages/reference-app-*`, or any `.yml`/`.json`.
  Re-run the grep before finishing; if a consumer has appeared since, update it in this ticket
  rather than leaving a dangling scrape.
- **`/metrics` currently has no test at all.** `health-server.spec.ts` already stands up a server
  with `metricsPort: 0` for other cases, so the missing coverage is cheap to add and is what stops
  the alias returning by copy-paste.

## TODO

- Remove the `cadre_peers_connected` field, its `getMetrics()` entry, and its three Prometheus
  lines (plus the orphaned blank-line separator) from `health.ts`.
- Re-grep the repo for `cadre_peers_connected` outside `dist/`; the only expected remaining hits
  are this ticket and the completed-ticket archive.
- Add a `/metrics` case to `packages/cadre-cli/test/health-server.spec.ts`: GET the metrics port,
  assert the body contains `cadre_connections_total ` and does **not** contain
  `cadre_peers_connected`, and assert the body has no `\n\n\n` (the well-formedness guard for the
  separator edit).
- Run `yarn workspace @serfab/cadre-cli build` and `yarn workspace @serfab/cadre-cli test`.
- Run `yarn lint`.
