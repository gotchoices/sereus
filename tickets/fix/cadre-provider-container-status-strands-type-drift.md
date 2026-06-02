description: ContainerStatusResponse.health declares strands at the top level, but the live /status payload nests them under node.strands — getContainerStatus assigns the raw JSON, so health.strands is undefined at runtime and the GET /containers/:id API contract is a lie.
files: packages/cadre-provider/src/types.ts, packages/cadre-provider/src/service/container-service.ts, packages/cadre-provider/src/server/routes.ts, packages/cadre-cli/src/server/health.ts, packages/cadre-provider/src/service/container-health.ts
----

## Problem

`ContainerStatusResponse.health` (`packages/cadre-provider/src/types.ts:84-96`) declares strand
counts at the **top level**:

```ts
health?: {
  status: 'healthy' | 'unhealthy' | 'starting';
  uptime: number;
  strands: { total; active; idle; hibernating };   // <-- top-level
};
```

But the real `/status` payload emitted by the cadre-cli health server is the `HealthStatus`
shape (`packages/cadre-cli/src/server/health.ts:16-34, 113-127, 197-200`), where strands live
under **`node.strands`**, not at the top level.

`ContainerService.getContainerStatus` (`container-service.ts:175-184`) assigns the parsed
`/status` JSON straight into `response.health`:

```ts
if (healthRes.ok) {
  response.health = await healthRes.json();   // runtime shape: { ..., node: { strands } }
}
```

The assignment only compiles because `Response.json()` is typed `any`. At runtime
`response.health.strands` is `undefined` (the data is at `response.health.node.strands`), so any
consumer trusting the declared type gets `undefined`.

## Impact

`GET /containers/:id` (`routes.ts:128-149`) forwards `status` — including `health` — to API
clients. The documented/typed response contract therefore advertises `health.strands.*` to
external callers, but the wire payload never carries strands at that path. No crash today (no
in-repo consumer reads `response.health.strands` — verified by grep), but the typed contract is
wrong and any new internal consumer or external client coding to the type will silently read
`undefined`.

Discovered during review of `cadre-provider-billing-not-persisted`. The billing path was fixed
to read the **correct** runtime path (`node.strands.active`, via the new
`ContainerHealthStatus` type in `container-health.ts`), but the divergent
`ContainerStatusResponse.health` type was left untouched to keep that ticket scoped to billing.

## Expected behavior

`ContainerStatusResponse.health` and the value `getContainerStatus` returns should agree, and
should match what the cadre-cli `/status` endpoint actually emits. Two viable shapes:

- **Reconcile the type to reality:** nest strands under `node` (mirror `HealthStatus`, or reuse
  the `ContainerHealthStatus` shape now living in `container-health.ts`), and have
  `getContainerStatus` parse into that type instead of `any`. This is the lower-risk option —
  it makes the contract honest about what the wire already carries.
- **Or map at the boundary:** keep the flat public contract but have `getContainerStatus`
  explicitly project `node.strands` up to the top level (and parse the fetched JSON into a typed
  intermediate rather than `any`), so the stored value matches the declared type.

Either way, `getContainerStatus` must stop assigning an untyped `any` blob into a typed field —
parse `/status` into a concrete type (the same one `fetchContainerHealthStatus` uses is the
natural source of truth) so this class of drift is caught by the compiler.

Add a test that asserts the shape returned by `getContainerStatus` (mock `fetch` with the real
`node.strands` `HealthStatus` body) matches whatever contract is chosen — the existing billing
test already proves the `node.strands` path against a hand-built body, so the emitter shape is
known.
