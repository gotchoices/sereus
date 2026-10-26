description: Optimystic 1.19.0 changed how one machine hands a batch of stored blocks to another, and Sereus still uses the old form, so a newly added machine is sent nothing it can accept and never starts its shared workspaces. Switch to the new form and require Optimystic 1.19.0.
architecture: docs/architecture.md#replication-cluster-size
files: packages/cadre-core/src/peer-join-backfill.ts (`flush` ~840-875, `readOffer` ~930-970, `base64WireBytes` ~406-412, local `MAX_BLOCK_MESSAGE_BYTES` ~187-193, `Chunk` type ~385-404, `maxChunkBytes` doc ~225, `oversized` doc ~331), packages/cadre-core/test/peer-join-backfill.spec.ts (fake client ~214, wrappers ~855, ~965), packages/*/package.json + yarn.lock (`@optimystic/*` floors), ../optimystic/packages/db-p2p/src/cluster/block-transfer-service.ts (`pushBlocks` ~523, read only), ../optimystic/packages/db-core/src/network/block-size.ts (`MAX_BLOCK_BYTES`, `jsonEncodedBytes`, read only), ../optimystic/packages/db-p2p/src/protocol-limits.ts (read only)
repro: verified
----
GitHub #52 (kjeib, Sereus Health). Optimystic 1.19.0 (`a-block-copy-travels-unencoded`) changed `BlockTransferClient.pushBlocks` from

```ts
pushBlocks(blockIds: BlockId[], buffers: Uint8Array[], reason, certification, options)
```

to

```ts
pushBlocks(blocks: Record<BlockId, IBlock>, reason?, certification?: PushCertification, options?)
```

Blocks now travel as JSON objects inside the request, not as base64 text. The reply names the block ids that were not kept (`missing`).

## Failure

cadre-core 1.18.0 declares `@optimystic/*` `^1.18.0`, so a fresh install resolves 1.19.0. The peer-join catch-up (`PeerJoinBackfill.flush`) passes `(ids, buffers, 'replication', certification, deadlines)`. Upstream reads the array of ids as the blocks record, so the receiver sees keys `'0'…'63'`. It reports all of them `missing` and keeps none (`accepted=0 missing=64`). A newly claimed node therefore never receives the `Strand` row, and its strands never start. The reporter confirmed that converting the call locally fixes the join.

Reproduced here: against the linked 1.19 workspace, `yarn workspace @serfab/cadre-core typecheck` fails with `src/peer-join-backfill.ts(850,53): error TS2554: Expected 1-4 arguments, but got 5` and `test/peer-join-backfill.spec.ts(214,5)` (the fake client's shape). The integration scenarios that join a late machine fail the same way at runtime.

## Required behaviour

- The catch-up sends each chunk as `Record<BlockId, IBlock>`: the materialized block that `readOffer` already reads (`storage.getMaterializedBlock`). It no longer `JSON.stringify`s and encodes the block into a buffer only to have the buffer re-parsed. Keep the certification (`blockMeta`, `blockProofs`), the reason (`'replication'`), the deadlines and the reply handling (`missing` is per block id) exactly as they are.
- **Size accounting follows the new wire form.** A block's wire cost is now its JSON-encoded size, not base64 of it. Measure it with db-core's exported `jsonEncodedBytes`, so Sereus and upstream count the same bytes. `base64WireBytes` goes away. The chunk byte budget (`maxChunkBytes`, default 1 MiB) and the per-block oversize skip are judged against that measure.
- **The oversize limit comes from upstream, not a mirrored constant.** Since 1.19.0 a writer refuses any block larger than `MAX_BLOCK_BYTES` (exported from `@optimystic/db-core`), and upstream sizes the push frame so that one block of that size, plus its meta and proof, fits. Skip a block as `oversized` when it exceeds `MAX_BLOCK_BYTES`, and delete the local `MAX_BLOCK_MESSAGE_BYTES` mirror if nothing else needs it. If something does, check whether `@optimystic/db-p2p` now exports it before keeping a copy. The existing NOTE about envelope allowance becomes obsolete once the limit is upstream's per-block one; rewrite or drop it to match.
- **Floors.** This code does not work against 1.18.x, so bump every `@optimystic/*` range to `^1.19.0` in the same change (`yarn upgrade:optimystic`, then `yarn check:dep-ranges`). The adoption ticket (`adopt-optimystic-1-19-0`) does the rest of the 1.19.0 pass: measurements, release notes, docs, board.

## Edge cases & interactions

- A chunk that ends up empty after skips is still never sent (existing `flush` guard). Verify by inspection.
- A single block larger than `maxChunkBytes` but within `MAX_BLOCK_BYTES` still ships alone in its own chunk, as now. Covered by the existing spec case for that, updated to the new measure.
- Duplicate ids cannot occur in one record: `listBlockIds` yields each id once, so a record keyed by id drops nothing. Verify by inspection; if it can yield a duplicate, the later read must win, matching the memo.
- The receiver's `missing` list is compared against the ids that were sent (`Object.keys` of the record), not array indexes. That comparison is the point of #52; the spec's fake client must assert it receives real block ids.
- `recordReply` and `reportAccepted` (which feeds `reportBlockHeld`) take the ids that were actually sent, unchanged.
- Other callers of the block-transfer client, if any appear in `grep -rn "BlockTransferClient\|pushBlocks" packages/*/src`: convert them too.

## Tests

- Update the fake client in `peer-join-backfill.spec.ts` to the new signature. Make it record the keys it receives, and add one assertion in an existing chunk test that the pushed keys are the offered block ids (the #52 regression, at the lowest layer that shows it).
- No new scenario. The late-join integration scenarios (`strand-late-cadre-join`, `control-offline-read-after-restart`, `strand-membership-closed-strand-e2e`'s physical-replication test) are the end-to-end check; run them.

## TODO

- Convert `flush` and the `Chunk` type to collect `Record<BlockId, IBlock>`; drop the buffer encode in `readOffer`.
- Replace `base64WireBytes` and the local `MAX_BLOCK_MESSAGE_BYTES` with `jsonEncodedBytes` and `MAX_BLOCK_BYTES`; update the doc comments at ~225 and ~331 and the NOTE in `readOffer`.
- `yarn upgrade:optimystic`; `yarn check:dep-ranges`.
- Update the spec's fake client and wrappers; add the key assertion.
- `yarn lint`, `yarn typecheck` (all workspaces), cadre-core tests, rebuild cadre-core (stale-build guard), then the three integration scenarios above.
- Check `docs/architecture.md` and `docs/cadre-consistency.md` for any statement about the catch-up's wire encoding or size limit, and correct it.
