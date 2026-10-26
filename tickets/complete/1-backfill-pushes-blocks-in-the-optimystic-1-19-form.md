description: Optimystic 1.19.0 changed how one machine hands a batch of stored blocks to another, and Sereus still used the old form, so a newly added machine was sent nothing it could accept and never started its shared workspaces. Sereus now sends the new form and requires Optimystic 1.19.0.
architecture: docs/architecture.md#replication-cluster-size
files: packages/cadre-core/src/peer-join-backfill.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/peer-join-backfill.spec.ts, packages/*/package.json, yarn.lock, tickets/implement/2-adopt-optimystic-1-19-0.md
repro: verified
----
GitHub #52. Optimystic 1.19.0 changed `BlockTransferClient.pushBlocks` to take `(blocks: Record<BlockId, IBlock>, reason?, certification?, options?)`, and its reply to `{ accepted, missing }`. The peer-join catch-up still passed `(ids, buffers, ...)`. The receiver read the id array as the blocks record, saw keys `'0'…'63'`, and reported every block missing.

## What changed (`ticket(implement): backfill-pushes-blocks-in-the-optimystic-1-19-form`)

- **`peer-join-backfill.ts`.** A `Chunk` holds `blocks: Record<BlockId, IBlock>`, the materialized block `readOffer` reads. `flush` derives `ids` from `Object.keys(blocks)` and uses that list for `recordReply`, `reportAccepted` and the `missing` comparison. Certification, reason, deadlines and reply handling are unchanged.
- **Size rules.** The chunk budget (`maxChunkBytes`, 1 MiB) sums db-core's `jsonEncodedBytes` per block. A block over `MAX_BLOCK_BYTES` (7.5 MiB) is skipped as `oversized`, matching the writer's own refusal. The base64 sizing and the local `MAX_BLOCK_MESSAGE_BYTES` mirror are gone.
- **Public API.** `MAX_BLOCK_MESSAGE_BYTES` is no longer exported from `@serfab/cadre-core`. Nothing in this repo imported it.
- **Floors.** Every `@optimystic/*` range is `^1.19.0` (9 package.json files plus `yarn.lock`).
- **Tests.** The fake push client in `peer-join-backfill.spec.ts` has the new signature. The first case asserts that the pushed record's keys are exactly the block ids and that each value is the stored block, which is the #52 regression check. The byte-budget and oversize cases use `jsonEncodedBytes` and `MAX_BLOCK_BYTES`.

## Review findings

**Checked against upstream.** I read `../optimystic/packages/db-p2p/src/cluster/block-transfer-service.ts`. `pushBlocks` builds `blockIds: Object.keys(blocks)` itself and frames at `MAX_BLOCK_MESSAGE_BYTES`. The receiver answers `{ accepted, missing }`, and on a fault it lists every block in `missing`. That matches the catch-up's rule: a block counts as accepted unless it is listed missing. `MAX_BLOCK_BYTES` and `jsonEncodedBytes` are db-core exports, and the docs for both say a block at the limit, with its push meta and proof, fits one frame. The `>` comparison matches `BlockTooLargeError`.

**Correctness and edge cases.** Checked by reading the code:
- An empty chunk is never pushed.
- Duplicate ids would only overwrite a record key, and `listBlockIds` does not yield duplicates. The implementer confirmed this, and I agree.
- A block over `maxChunkBytes` still ships alone.
- The stop and unreachable-peer breaks are unchanged.

`Object.keys(chunk.blocks).length` runs once per block, on at most 64 keys, so its cost does not matter. No defects found.

**Leftover references.** I searched `packages/*/src`, `packages/*/test`, `docs/` and the cadre-core README for `MAX_BLOCK_MESSAGE_BYTES`, `base64WireBytes`, `blockEncoder` and buffer-based pushes. None remain. `pushBlocks` has no other callers in Sereus. The docs don't describe the catch-up's wire encoding. "requests of up to 64 blocks" in `docs/architecture.md` is still true.

**Tests.** The modified spec cases pin the #52 contract and the size rules; none restate the implementation. Nothing cut, nothing added.

**Gap found and fixed.** The adoption ticket's release-notes task left out the removed export. I added a line to `implement/adopt-optimystic-1-19-0` under "Release notes" naming the removal and its replacement (`MAX_BLOCK_BYTES` from `@optimystic/db-core`).

**Tripwires and tickets.** None filed. The implementer named two gaps, and both are already covered:
- A block between `MAX_BLOCK_BYTES` and the 8 MiB frame is skipped on purpose. The comment in `readOffer` gives the reason.
- A host that sets `maxChunkBytes` near the frame size predates this change. The default is 1 MiB, and upstream refuses an over-frame push locally, so the run backs off rather than corrupting anything.

**Pre-existing failure.** `control-founding-consult-budget.spec.ts` failed during the implement stage. Triage fixed it in `tess: triage pre-existing test failure`, and it passes now.

**Validation (review run):**
- `yarn lint` and cadre-core `tsc -p tsconfig.typecheck.json`: clean.
- `yarn check:dep-ranges`: passes (10 linked packages).
- `peer-join-backfill.spec.ts`: 37/37.
- Full `yarn workspace @serfab/cadre-core test`: 187 files, 2543 passed, 1 skipped, 0 failed.

The implementer's integration run (`strand-late-cadre-join`, `control-offline-read-after-restart`, `strand-membership-closed-strand-e2e`, 13/13, including physical replication into the joiner's store) was not repeated. Testing against the published npm 1.19.0 (`smoke-published-install`) belongs to the adoption ticket's gate.
