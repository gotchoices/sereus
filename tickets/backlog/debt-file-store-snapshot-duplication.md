---
description: Two small files that save settings to disk were written as near-identical copies of each other, so any fix to how saving works has to be made twice and can drift.
files: packages/cadre-core/src/trusted-owner-store-file.ts, packages/cadre-core/src/bootstrap-peer-store-file.ts, packages/cadre-core/src/fs-atomic.ts
difficulty: easy
---

# Two file-backed stores duplicate the same snapshot-write machinery

`trusted-owner-store-file.ts` and `bootstrap-peer-store-file.ts` are the same file with
different payloads. Shared, line-for-line: the on-disk envelope (`version` / `partyId` /
a record of entries), the envelope validator, the file-name and temp-file-name builders,
the load-failure policy (missing / corrupt / unknown shape / wrong party ⇒ start empty;
present-but-unreadable ⇒ throw), the serialised write chain, and the full-snapshot
atomic write.

They diverge in only two places, both intentional: the payload type, and whether a
single bad entry discards the whole file (the trusted-owner anchor rejects the file; the
bootstrap-peer store drops the entry and keeps the rest).

Nothing is broken. The cost is that every future change to how these files are written or
recovered — a lock for concurrent writers, a version-2 migration, a different
unreadable-file policy — has to be made twice, and the second copy is the one that gets
forgotten. A third store of this shape (the mobile and browser backends are already
planned) would make it three.

## Expected outcome

One shared implementation of "party-scoped JSON snapshot file with an atomic replace and
a serialised write chain" that both stores use, with the per-entry validation and the
one-bad-entry policy supplied by each store. `fs-atomic.ts` is where the shared
filesystem primitives already live and is the natural home.

Worth doing before the mobile/browser backends land, not after.
