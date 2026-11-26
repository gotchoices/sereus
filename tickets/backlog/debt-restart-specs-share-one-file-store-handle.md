----
description: A group of tests that are supposed to prove the app can restart and read its own saved data no longer really restarts anything — they keep reusing the same in-memory bookkeeping instead of starting fresh from the files on disk, so a bug in the reload path could pass unnoticed.
architecture: docs/contributing/testing.md
files: packages/cadre-core/test/control-db-node-helpers.ts, packages/cadre-core/test/control-database-solo-warm-start.spec.ts, scripts/lib/published-smoke-scenario.mjs
difficulty: medium
tradeoffs: Every case in the affected suite passes today and the suite is coverage rather than a regression guard, so a maintainer may reasonably say the weaker property (real bytes written through a real filesystem backend) is enough and spend the budget elsewhere.
----

# Restart specs reach their files through one shared store handle

## What a restart spec is supposed to prove

`packages/cadre-core/test/control-database-solo-warm-start.spec.ts` is the one control-database suite whose point is that a restart reads **nothing but what is on disk**. Its companions (`control-database-solo.spec.ts`, `control-database-offline-peers.spec.ts`) deliberately restart over heap-resident stores; this one exists to be different. The distinction matters because the defect class it covers is a hydrate path that silently works only because a live object survived the restart — a `Map` of cached metadata, an unflushed write group, a resolved catalog.

## What it actually gets now

The shared helper `fileStorageProvider` (`control-db-node-helpers.ts`) memoises one value per scope, and underneath it Optimystic's `fileNodeStorage` keeps **one set of stores per directory for the whole process**, counted by holder, and drops the entry only when the last holder closes. The helper never closes a holder — the test removes the directory instead. So a second node over the same directory is handed the same block, key-value and piece store objects as the first, sharing their in-memory write groups.

What the suite still buys is real: the rows a restart hydrates were written through a filesystem backend and its write-ahead log, not kept as heap objects, so a hydrate path that only works against an in-memory store does fail there. What it no longer buys is the cold handle.

This also means the directory's write-ahead log is never checkpointed and its lock never released inside the process. The Windows `rmSync` retry in the warm-start spec's own teardown is the thing that notices.

## What would restore it

One site, two arms, both in `control-db-node-helpers.ts`:

- **Close the holders.** Give the helper a way for a spec to say "this run is over" and have it close each `OpenNodeStorage` it opened, which releases the last holder, drops the directory's entry and checkpoints its log. The next open over that directory is then genuinely cold. Upstream's own factory comment names this as the supported route back to independent instances.
- **Or construct the three stores directly** for the specs that need the property — `FileRawStorage`, `FileKVStore` and `FilePieceStore` over one base path — which is what upstream points callers that are not ordinary hosts at. That gives two independent instances over one directory without touching the holder count.

Either arm has to keep every other spec that shares the helper working; roughly thirty files call it, and several rely on the memo handing back the same value within one run.

## Use case

A change to control-database hydration lands with the suite green because the restarted node read a value another node's write group still held, not the bytes it would read on a real device after a process exit. The device reports a cadre that comes up empty; nothing in CI saw it.

## The same loss in the published-package smoke scenario

`scripts/lib/published-smoke-scenario.mjs` carries its own copy of `fileStorageProvider` for its port of the warm-start case, with the same memo and the same never-closed holders, so it has lost the same half of the same property. Whichever arm above is taken, that copy follows it — the two are deliberately written to mirror each other, and the file says so.

## Related

The helper's current behaviour is documented honestly at `fileStorageProvider`, and the warm-start spec's head comment says which half of its stated property it has lost and links here. Found while reviewing `optimystic-1-30-cadre-core-node-storage`, which is when `fileNodeStorage` replaced a plain `FileRawStorage` per scope.
