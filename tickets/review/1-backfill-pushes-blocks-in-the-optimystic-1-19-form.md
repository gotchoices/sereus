description: Optimystic 1.19.0 changed how one machine hands a batch of stored blocks to another, and Sereus still used the old form, so a newly added machine was sent nothing it could accept and never started its shared workspaces. Sereus now sends the new form and requires Optimystic 1.19.0.
architecture: docs/architecture.md#replication-cluster-size
files: packages/cadre-core/src/peer-join-backfill.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/peer-join-backfill.spec.ts, packages/*/package.json, yarn.lock, tickets/.pre-existing-error.md
repro: verified
----
GitHub #52. Optimystic 1.19.0 changed `BlockTransferClient.pushBlocks` to take `(blocks: Record<BlockId, IBlock>, reason?, certification?, options?)`, and its reply to `{ accepted, missing }`. The peer-join catch-up still passed `(ids, buffers, ...)`. The receiver read the id array as the blocks record, saw keys `'0'…'63'`, and reported every block missing.

## What changed

- **`peer-join-backfill.ts`.** A `Chunk` now holds `blocks: Record<BlockId, IBlock>`, the materialized block `readOffer` reads, instead of parallel `ids`/`buffers` arrays. `flush` derives `ids` from `Object.keys(blocks)` and passes that same list to `recordReply`, `reportAccepted` and the `missing` comparison. The certification (`blockMeta`, `blockProofs`), the `'replication'` reason, the deadlines and the reply handling are unchanged. `readOffer` no longer stringifies and encodes the block. It measures it once with db-core's `jsonEncodedBytes` and returns `{ latest, block, bytes, proof }`.
- **Size rules.** The chunk budget (`maxChunkBytes`, 1 MiB) sums `jsonEncodedBytes` per block. A block is skipped as `oversized` when its size is `> MAX_BLOCK_BYTES` (db-core, 7.5 MiB), matching the writer's own refusal (`oversizedBlock` uses `>`). `base64WireBytes`, the `blockEncoder` and the local `MAX_BLOCK_MESSAGE_BYTES` mirror are gone. `@optimystic/db-p2p` still does not export its `MAX_BLOCK_MESSAGE_BYTES` (`protocol-limits.ts` is not in its index), and nothing in Sereus needs it now. The old envelope-allowance NOTE is replaced by a plain comment: upstream sizes the push frame for one block at `MAX_BLOCK_BYTES` with its meta and proof.
- **Public API.** `MAX_BLOCK_MESSAGE_BYTES` is no longer exported from `@serfab/cadre-core` (`index.ts`). Nothing in this repo imported it. The release notes (`adopt-optimystic-1-19-0`) should list the removal.
- **Floors.** `yarn upgrade:optimystic` raised every `@optimystic/*` range to `^1.19.0` across 9 package.json files and `yarn.lock`. `yarn check:dep-ranges` passes (10 linked packages).

## Checked by inspection

- An empty chunk is never sent: `flush` returns before pushing when `Object.keys(blocks)` is empty.
- Duplicate ids: every `listBlockIds` implementation enumerates metadata keys, so each id comes once. `WriteGroupDriver.mergedBlockIds` explicitly de-duplicates its overlay against the backend. A record keyed by id therefore drops nothing.
- Other callers of `pushBlocks` / `BlockTransferClient` in `packages/*/src`: none besides the catch-up.
- Docs: neither `docs/architecture.md` nor `docs/cadre-consistency.md` says anything about the catch-up's wire encoding or size limit. "requests of up to 64 blocks" (architecture.md, Replication cluster size) is still true. `link-budget.ts`'s `PUSH_TRANSFER_ALLOWANCE_MS` comment refers to `maxChunkBytes` only and still holds. A full chunk is now about 1 MiB on the wire instead of about 1.33 MiB (base64 no longer applies).

## Tests

No new test. Changes to `peer-join-backfill.spec.ts`:

- The fake push client has the new signature. It records `ids` as `Object.keys` of the record it receives, plus the record itself, and answers `{ accepted, missing }`.
- The #52 regression check is in the first case ("copies every committed+materialized block…"). It asserts that the pushed keys are exactly `['b1','b2','b3']` and that `push.blocks[id]` equals the stored block. A push keyed by array index fails it.
- The byte-budget case sums `jsonEncodedBytes` of the pushed blocks. The oversize case is now "skips a block whose encoded size exceeds MAX_BLOCK_BYTES". Its block has a fill of `MAX_BLOCK_BYTES` characters, so its JSON is over the limit.

## Validation run

- `yarn lint`: clean. `yarn typecheck` (all workspaces plus the coverage checks): clean.
- `yarn workspace @serfab/cadre-core exec vitest run test/peer-join-backfill.spec.ts`: 37/37.
- `yarn workspace @serfab/cadre-core test`: 2541 passed, 1 failed, 1 skipped. The failure is `control-founding-consult-budget.spec.ts`, which reports "foundStrand on the control network issued only 0 commits". That spec measures one node with no peers, so the catch-up never pushes in it. The pinned count moved because the linked Optimystic is now 1.19.0, which commits a transaction's collections together (#42). It is recorded in `tickets/.pre-existing-error.md`, pointing at `implement/adopt-optimystic-1-19-0`, which already lists this budget for a measured re-pin. It was not skipped or loosened.
- `yarn workspace @serfab/cadre-core build`, then `strand-late-cadre-join`, `control-offline-read-after-restart` and `strand-membership-closed-strand-e2e`: 13/13 passed (log `tickets/.logs/backfill-pushes-blocks-1-19.it.log`). These include the physical-replication test ("replicates the founder's blocks PHYSICALLY into the joiner's own block store").

## Gaps for the reviewer

- I did not run the integration suite against the published npm 1.19.0. Only `smoke-published-install` does that, and it belongs to the adoption ticket's gate.
- A block between `MAX_BLOCK_BYTES` and the 8 MiB frame is now skipped, although the receiver does not check `MAX_BLOCK_BYTES` and might have accepted it. That follows the ticket's rule: such a block can only predate the 1.19.0 writer check, and its meta and proof may not fit beside it.
- A host that sets `maxChunkBytes` close to the 8 MiB frame can still build a multi-block chunk that, with its meta and proofs, exceeds the frame. Upstream's client then refuses it locally and the run backs off. This is not new, and the default is 1 MiB.
