description: Starting a device reads and writes its local storage about 1,500 times just to create eight empty tables, so whenever the disk is busy the startup that normally takes a second and a half stretches to fifteen seconds or a minute. The wasteful repetition happens inside the Optimystic storage library we depend on, not in this repo, so someone needs to decide who fixes it and where.
files: packages/cadre-core/src/control-database.ts, ../optimystic/packages/db-p2p/src/storage/, ../optimystic/packages/db-p2p/src/repo/coordinator-repo.ts, ../optimystic/packages/db-p2p-storage-fs/
repro: verified

# Cold/warm control-database start is storage-op bound (~1541 ops), and the ops come from Optimystic

## Why this is a human decision

The stall reported in `control-schema-init-stalls-on-cold-solo-start` is real and reproducible,
but there is **no code site in this repo whose change removes it**. The cost is a per-operation
count generated inside `@optimystic/db-p2p`, multiplied by whatever a single small storage
operation happens to cost on the device. Someone has to decide whether to fix that in
`../optimystic`, absorb it, or change what Sereus asks of it — the last option is explicitly
ruled out by the originating ticket's design constraints (see "What is NOT the fix").

## What was measured

All numbers below are from this machine (Windows 11, 24 cores, `packages/cadre-core`), with the
suite's own build-freshness guard passing.

**One cold `CadreNode.start()` performs 1541 raw-storage operations** for a control database of
8 tables and 1 index — over at most 21 distinct blocks:

| operation | calls | distinct blocks |
|---|---|---|
| `getMetadata` | 720 | 21 |
| `listPendingTransactions` | 202 | 6 |
| `listRevisions` | 196 | 3 |
| `getMaterializedBlock` | 196 | 3 |
| `getPendingTransaction` | 96 | 6 |
| `saveMaterializedBlock` | 36 | 6 |
| `saveMetadata` | 28 | 6 |
| `savePendingTransaction` | 22 | 6 |
| `saveRevision` | 22 | 6 |
| `promotePendingTransaction` | 22 | 6 |
| `listBlockIds` | 1 | 1 |

Only 130 of the 1541 are writes. `getMetadata` is read **34× per distinct block**;
`getMaterializedBlock` **65×**. Measured by wrapping the `IRawStorage` the test harness hands
`CadreNode` in a counting proxy (`FileRawStorage` under the OS temp dir) — a throwaway spec, not
committed; the in-repo ticket `control-start-storage-op-budget` turns it into a permanent guard.

Start duration is simply **1541 × per-operation storage latency**:

- idle machine, ~1 ms/op → `loadSchema` 1.3–1.7 s (the "normal" figure in the originating ticket);
- contended, 50–90 ms/op → 15–62 s.

## What the stall actually is

Reproduced twice on demand by running the full 93-file `cadre-core` suite with 8 background
CPU busy-loops. One run went red exactly as reported
(`solo-warm-start control op queryCadrePeers() (warm) timed out after 15000ms`); others stayed
green but logged `loadSchema` at 7.9 s, 13.2 s, 14.1 s and 29.4 s.

A 1-second heartbeat inside every worker process (process CPU time, storage-call count, slowest
storage call) shows the stalled worker is **idle and waiting on storage**, not busy:

| | healthy | during a stall |
|---|---|---|
| process CPU | 77–87 % | 6–30 % |
| storage calls / s | 1000–1500 | 45–60 |
| slowest storage call | 5–16 ms | 47–88 ms |

So a single small file operation goes from ~5 ms to ~90 ms, and because the operations are
issued one at a time the whole start slows by the same factor. The `[start] total` for the worst
case measured here was 15.7 s: `hydrate` 7.8 s **plus** `loadSchema` 7.9 s.

Environment note: what raises per-operation latency on this machine is a loaded Windows temp
directory (93 test processes; on-access scanning is the likely amplifier). On a phone the same
multiplier comes from flash I/O under app-launch contention. The *sensitivity* is the defect;
the specific trigger is not.

## What was ruled out

The originating ticket's leading hypothesis — a solo node taking a cluster/coordinator deadline
and then retrying — is **wrong**, and this is worth recording so nobody re-derives it:

- `DEBUG='sereus:cadre:control-db'` during outliers logged **zero** retry lines. Neither
  `Control write%s committed on attempt %d/%d` nor the transient-failure line ever appeared, so
  `SCHEMA_INIT_RETRY_POLICY` never engaged. `control-write-retry.ts` is not implicated.
- `findCoordinator` resolves to self in 0–1 ms every time (`source=fret`), the self-coordination
  guard waves the node through as a bootstrap node, and every block read logs
  `cluster-fetch:solo-self-skip` — no peer is contacted, no 10 s response deadline is consumed.
- The stall is not cold-only: the worst observed case was a **warm** start
  (`hydrate: 7774ms (tables=8, indexes=1)`). Warm starts do fewer operations, so they stall less
  often, not for a different reason.
- Uniform CPU pressure alone does not do it: 8 concurrent copies of a cold-start harness under 8
  busy-loops (128 starts) came out flat at ~4 s each, with no outlier and no storage call over
  150 ms.

## What is NOT the fix

- **Not the retry policy or its classifier.** It never runs on this path.
- **Not making control DDL non-distributed.** `control-database.ts:438-444` explains why the
  control tables must stay Optimystic-backed; and the ops are issued by the storage layer under
  the local repo, so a local transactor would reduce but not remove them.
- **Not a read cache at the raw-storage seam.** Tried: memoizing `getMetadata` /
  `getMaterializedBlock` per block, invalidated on any write to that block, cut 1541 → 1189
  (23 %). The writes interleave with the reads, so the amplification is structural — 22 committed
  transactions for 8 tables + 1 index, each re-reading the same handful of blocks.
- **Not widening the spec budgets.** They are hang detectors and the stall is real.

## What a fix would have to change

Somewhere in `../optimystic`, one of:

- the per-operation read pattern in the block-storage path (`db-p2p` storage + `coordinator-repo`),
  so a single logical operation stops re-reading the same block's metadata dozens of times;
- or the storage interface, so a batch of block reads is one backend call rather than N;
- or `db-p2p-storage-fs`, so a metadata/materialized-block read is not one filesystem round trip
  each (this only reduces the constant, not the count).

Sereus cannot do any of these from here.

## Decisions needed

- Fix upstream in `../optimystic`, or accept ~1500 storage operations per control-database start
  and the launch-time sensitivity that comes with it?
- If accepted for now: is the acceptable ceiling stated in terms of operations (a budget the
  in-repo guard can pin) or in terms of wall clock on a reference device?
