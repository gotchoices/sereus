description: Sereus's new "strand peer book" (which lets a restarted machine find the other parties' machines again) duplicates something the ring library FRET is going to do itself. Once FRET ships it and Optimystic picks it up, remove Sereus's copy.
files:
  - packages/cadre-core/src/strand-peer-book.ts, strand-peer-book-swap.ts, strand-peer-book-protocol.ts, strand-peer-book-file.ts
  - packages/cadre-core/src/types.ts (`CadreNodeConfig.strandPeers`)
  - packages/cadre-core/src/strand-instance-manager.ts (where the book is armed and seeded)
  - packages/integration-tests/src/scenarios (the relay-only restart scenario from #18)
----

# Retire the strand peer book once FRET carries address hints

## Blocked on

**A dependency outside this repo:** `../Fret/tickets/plan/10-feat-address-hints-in-neighbor-exchange.md` (FRET `1762011`), then an `@optimystic/db-p2p` release on the FRET version that has it. The maintainer will work the FRET ticket. **Unblock when** `@optimystic/db-p2p` depends on a FRET release with signed address hints in the neighbour exchange and addresses in the exported table.

## Why

The maintainer doesn't want the duplication (2026-09-28). Sereus built its own per-strand address list and signed swap for gotchoices/sereus#18. FRET's ticket does the same job one layer down, for every FRET user, using libp2p's signed peer records.

## Do, once unblocked

1. Raise the `@optimystic/*` floor to the release carrying the new FRET.
2. Pass db-p2p `NodeOptions.persistence` for each strand node, so the FRET table, now with addresses, survives a restart. Store it in the node's own storage, the way the peer book is stored today.
3. Remove the strand peer book, its swap and protocol, the file store subpath, and `CadreNodeConfig.strandPeers`. There's no backwards-compatibility obligation; say so in the release note, and tell embedders what replaces the `strandPeers` store they were passing.
4. Keep `joined-strand-store.ts`. Remembering joined strands is separate and stays.
5. **The #18 restart scenario must pass unchanged,** in both arms: in-process and two OS processes. That is the proof the replacement covers what the book did. Also check that formation-carried addresses still get dialled on the first attach.
6. Close or fold `backlog/debt-strand-peer-book-remote-write-bounds`; its protections are required in the FRET ticket.
7. Update the docs that describe the peer book: `docs/strands.md`, `docs/architecture.md`, and the release notes.

## Unblocked (2026-09-30)

FRET 1.0.0 (`p2p-fret`, Fret 92864ce) carries the address hints: `address-hints-live-exchange` (signed peer records in the neighbour exchange) and `address-hints-persisted-table` (addresses in the exported table). `@optimystic/*` 1.8.1 requires `p2p-fret ^1.0.0` (optimystic a43d83f9). Read those two completed FRET tickets (`../Fret/tickets/complete/10-address-hints-live-exchange.md`, `10.5-address-hints-persisted-table.md`) for the API and limits before planning. Step 1 below becomes: raise the `@optimystic/*` floor to `^1.8.1`.

Before deleting the peer book, confirm on the #18 scenario that FRET's hints plus db-p2p `persistence` alone re-converge both arms. If they do not, stop and report what is missing, and don't delete the book on a partial replacement.
