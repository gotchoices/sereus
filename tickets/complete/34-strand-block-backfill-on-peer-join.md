----
description: A second machine joining a shared strand now receives a copy of everything written before it connected, not just what comes after — reviewed, hardened against a wasted-dial case, and measured working end to end.
prereq:
files: packages/cadre-core/src/strand-backfill.ts, packages/cadre-core/test/strand-backfill.spec.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/index.ts, packages/integration-tests/src/scenarios/strand-membership-closed-strand-e2e.integration.ts, docs/cadre-consistency.md, docs/architecture.md, tickets/.pre-existing-known.md
----

## What shipped

A strand peer that dials in after blocks were already committed used to hold no physical
copy of them — it could read the rows only because the founder answered over the wire, so
the data died with the founder. `packages/cadre-core/src/strand-backfill.ts`
(`StrandBackfill`) closes that: when a strand's libp2p node opens a connection to a peer
this runtime has not yet caught up, it pushes every block in the strand's own raw store to
that peer over Optimystic's block-transfer protocol (`BlockTransferClient.pushBlocks`,
reason `'replication'`). The receiver persists through `StorageRepo.saveReplicatedBlock`,
which is monotonic and idempotent, so both ends running the catch-up at once cannot regress
a revision.

Guards: per-peer debounce (1 s default), success-only one-shot memo per runtime, chunking by
block count (64) and byte budget (1 MiB soft, 8 MiB protocol hard cap), per-push dial and
response deadlines (3 s / 10 s), a `maxBlocks` ceiling (10 000, loudly logged), and a bail
on a peer that answers nothing. Best-effort throughout — nothing throws into a libp2p event
handler or into `buildStrandRuntime`.

`StrandInstanceManager.buildStrandRuntime` constructs and starts one per strand when the
strand is `networked`, has per-strand storage, the node exposes a `keyNetwork`, and
`backfill?.enabled !== false`; `releaseRuntime` stops it before the database and node come
down. Config threads `CadreNodeConfig.strandBackfill` → `StartStrandConfig.backfill` → the
module. The control network deliberately does not run it — it has its own row-level re-issue
queue (`drainPendingControlReplication`).

## Review findings

### Fixed in this pass (minor)

- **A peer that cannot receive burned one dial timeout per chunk, for the whole store.**
  The block-transfer protocol id is namespaced per strand (`/optimystic/strand-<id>/…`), so
  any peer the strand node connects to that is *not* on this strand — a bare circuit relay,
  a bootstrap node — fails every dial. The original loop pushed the remaining chunks anyway:
  at defaults that is up to 157 failed dials × 3 s per `connection:open` from such a peer,
  with a full store read behind it. `runCatchUp` now abandons the run once a push has failed
  *and* no push has yet been answered. Deliberately narrowed to that case: a peer that has
  already answered one push demonstrably speaks the protocol, so a later failure is a
  transient blip and the rest of the store is still worth sending — a blanket
  break-on-first-failure would have made a momentary stream reset leave a healthy peer far
  more partially copied than before. Two tests added: `abandons the run after the first
  failed chunk…` and `keeps pushing after a mid-run chunk failure…`.
- **The block-transfer prefix was a second hand-written literal.**
  `strand-instance-manager.ts` passed `networkName: \`strand-${strandId}\`` to
  `createLibp2pNode` and separately spelled `protocolPrefix: \`/optimystic/strand-${strandId}\``
  to the backfill. Those must agree or every push dials a protocol nobody handles, and
  nothing would have caught a drift but the integration test. Both now derive from one
  `networkName` binding. Removed the adjacent dead `_protocolPrefix = '/sereus/strand/…'`
  local, whose comment ("createLibp2pNode may not support it yet") directly contradicted the
  working prefix six lines below it.
- **Event handler typed structurally.** `onConnectionOpen` was declared as
  `CustomEvent<{ remotePeer: PeerId }>`; libp2p's `connection:open` carries a `Connection`.
  Now typed against the real payload. Also `start()` read `getConnections()` twice.
- **A comment overclaimed teardown.** `releaseRuntime`'s note said stopping the backfill
  first means "no catch-up push is issued against a torn-down transport" — true of *new*
  pushes, but an in-flight one is not awaited. Corrected to say so.
- **`docs/architecture.md` still advertised the gap as open**, pointing readers at
  `backlog/debt-strand-no-backfill-of-pre-membership-blocks` — the very ticket this work is.
  Rewritten to describe the two claims the physical test now gates. (The two docs the
  implement pass updated, `cadre-consistency.md` and the `architecture.md` replication-size
  section, were re-read and are accurate.)
- **A measurement in the e2e comment no longer held.** It recorded whole-store coverage
  "complete on the FIRST poll". Across five green runs here the gate legitimately waits
  ~510–530 ms — the tail of the debounce. Not a defect (the comment already allowed for a
  wait), but the phrasing invited someone to tighten the gate. Replaced with the measured
  range and an explicit "waiting is correct here".

### Filed as tickets

None. Every finding was either fixable in place or genuinely conditional. The two candidates
that looked ticket-shaped both resolve to "correct now, and the fix if it stops being correct
is a different mechanism, not a tweak" — recorded as tripwires instead, below.

### Tripwires recorded (conditional — knowledge, not queued work)

New this pass:

- `strand-backfill.ts`, at the `done.add` site — a run that hit `maxBlocks` still memoizes
  the peer, so the tail past the ceiling never reaches it. Deliberate (enumeration is not
  resumable, so not memoizing re-pushes the same prefix forever without advancing), loud in
  the log, and the real fix if a strand store can reach 10 000 blocks is a resumable cursor.
- `strand-backfill.ts`, module header — a failed run is retried only when that peer next
  opens a connection, so over a stable connection a transient failure leaves a peer partially
  copied until reconnect. If long-lived strand connections make that matter, re-arm the
  debounce with a backoff.
- `strand-backfill.ts`, module header — the per-connection cost of a non-strand peer, and the
  `peerStore` protocol pre-check that would remove it if strand nodes ever hold many such
  connections.
- `strand-backfill.ts`, at the oversize check — `MAX_BLOCK_MESSAGE_BYTES` caps the whole
  framed request, but the check measures one block's base64 size and ignores the request
  envelope. A lone block within a few KiB of 8 MiB would ship and be rejected by the
  receiver's length-prefix decoder. Nothing in a strand approaches that today.

Carried over from the implement pass, re-read and still accurate: the whole-store copy being
right only at party-scale meshes; the module living in cadre-core only because `../optimystic`
is read-only; the delete-tombstone skip; and the e2e's "narrow only with a measured exclusion"
instruction.

### Checked and clean

- **Upstream contract, verified rather than assumed.** `MAX_BLOCK_MESSAGE_BYTES` really is
  8 MiB in `db-p2p/src/protocol-limits.ts`, so the local mirror is honest. `blockTransfer` is
  registered unconditionally on every db-p2p node under `/optimystic/<networkName>` — not
  gated on FRET profile, so an `edge`-profile strand node can receive. `handlePush` persists
  via `saveReplicatedBlock` with **no** cohort-responsibility gate, which is what makes a
  whole-store push acceptable rather than mostly-rejected.
- **Security of the missing membership gate.** The module's "no membership gate by design"
  claim holds, but for a reason worth stating plainly: the protocol id is per-strand, so a
  shared public relay or bootstrap node cannot receive strand blocks even though it is
  connected. That is the actual containment; it was verified upstream, not taken on faith.
- **Lifecycle.** `startStrand` returns early on an already-tracked strand and `resumeStrand`
  returns early on a live one, so `buildStrandRuntime` cannot orphan a second backfill over
  the same id. `releaseRuntime` is the single teardown for quiesce, stop, and the build
  rollback, and stops the backfill first. No leaked listener, no leaked map entry.
- **Push-loop correctness.** `chunk` is reassigned before the awaited push (no double-send on
  a slow flush), `stopped` is re-checked per block and after every flush, a single block over
  the soft budget still ships alone rather than being dropped, and `maxBlocks` gates on
  `offered` so skipped blocks do not consume the ceiling.
- **Test quality.** The 17 unit tests genuinely cover the happy path, both skip reasons, both
  chunking dimensions, the oversize and cap paths, remote-rejection and thrown-push retries,
  the memo, the debounce, the resume-over-live-connections path, mid-run stop, the inert
  backends, and concurrent duplicate suppression — against a fake store whose every write
  method throws, which is a good guard. 19 with the two added here.

### Not fixed — stated, not silently dropped

- **No unit assertion that `releaseRuntime` stops the backfill.** `backfills` is private, and
  adding a public seam for one assertion costs more than it buys; the map has exactly one
  writer and one deleter, both read in this review. Covered indirectly by the e2e.
- **No stress coverage of both ends pushing at once, or a push racing a live commit.** These
  rest on upstream's monotonic `saveReplicatedBlock` and the shared per-block commit latch.
  Evidence remains the green integration runs. Unchanged from the implement handoff, which
  flagged it honestly.
- **The peer memo is never invalidated on disconnect.** A peer that wipes its store and
  reconnects under the same peer id is not re-copied within a runtime's lifetime. Documented
  on the `done` field; too rare to spend a mechanism on, and a quiesce/resume clears it.
- **No integration coverage of an actual quiesce → resume with the catch-up live.** The
  resume path is unit-covered (`start()` walks existing connections); the physical resume is
  not. Noted, not filed — `34.5-strand-founder-offline-durability-e2e` is the ticket already
  standing in that neighbourhood.

## Validation (all measured, 2026-08-03)

- `yarn lint` exit 0, `yarn typecheck` exit 0 (10 packages), `yarn dep-check` exit 0 with no
  hint naming any touched symbol, `@serfab/integration-tests` typecheck exit 0.
- `packages/cadre-core/test/strand-backfill.spec.ts` — 19/19 (17 from the implement pass plus
  the two added here).
- All three `strand-instance-manager*` specs plus the backfill spec — 58/58.
- Whole `@serfab/cadre-core` suite — 1480 passed, 5 failed, 1 skipped across 91 files. The
  five reds are the two tracked `control-revocation-reissue.spec.ts` /
  `control-revocation-replay.spec.ts` files, fingerprints matching
  `.pre-existing-known.md` against blocked slug
  `10-revocation-reissue-same-pk-update-unique-collision`. Untouched, not skipped, not
  loosened.
- Physical e2e (`strand-membership-closed-strand-e2e.integration.ts`, the
  `replicates the founder's blocks PHYSICALLY…` test) — 9 runs this pass: **5 green, 4 red**
  on the tracked `strand-unique-index-sync-stale-revision` header-absent fingerprint
  (`insert failed: collection default/Member/index/_uniq_1 holds committed revision 2, but
  its header block read as absent`), which strikes in the test body before either physical
  gate. Every green run: founder holds **29** committed blocks, joiner **29**; the post-dial
  gate completes in 0–1 ms and the whole-store catch-up gate in **506–526 ms**. No residue,
  no exclusion needed. That flake rate and fingerprint match what the implement pass recorded
  in `.pre-existing-known.md`; nothing re-triaged.
