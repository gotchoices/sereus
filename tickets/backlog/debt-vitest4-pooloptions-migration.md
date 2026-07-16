description: The integration-tests package tries to force its slow tests to run one-at-a-time to avoid two tests grabbing the same network port, but a Vitest upgrade silently turned that setting off — so the safety net is gone even though tests happen to pass today.
files: packages/integration-tests/vitest.config.ts
difficulty: easy
----

# Migrate integration-tests to Vitest 4 sequential-run config

## What's wrong

`packages/integration-tests/vitest.config.ts` sets:

```ts
pool: 'forks',
poolOptions: {
  forks: { singleFork: true }   // "Run sequentially by default - parallel can cause port conflicts"
}
```

Vitest 4 **removed** `test.poolOptions` — the whole block is now silently ignored.
Running the suite prints:

```
DEPRECATED  `test.poolOptions` was removed in Vitest 4. All previous
poolOptions are now top-level options.
```

Consequence: the intended **single-fork, sequential** execution is no longer
applied. The stated reason for it — "parallel can cause port conflicts" — is
exactly the failure mode now unguarded. Integration scenarios spin up real
libp2p + control-DB children that bind TCP ports; if two suites run
concurrently and their port bands overlap, they collide and flake.

## Why it isn't failing *today* (and why that's fragile)

It passes right now only because each real-child scenario was hand-assigned a
**disjoint** port band:

- `cadre-host-owner-node.integration.ts` → 19600–19899
- `cadre-host-node-donation.integration.ts` → 19900–20199

That is a convention, not an enforced invariant. The moment a new suite reuses a
band (or an author forgets the convention), the missing `singleFork` guard turns
a would-be-serialized run into a real port collision. The config comment claims a
protection the config no longer provides.

## What to do

Restore the sequential-run intent using the Vitest 4 top-level surface (per the
[pool-rework migration guide](https://vitest.dev/guide/migration#pool-rework)) —
e.g. lift the `forks` options to top level, or set `fileParallelism: false` /
`maxWorkers: 1`. Then confirm the deprecation warning is gone and the full
`@serfab/integration-tests` suite still passes. Update the config comment to
match whatever mechanism is chosen.

Low-risk, mechanical; scoped to one config file.
