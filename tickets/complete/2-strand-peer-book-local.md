description: A machine that restarts forgets the addresses of the other people's machines in a shared workspace, so it comes back up alone and stops replicating. Keep a small per-workspace address book in the machine's own storage and dial it first on every start.
prereq: strand-catch-up-skips-non-speaking-peers
architecture: docs/architecture.md#strand-address-resolution
files: packages/cadre-core/src/strand-peer-book.ts, packages/cadre-core/src/strand-peer-book-file.ts, packages/cadre-core/src/strand-peer-observer.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/node-local-snapshot.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/index.ts, packages/cadre-core/package.json, packages/cadre-core/test/strand-peer-book.spec.ts, packages/cadre-core/test/cadre-node-strand-seed.spec.ts, packages/cadre-core/test/cadre-node-strand-addr-refresh.spec.ts, packages/cadre-cli/src/commands/start.ts, packages/reference-app-rn/src/cadre-phone.ts, packages/reference-app-rn/src/node-local-slots.ts, packages/reference-app-rn/src/phone-node-config.ts, packages/reference-app-web/src/lib/cadre-web.ts, packages/reference-app-web/src/lib/node-local-slots.ts, packages/reference-app-ns/src/cadre-phone.ts, packages/reference-app-ns/src/node-local-slots.ts, packages/integration-tests/src/scenarios/strand-formation-cross-party-seed.integration.ts, docs/strands.md, docs/architecture.md
difficulty: hard
----

## What was built

gotchoices/sereus#18, maintainer decision item 1. The in-memory `crossPartyStrandAddrs` map in `CadreNode` is gone. In its place is a **strand peer book**: a node-local, never-replicated store, one per node, keyed by strand id then by strand transport peer id, holding `{ peerId, addrs, issuedAt, sig?, lastSeenAt }` per peer. It is read on every launch, hibernation resume and periodic address refresh, so a restarted machine dials the peers it was talking to before anything else.

- **Store** (`strand-peer-book.ts`): `StrandPeerBookStore { partyId; entries(strandId); merge(strandId, entry); forget(strandId, peerId?) }` with three backends mirroring `bootstrap-peer-store.ts`: `MemoryStrandPeerBookStore`, `PersistentStrandPeerBookStore.open(slot, partyId, options?)` over `node-local-snapshot.ts` (`drop-entry`, envelope `{ version, partyId, strands: { [strandId]: { [peerId]: entry } } }`), and Node-only `FileStrandPeerBookStore` behind the new subpath `@serfab/cadre-core/strand-peer-book-file` (file `strand-peers.<party>.json`). The merge rule lives in one exported pure function, `mergeStrandPeerEntry`: signed never yields to unsigned; two signed, greater `issuedAt` wins; two unsigned, greater `lastSeenAt` wins; ties go to the incoming entry; `lastSeenAt` is always the max of both. `sanitizeStrandPeerEntry` drops an unparsable peer id and keeps only addresses that attribute to the peer under `groupAddrsByPeerId`'s rule, signaling-first, capped at `MAX_STRAND_ADDRS`. Per strand: aged entries pruned (14 days from `max(issuedAt, lastSeenAt)`) at load, on every merge and on every `entries()` read; past 16 peers the stalest is evicted.
- **Writers.** `CadreNode.recordFormationStrandPeers` groups a formation result's `strandAddrs` per peer and merges each as `{ issuedAt: 0, lastSeenAt: now }`, then clears the strand's refresh throttle. A re-formation replaces the same peer's list instead of unioning onto it. `StrandPeerObserver` (`strand-peer-observer.ts`) is the second writer: one per running strand, armed in `StrandInstanceManager.buildStrandRuntime` right after the libp2p node exists, released in `releaseRuntime`. On `peer:identify` where `speaksBlockTransfer` holds it reports `listenAddrs` plus the connection's `remoteAddr` when relayed, each bound with `withTrailingPeerId`, through `StartStrandConfig.onStrandPeerIdentified`; `CadreNode.observeStrandPeer` merges it unsigned. Throttled to one report per peer per 10 minutes unless the address set changed. `start()` also walks already-connected peers via the peer store.
- **Readers.** `resolveCohortSeed` = `unionAddrs(siblingAnswers, strandPeerBookAddrs(strandId, delegatePeerId))`, freshest peer first, self skipped; `resumeStrandRuntime` goes through it. `refreshOneStrandPeerAddrs` takes its contact addresses from the book. `getStrandPeerBookStore()` beside `getBootstrapPeerStore()`.
- **Forget.** `unpublishStrand`, `forgetJoinedStrand` and self-revocation call `forget(strandId)`; `stopStrand` keeps the book. All book writes are fire-and-log like `retainDialTarget`.
- **Config.** `CadreNodeConfig.strandPeers?: { store? }`, party-mismatch fails closed at `start()`, memory default, kept across `stop()`→`start()`.
- **Embedders.** `cadre-cli start` opens `FileStrandPeerBookStore` in `nodeStateDir`; the React Native, web and NativeScript apps open `PersistentStrandPeerBookStore` over the same slot kind as their bootstrap peers under a new `strand-peers.<party>` key. cadre-host needed no code: its children run `cadre-cli start`.
- **Docs.** `docs/architecture.md` Strand-Address Resolution bullet rewritten; `docs/strands.md` gains "How a restarted machine re-finds its strand's peers" and closes the in-memory limit; `types.ts` config doc; `.release-notes.pending.md` bullet.

## Deviations from the ticket, kept

- **No `network.controlCohort.strandPeerMaxAgeMs`.** An injected store has already loaded and pruned by the time the node sees its config, so the age lives on the store: `StrandPeerBookOptions.maxAgeMs` on every backend. Reviewer agrees; a node-level knob that could not reach an injected store would mislead.
- **Own-entry aging exemption is not implemented.** Nothing writes an own entry yet; the swap ticket must name the mechanism. A `NOTE:` at `pruneAged` says so.
- **Observer armed before the database, not beside the backfill**, because the bootstrap dials land during the database bring-up. Comment at the arming site.
- **No unit test for the observer.** Its end-to-end proof is the cross-party seed scenario's book assertion.

## Review findings

Reviewed the implement-stage diff (`c6a99334`) file by file before the handoff, then read every touched source file whole, `bootstrap-peer-store.ts` and `node-local-snapshot.ts` for the pattern being mirrored, the libp2p identify source for how `listenAddrs` are shaped, and the two downstream tickets (`strand-peer-book-swap`, `scenario-relay-only-restart-reconverges`) for the expectations they place on this one.

**Checked and found sound**

- **Address binding.** libp2p identify strips the trailing `/p2p/<self>` from announced addresses (`decapsulateCode` removes the last occurrence), so a relay-only peer's circuit listener arrives as `…/p2p/<relay>/p2p-circuit`; `withTrailingPeerId` re-binds it to the observed peer. An inbound relayed connection's `remoteAddr` is `<relay conn addr>/p2p-circuit/p2p/<remote>`, which the observer keeps and the store attributes correctly. The integration scenario's `endsWith(/p2p/<joiner>)` assertion pins this on a real connection.
- **Identify push.** libp2p dispatches `peer:identify` for identify-push too, so an address change on a long-lived connection (a relay reservation landing after connect) reaches the observer and bypasses the throttle because the address set changed. Nothing waits for a reconnect.
- **Lifecycle symmetry.** The observer is registered in the manager's map before `start()`, so `buildStrandRuntime`'s rollback stops it; `releaseRuntime` stops it between the backfill and the revocation enforcer; `resumeStrand` rebuilds from the retained launch config, which carries `onStrandPeerIdentified`, so hibernation wake re-arms it.
- **Self exclusion.** The seed passes the derived strand transport id at both call sites (launch and resume), and the refresh pass passes the running node's id, so an own entry written by the swap ticket is skipped everywhere the book is read.
- **Empty address lists.** An identify observation of a strand peer with no announced addresses and a direct connection yields an empty list and, being fresher, replaces an older unsigned list. That is truthful (the old addresses are dead when the peer has no listener) and matches the swap ticket's "empty means not reachable now" rule. No change.
- **Concurrency.** Merges from several strands land through `NodeLocalSnapshot`'s write chain; the spec's concurrent-merge case covers three strands writing at once.
- **Hygiene.** Lint clean, all workspaces typecheck, no `any`, no stale references to the removed map outside a stale `dist/` type declaration in `integration-tests` that the next build regenerates. `strand-peer-book.ts` at 454 lines and the observer at 211 are within reason; `cadre-node.ts` grew by about 100 lines and is already tracked by `backlog/debt-cadre-node-single-file-size`, not re-filed.

**Minor, fixed in this pass**

- `mergeStrandPeerEntry`'s comment said callers may compare the result by identity to learn whether anything changed. It always returns a new object, so identity tells a caller nothing. Reworded to what is true: entries are never mutated in place, which the persistent backend's snapshot `put` relies on.
- `StrandPeerEntry.lastSeenAt` was documented as "when this node last held a connection", but the formation writer stamps it with the disclosure time for a peer never connected to. The field doc now names that case.
- `forgetRevokedJoin`'s comment still described the join record as a no-op for this party's own strands without mentioning that the peer book is forgotten either way. Updated.
- `node-local-snapshot.ts` still said "the two records" and named only the bootstrap-peer store for the `drop-entry` policy; now names the strand peer book as its second user.

**Tripwires parked in code**

- `strand-peer-observer.ts` → `observeConnectedPeers`: the start-walk reports peer-store addresses, which include what the refresh pass merged in from the book, so it can re-vouch a dead address the book already held until the peer's next identify replaces the set. Bounded by the address cap; the lever, if it ever shows, is reading only identify-sourced addresses there.
- Carried from the implement pass: `strand-peer-book.ts` → `mergeIntoStrand` (aging is time-based only), `pruneAged` (own-entry exemption owed by the swap ticket), `cadre-node.ts` → `mergeStrandPeerAddrs` (what ages on a slower clock).

**Considered, no action**

- **Tie rule.** A signed entry with the same `issuedAt` as the held one replaces it. Two signed statements with equal `issuedAt` from the same signer are the same statement, so this is a no-op in content; noted for the swap ticket, no code change.
- **Aged entries on the persistent store** are filtered on read and dropped physically on the next merge, so a slot can hold an aged entry until something else writes. Bounded by 16 peers per strand and by the strands a node has run; documented on the store. Not worth a load-time write.
- **Every `merge` on the persistent backend persists**, even when the entry content is unchanged. Every writer in this ticket changes `lastSeenAt`, and the observer is throttled to one report per peer per 10 minutes, so there is no wasted write today. The swap ticket's forwarded third-party entries will be the first unchanged merges; if slot writes ever show up, compare before `put`.
- **Diagnostics getters** in the web app (`getStrandPeerBookStore`) are unused, matching the unused `getBootstrapPeerStore` beside it. Left for symmetry.

**Tests.** No test cut: the store spec pins the merge rule, bounds, aging, attribution and the persistent round trip, and its two file-store tests match the bootstrap-peer-store spec's coverage of the same slot. No test added: the one defect class I looked for (a mis-bound relayed address) is already covered by the scenario's binding assertion on a live connection.

**Major findings: none.** Nothing here needs a ticket; the two known gaps (rotation while apart, third parties) are the swap ticket's stated scope, and the restart proof is the scenario ticket's.

## Validation run

- `yarn lint`: exit 0. `yarn typecheck`: clean across all workspaces plus the three coverage scripts.
- `yarn workspace @serfab/cadre-core test`: 142 files, 2317 passed, 1 skipped (`tickets/.logs/strand-peer-book-local.review.test.log`).
- `strand-formation-cross-party-seed` integration scenario, foreground after a cadre-core rebuild: 2 passed, including the book assertions on both sides (`tickets/.logs/strand-peer-book-local.review.cross-party.log`).
- Not re-run after the comment-only edits: the embedder unit suites and the other three integration scenarios the implement pass ran; no executable line changed.
