----
description: When a second machine joins a shared strand it now receives a copy of everything written before it connected, not just what comes after — review the new catch-up module, its wiring, and the test evidence.
prereq:
files: packages/cadre-core/src/strand-backfill.ts (new), packages/cadre-core/test/strand-backfill.spec.ts (new), packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/index.ts, packages/integration-tests/src/scenarios/strand-membership-closed-strand-e2e.integration.ts, docs/cadre-consistency.md, docs/architecture.md, tickets/.pre-existing-known.md
difficulty: medium
----

## What was built

The gap: on a two-node strand, blocks the founder committed *before* the second node dialled
in were never copied to it — the joiner could read the rows (the founder answered over the
wire) but held no physical copy, so the data depended on the founder staying online.

The fix is a new cadre-core module, `packages/cadre-core/src/strand-backfill.ts`
(`StrandBackfill`): when a strand's libp2p node opens a connection to a peer this runtime has
not yet caught up, it pushes **every block in the strand's own raw store** to that peer over
Optimystic's existing block-transfer protocol (`BlockTransferClient.pushBlocks`, reason
`'replication'`). The receiver persists through `StorageRepo.saveReplicatedBlock`, which is
monotonic and idempotent, so both ends running the catch-up simultaneously cannot regress a
revision. Per-peer debounce (default 1 s), success-only one-shot memo per runtime, chunking
by block count (64) and byte budget (1 MiB soft; 8 MiB protocol hard cap), per-push dial/response
deadlines (3 s / 10 s), `maxBlocks` ceiling (10 000, loudly logged), best-effort throughout —
nothing throws into a libp2p event handler or `buildStrandRuntime`.

Wiring: `StrandInstanceManager.buildStrandRuntime` constructs + starts one per strand when
`mode === 'networked'` && per-strand storage exists && `node.keyNetwork` exists &&
`backfill?.enabled !== false`; tracked in a private map, stopped in `releaseRuntime` *before*
the database/node teardown. `CadreNodeConfig.strandBackfill` → `StartStrandConfig.backfill` →
the module; `Libp2pNodeWithRepo` gained optional `keyNetwork`. Control network untouched (it
has its own row-level re-issue queue). Public types exported from `index.ts`.

## Validation run (all measured, 2026-08-03)

- `packages/cadre-core/test/strand-backfill.spec.ts` — 17/17 green. Covers every unit bullet
  in the source ticket: blockMeta carries source `(rev, actionId)`; uncommitted /
  unmaterialized skips; chunking by count and bytes; oversize-alone and over-protocol-cap
  skip; `maxBlocks` capping; `missing` → rejected + retry; throwing push resolves and retries;
  success memo; debounced flap → one run; start() catches up already-connected peers
  (resume path); stop() mid-run; missing `listBlockIds` inert; `enabled: false`; concurrent
  duplicate suppression. All against a fake store + captured push client — no libp2p dialled.
- Whole `@serfab/cadre-core` suite: 89/91 files green; the two red files
  (`control-revocation-reissue.spec.ts`, `control-revocation-replay.spec.ts`, 5 tests) are the
  tracked pre-existing `10-revocation-reissue-same-pk-update-unique-collision` (blocked)
  fingerprints, byte-identical to `.pre-existing-known.md`. Not touched.
- Integration (`strand-membership-closed-strand-e2e.integration.ts`, physical test): the
  existing post-dial gate kept as-is; a **new unnarrowed whole-store gate**
  (`compareBlockCoverage(founderStore, joinerStore)`, no `include`) added after it. Green run
  measured: founder holds **29** committed blocks, 15 authored/advanced since the dial;
  post-dial coverage complete in 1 ms; **whole-store coverage complete on the first poll**
  (the ~1 s debounce elapsed while the founder-only writes ran). No residue — the source
  ticket's collection-root worry did not materialize; no exclusion was needed.
- `yarn lint` 0, `yarn typecheck` 0, `yarn dep-check` exit 0 (no new hints),
  `@serfab/integration-tests` typecheck 0.

## Known-red neighbourhood (pre-existing, tracked — do not chase)

All five tests in the e2e file are listed in `.pre-existing-known.md` against blocked slugs.
Measured this pass: whole-file 2 passed / 3 failed; the physical test passed **1 of 4** runs.
The failures are `insert failed: collection default/Member/index/_uniq_1 holds committed
revision 2, but its header block read as absent` on the founder's first write after the joiner
attaches — the header-absent flavour of the tracked class
(`control-coordinator-answers-absent-without-asking-cohort` /
`strand-unique-index-sync-stale-revision`), striking in the test body *before* either physical
gate is reached. A re-measure note recording this fingerprint drift was added to
`.pre-existing-known.md` (same root cause, not re-triaged). The sibling `../quereus` tree was
rebuilt mid-pass when the stale-build guard tripped on someone else's in-flight edits there.

## Deliberate deviations from the ticket's interface (each with a reason)

- `StrandBackfillResult` gained `oversized: string[]` — a block whose wire size alone exceeds
  the 8 MiB protocol cap is skipped; naming it in the result (not only the log) honours the
  no-silent-caps rule.
- `StrandBackfillDeps` gained optional `createPushClient` — the injection seam the ticket's
  own unit-test plan requires ("inject the client factory"); defaults to a real
  `BlockTransferClient`.
- `MAX_BLOCK_MESSAGE_BYTES` is a local mirror constant (8 MiB): upstream defines it in
  `db-p2p/src/protocol-limits.ts` but does **not** re-export it from the package index, and
  `../optimystic` is read-only from here. Keep in sync if upstream changes it.
- The oversize check compares the **base64 wire size** (`ceil(raw/3)*4`), not the raw JSON
  length — `pushBlocks` base64-encodes into the JSON request, so raw-length comparison would
  overshoot the cap.

## Review focus — where to push

- **Capped runs still mark the peer done.** After a clean push of `maxBlocks` blocks the peer
  enters the success memo even though `capped > 0` (loudly logged). Rationale: retrying
  re-pushes the same enumeration prefix forever without progress. A reviewer may prefer
  not-done + relying on the log; the trade is re-copying 10 000 blocks per reconnect.
- **`capped` counts every remaining listed id**, including ones that would have been skipped
  as uncommitted/unmaterialized — an approximation (no metadata reads past the ceiling),
  documented at the site.
- **Delete tombstones are not pushed.** A block whose latest revision is a delete materializes
  to nothing → skipped as `unmaterialized`; a pre-join whole-block delete would not reach the
  joiner from this path and would fail the new whole-store gate if one ever appears. Tripwire
  `NOTE:` at the skip site in `strand-backfill.ts`; nothing deletes whole blocks pre-join
  today.
- **Both-ends-at-once + push racing a live commit** rest on upstream guarantees
  (`saveReplicatedBlock` monotonic, same per-block commit latch as commit). Evidence is the
  green integration run; no dedicated stress test.
- **`quiesceStrand` → `resumeStrand`** resets the memo (intended — a resumed node may have
  missed writes), so a hibernation-thrashing node re-copies per resume, bounded by
  `maxBlocks`. Unit-covered via the start()-walks-existing-connections test; no integration
  coverage of an actual resume with backfill.
- **Non-member peers**: no membership gate, by design — anything on the strand's own libp2p
  network already receives cohort replicas of new commits; stated in the module comment.

## Tripwires left in code (index only — analysis at the sites)

- `strand-backfill.ts` top: whole-store copy is right at party-scale meshes; filter by FRET
  cohort responsibility if strand meshes get large. Also: module lives here only because
  `../optimystic` is read-only; delete it if upstream grows its own cohort-join catch-up.
- `strand-backfill.ts` unmaterialized skip: delete-tombstone gap (above).
- e2e physical test comment: if a whole-store residue ever appears, narrow only with an
  explicit measured id exclusion, never a blanket post-dial narrowing.

## Docs updated

- `docs/cadre-consistency.md` → *What Ships Today*: the strand-side paragraph now records the
  catch-up (mechanism, 29/29 measurement, row-vs-block contrast with the control queue) and
  keeps the pre-fix 9-of-27 measurement as history.
- `docs/architecture.md` → *Replication cluster size*: the offline-member catch-up bullet now
  lists three paths — read repair, the control re-issue queue, and the strand-only peer-join
  block catch-up.
