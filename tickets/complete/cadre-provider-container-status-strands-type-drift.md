description: Reconciled ContainerStatusResponse.health to the real /status wire shape — it is now ContainerHealthStatus (strands under health.node.strands), and getContainerStatus parses /status via the shared fetchContainerHealthStatus helper instead of an untyped `any` assignment. Deliberate public-contract change for GET /containers/:id (health.strands → health.node.strands).
files: packages/cadre-provider/src/types.ts, packages/cadre-provider/src/service/container-service.ts, packages/cadre-provider/src/service/container-health.ts, packages/cadre-provider/src/index.ts, packages/cadre-provider/src/server/routes.ts, packages/cadre-provider/src/service/__tests__/container-get-status.test.ts
----

## What shipped

`ContainerStatusResponse.health` no longer lies about the strand wire shape. It is now
`ContainerHealthStatus | undefined` (strands under `health.node.strands`), and
`getContainerStatus` routes its `/status` fetch through the existing `fetchContainerHealthStatus`
helper instead of an untyped `any` JSON assignment — so this class of drift is now compiler-caught.

- `types.ts:85-94` — `health` field re-typed to the wire-accurate `ContainerHealthStatus`
  (imported `import type` from `./service/container-health.js`), with a doc-comment pointing
  consumers at `health?.node?.strands?.active ?? 0`.
- `container-service.ts:170-185` — `getContainerStatus` collapsed to
  `if (container.status === 'running') response.health = await fetchContainerHealthStatus(container)`.
  The old inline `fetch(statusUrlFromHealthEndpoint(...))` + `response.health = await healthRes.json()`
  (the `any` source of the drift) and the redundant `&& container.healthEndpoint` guard / inline
  try-catch are gone (the helper already short-circuits to `undefined` on missing endpoint / throw /
  non-OK).
- `index.ts:87-94` — re-exported `ContainerHealthStatus`, `ContainerStrandCounts`,
  `fetchContainerHealthStatus`, `statusUrlFromHealthEndpoint` so the public `health` type is nameable.
- `container-get-status.test.ts` — new 6-test suite.

Public-contract change for `GET /containers/:id`: `data.health` moves strand counts from
`health.strands.*` to `health.node.strands.*`, now optional. Accepted under AGENTS.md "no backwards
compatibility yet". No in-repo consumer read the old flat shape.

## Review findings

**Verdict: implementation is correct and complete for its stated scope.** Build and tests green;
one out-of-scope pre-existing bug discovered in a sibling method and filed as a fix ticket.

### Checked — clean

- **Diff read first, fresh.** Reviewed `git show f39f598` before the handoff summary.
- **Wire-shape claim verified at the source.** Confirmed against cadre-cli
  `HealthServer.getHealthStatus` (`health.ts:130-144`): `/status` emits strands strictly under
  `node.strands`; the provider's local `ContainerHealthStatus` subset (`status`, `uptime`,
  `node?.strands?`) is an accurate, deliberately-narrowed slice of `HealthStatus`. The provider
  re-typing locally (rather than importing from cadre-cli) is correct — it has no cadre-cli dep.
- **Behavioral equivalence.** Dropping the `&& container.healthEndpoint` guard changes nothing:
  the helper returns `undefined` when the endpoint is absent, so a running-but-endpointless
  container still yields `health: undefined`. Same observable result as before.
- **Type safety.** The `any` assignment is eliminated; the only remaining cast is the wire-boundary
  `res.json() as ContainerHealthStatus` inside the helper, which is appropriate. Build passes under
  strict tsc; the `types → service/container-health` `import type` edge raised no cycle complaint.
- **No consumer / no doc regression.** Repo-wide grep for `health.strands` / `health.node` /
  `ContainerStatusResponse` found no in-repo consumer of the old flat shape (only ticket markdown).
  Grep of `docs/` for the container-status `health` shape found nothing describing it — so there is
  no documentation to update (verified, not assumed). `routes.ts` forwards `status` verbatim, so it
  transparently emits the corrected shape.
- **Tests.** Happy path (node.strands honored), URL derivation (`/status` not `/health`),
  non-running (no fetch), fetch-throw, non-OK, unknown-id. Reasonable coverage of edge/error paths.
- **Validation re-run during review:** `yarn workspace @serfab/cadre-provider build` → exit 0;
  `yarn workspace @serfab/cadre-provider test` → 30/30 pass.

### Minor

- **Helper's no-endpoint branch not directly exercised** by the new suite (covered transitively;
  the non-running test stops before the helper). Left as-is — the helper's own degradation is
  simple and the path is reached by the billing suite. Not worth an extra test.
- **No timeout on the `/status` fetch.** Pre-existing, inherited from the helper / matches
  `applySeed` / `waitForEnrollment`; already on the billing review's accepted-gaps list. Out of
  scope; not introduced here.

### Major → filed as new ticket (out of scope here, not a defect in this diff)

- **`getPeerInfo` reads the wrong endpoint** — `tickets/fix/cadre-provider-getpeerinfo-reads-health-not-status.md`.
  `getPeerInfo` (`container-service.ts:275-306`, backing `GET /containers/:id/peer`,
  `routes.ts:218`) fetches `container.healthEndpoint` (the `/health` URL), which returns only
  `{ status }` (`health.ts:251`). `peerId`/`multiaddrs` exist only on `/status`. Since nothing else
  in the provider ever writes `container.peerId`/`multiaddrs` (the only assignments are inside
  `getPeerInfo` itself), the cache is never warmed and **the endpoint always returns 503**. This is
  pre-existing — the implementer explicitly scoped this ticket to `getContainerStatus` and left
  `getPeerInfo` alone — but it surfaced while tracing the `/health` vs `/status` distinction, so
  it's filed rather than fixed inline (separate method/endpoint, deserves its own test). The
  sibling `waitForEnrollment` is *not* affected: it reads only `health.status`, which `/health`
  does return.

### Not changed

- `waitForEnrollment` / inline casts in unrelated methods — correct as-is or out of scope (see above).
