----
description: Finish the revocation re-issue work by updating the tests that pinned the old "tombstones are immutable" rule and adding coverage for the new re-issue path and revocation-filtered membership reads. The production code is already written and type-checks.
prereq:
files: packages/cadre-core/test/control-revocation-replay.spec.ts, packages/cadre-core/test/cadre-node-authorized-surface.spec.ts, packages/cadre-core/test/control-constraint-helpers.ts, packages/cadre-core/test/device-token-registry.spec.ts (pattern reference ~284-310), packages/cadre-core/src/control-database.ts (queryRevocations ~794, reissueRevocations ~1395, deleteGuardedRow ~1325, queryCadrePeers ~667, queryPeerRecord ~826), packages/cadre-core/src/control-schema.ts (Revocation table ~646-741), schemas/control.qsql, packages/cadre-core/src/cadre-node.ts (listAuthorizedMembers ~3851)
difficulty: hard
----

## State — production code is DONE, tests are NOT

Continuation of `control-revocation-reissuable-tombstone`. A prior run implemented all
production code (Phases 1–3); `yarn typecheck` passes in `packages/cadre-core`. This run
(second continuation) did the test-design investigation below but made ZERO code edits —
budget ran out before writing. **`yarn test` has NOT been run.** The working tree has no
changes from this ticket's work.

What landed earlier (do not redo):

- **Schema** (`schemas/control.qsql` + identical text in
  `packages/cadre-core/src/control-schema.ts`): `Revocation` gained
  `ReissuedAt integer not null default 0`; old `Immutable` REPLACED by `NoDelete`,
  `FreshTombstone`, `ReissueOnly`, `AuthorizedReissue` (digest
  `digest('CadreControl.Revocation', 'reissue', new.TableName, new.RowKey, new.StampId,
  cast(new.ReissuedAt as text))`; TS side signs `String(reissuedAt)`).
- **`control-authorization.ts`**: `'reissue'` in `ControlAction` union.
- **`types.ts`**: `RevocationRow` exported.
- **`control-database.ts`**: `deleteGuardedRow` inserts `ReissuedAt` literal 0;
  `queryRevocations()`; `reissueRevocations(rows, reissuedAt, ownerKey, signMessage)`
  (signatures minted before locked body, one transaction, `where StampId = ?` ALONE —
  do not add TableName, composite-PK point-lookup hazard comment at statement);
  `queryCadrePeers()` + `queryPeerRecord()` drop revoked stamps, reading through
  `queryRevokedStamps` deliberately so tests can interpose; `queryStampId` stays RAW.
- **`cadre-node.ts`**: `listAuthorizedMembers` no longer self-filters; docs updated —
  revocation now removes a peer from the ADDRESSABLE surface too, by design.

## Investigation findings this run (verified against current tree — trust these)

- **Schema constraint text confirmed** at `control-schema.ts` ~646-741 exactly as
  described above. Key detail: `Revocation.Authorized` (INSERT digest, 'remove' tag,
  fields TableName/RowKey/StampId) does NOT cover `ReissuedAt` — so a FreshTombstone
  probe can be fully owner-signed over the insert digest and `FreshTombstone` is the
  single rejector for an explicit non-zero `ReissuedAt` insert (orphan stamp keeps
  `RowIsGone` green; no other insert constraint can fire).
- **Other `Immutable` hits are OTHER tables — do not touch**:
  `strand-member-revocation.spec.ts` drives `Strand.Revocation` (strand schema, own
  `Immutable`, unaffected — verified at its ~850-878); `control-devicetoken-stamp-constraint.spec.ts` /
  `control-cadrepeer-voucher-constraint.spec.ts` / `strand-membership-invite.spec.ts` /
  `control-authorization-binding.spec.ts` reference DeviceToken/CadrePeer/CancelledInvite
  `Immutable` constraints — all unaffected. The ONLY spec pinning
  `CadreControl.Revocation`'s old `Immutable` is `control-revocation-replay.spec.ts`
  (~45, ~1040-1065, ~1069).
- **Fakes elsewhere are fine**: `cadre-node-control-cohort.spec.ts:77` and
  `membership-gate-helpers.ts:87,111` stub `queryRevokedStamps` (goes unused on
  membership path now; still used by `resolveDeviceToken`). `cadre-node.spec.ts`,
  `cadre-node-strand-seed.spec.ts`, `cadre-node-control-replication.spec.ts` fake
  `queryCadrePeers` WITHOUT `queryRevokedStamps` — those now work (node no longer calls
  it on membership reads). Only `cadre-node-authorized-surface.spec.ts` needs edits.
- **In update/delete probes use `where StampId = ?` ALONE** — the replay spec's old test
  used `where TableName = ? and StampId = ?`, which is the composite-PK point-lookup
  hazard shape (see comment in `reissueRevocations` + backlog ticket
  `debt-composite-pk-point-lookup-unreliable-untracked`). Production deliberately keys
  on StampId alone; the tests should too, including the final still-there `select`.
- **CHECK constraints are deferred to commit** (per `expectConstraintFailure` doc in
  `control-constraint-helpers.ts`) — so in the batch-rollback test all per-row UPDATEs
  execute before commit fails; rollback assertions hold regardless of row order.

## TODO — all edits, none started

### 1. Lift shared helpers into `control-constraint-helpers.ts`

Move from `control-revocation-replay.spec.ts` (defined there at ~67-90, ~117-119):
`KeyPair` interface, `freshKeyPair()`, `freshStamp` (`randomBytes(256, 'base64url')`),
`signAs()` (raw-bytes signer), `signB64()` (digest-string signer), `revocationMessage()`
('remove'-tag insert digest). Add new `reissueMessage(tableName, rowKey, stampId,
reissuedAt: number)` = `buildAuthorizationMessage('CadreControl.Revocation', 'reissue',
[tableName, rowKey, stampId, String(reissuedAt)])` with a doc noting the
`String()` ↔ `cast(... as text)` pairing. Helper file needs imports from
`@optimystic/quereus-plugin-crypto` and `../src/control-database.js`
(`buildAuthorizationMessage`). Then update the replay spec to import these (drop its
whole `@optimystic/quereus-plugin-crypto` import and the local definitions; it keeps
`buildAuthorizationMessage` for its other message builders).

### 2. `control-revocation-replay.spec.ts` — three comment/test edits

- Header bullet ~45: "`RowIsGone` / `Immutable` (on Revocation)" → name
  `RowIsGone` / `NoDelete` / `FreshTombstone` / `ReissueOnly`, one clause on the
  counter being the only mutable column, pointer to `control-revocation-reissue.spec.ts`
  for the re-issue coverage. Header note ~59-62 ("if the Authorized section keeps
  growing, split") — note the split happened (re-issue spec exists, helpers lifted).
- Test ~1040 "a tombstone is permanent — ... (Immutable)": replace with three
  single-rejector probes against one orphan tombstone
  (`tombstoneStamp('CadrePeer', '12D3KooWOrphanTombstoneTarget', orphan)`):
  - unsigned `delete from CadreControl.Revocation where StampId = ?` → `NoDelete`;
  - `update ... with context OwnerKey/Signature set StampId = ?, ReissuedAt = 1 where
    StampId = ?` with founder signature over the NEW values via `reissueMessage(...,
    rotatedStamp, 1)` — `AuthorizedReissue` passes, counter moves upward, so the
    identity clause of `ReissueOnly` is the single rejector;
  - unsigned counter-only bump `update ... set ReissuedAt = 1 where StampId = ?` —
    `ReissueOnly` passes (identity untouched, upward), so → `AuthorizedReissue`.
  - Final assert: row still present with `ReissuedAt = 0` (select by StampId alone).
- Section comment ~1069: "`RowIsGone` and `Immutable` above" → the new names.
- Existing raw tombstone INSERTs omit `ReissuedAt` → default 0 → keep passing; no
  edits there.

### 3. `cadre-node-authorized-surface.spec.ts`

- `inject()` ~71-82: fake `queryCadrePeers` must model the new DB contract — pre-filter:
  `opts.members.filter(row => row.stampId === null || !revoked.has(row.stampId))` where
  `revoked = opts.revoked ?? new Set()`. Keep `queryRevokedStamps` returning `revoked`
  (models the DB surface; unused on this path now). Comment that the filter lives in
  the REAL `ControlDatabase.queryCadrePeers` and the fake mirrors that contract.
- Test ~218-241 "drops a fully valid, anchored voucher...": assertions on the
  authorized surface unchanged; the final `isMember(A)` assertion INVERTS to
  `toBe(false)` with its comment rewritten — revocation removes the peer from the
  addressable surface too, by design. Rework the "Mock-level is the ONLY place..."
  comment: coexistence still models the convergence race, but the filter now sits in
  `queryCadrePeers` (fake mirrors it) rather than in the node.
- File header ~8-19: add that a retired-stamp peer is on NEITHER surface; filter
  inherited from `ControlDatabase.queryCadrePeers`.

### 4. New spec `packages/cadre-core/test/control-revocation-reissue.spec.ts`

Fixture: per-test `CadreNode` boot copied from replay spec `beforeEach` ~453-469
(partyId prefix `revocation-reissue-`, `profile: 'transaction'`,
`db.ensureOwnerKey(founder.publicKey)`, `rawDb = db.getDatabase()`, afterEach
`node?.stop()`, 60_000 timeouts). Local helpers (need `rawDb`/`founder` closure):
`rawTombstone` / `tombstoneStamp` (copy from replay ~300-330; insert WITHOUT
ReissuedAt column → default 0), `rawReissue(contextOwner, signature, stampId,
reissuedAt)` = counter-only update keyed on StampId alone,
`reissueSig(tableName, rowKey, stampId, reissuedAt)` = `signAs(founder,
reissueMessage(...))`, `readTombstone(stampId)` = `rawDb.get('select TableName,
RowKey, StampId, ReissuedAt from CadreControl.Revocation where StampId = ?')`.
Imports: `generateKeyPair` from `@libp2p/crypto/keys`, `peerIdFromPrivateKey` from
`@libp2p/peer-id` (read-path tests), lifted helpers, `CadreNode`, types.

Header doc: split provenance (replay spec's note), why ReissuedAt exists (a tombstone
committed while alone is local-only; re-WRITING it is what re-broadcasts it; counter
carries no read-side semantics), the four constraint names.

Tests (all tombstones against ORPHAN stamps unless stated — that is the normal
converged-tombstone-only case, a re-issue files no delete):

- happy path: `tombstoneStamp('CadrePeer', rowKey, stamp)`, then
  `rawReissue(founder.publicKey, reissueSig('CadrePeer', rowKey, stamp, 1234), stamp,
  1234)`; `readTombstone` shows identity triple untouched, `ReissuedAt === 1234`
  (this also proves the `String()` ↔ `cast(as text)` digest pairing at the raw-SQL
  level).
- identity frozen (→ `ReissueOnly`): three probes, each `set <col> = ?, ReissuedAt = 1`
  with founder signature over the NEW values (so `AuthorizedReissue` passes): change
  StampId → fresh stamp; change RowKey → other key; change TableName → 'OwnerKey'.
  After each, row unchanged at ReissuedAt 0.
- monotonic (→ `ReissueOnly`): legit reissue to 5; then signed equal (5) refused,
  signed lower (3) refused, signed higher (6) accepted and lands.
- authorization (→ `AuthorizedReissue`): counter bump signed with the 'remove' digest
  (`revocationMessage`) refused — action-tag separation; bump signed by a non-owner
  (stranger key, correct reissue digest, context names stranger) refused.
- `NoDelete`: owner-signed delete (context + valid `revocationMessage` signature)
  refused — even the owner cannot withdraw; row still present. (Replay spec pins the
  unsigned shape; NoDelete is the only on-delete constraint, so both are single-rejector.)
- `FreshTombstone`: owner-signed insert (valid `revocationMessage` signature — digest
  does not cover ReissuedAt) with explicit `ReissuedAt = 7` refused; row absent.
- `db.reissueRevocations` batch: seat three orphan tombstones; `rows =
  await db.queryRevocations()` (assert length 3); batch reissue at 1000 returns 3 and
  all three read 1000 (one transaction); single-row reissue of C at 2000; then batch
  ALL THREE at 1500 → `expectConstraintFailure(..., 'ReissueOnly')` (C's counter is
  stale) and afterwards A=1000, B=1000 (rolled back), C=2000 — proves whole-batch
  rollback and error surfacing (`lockedWithRetry` classifier re-presents only
  transient failures, so the refusal propagates).
- read paths, production removal: `node.initializeSeedBootstrap(founder.privateKey)`;
  `generateKeyPair('Ed25519')` → `peerIdFromPrivateKey(...).toString()`;
  `node.authorizePeer(peerId, ['/ip4/192.168.1.100/tcp/4001'])`; capture stamp via
  `db.queryCadrePeerStampId`; `node.removePeer(peerId)` → `queryCadrePeers()` omits,
  `queryPeerRecord(peerId)` null, `queryRevokedStamps('CadrePeer')` has stamp; then
  `node.authorizePeer` again → peer reappears with a FRESH stamp (assert `!==` old).
  (Precedent: replay spec ~1317-1329.)
- read paths, planted-at-retired-stamp: NOT constructible with real writes (both
  constraint orders forbid it) — authorize a peer (row LIVE, stamp S), then wrap
  `db.queryRevokedStamps` per `device-token-registry.spec.ts` ~294-311 (bind original,
  reassign, restore in `finally`; add S for 'CadrePeer' only): while wrapped,
  `queryCadrePeers()` omits the peer, `queryPeerRecord` null, but
  `db.queryCadrePeerStampId(peerId)` still returns S (deliberately RAW —
  insert-if-absent guards need physical presence). After restore, row fully visible
  again.

### 5. Validation (from `packages/cadre-core`)

`yarn test 2>&1 | tee /tmp/cadre-core.log`, `yarn lint`, `yarn typecheck`. Do NOT run
the integration suite (belongs to follow-up `control-revocation-drain-on-growth`;
several scenarios already failing upstream — see `tickets/.pre-existing-known.md`).
Other specs touching the changed read paths may surface failures — triage; failures
caused by this change are yours to fix, not pre-existing.

### 6. Handoff

On completion write the review/ ticket for the WHOLE feature (schema + database + read
paths + tests), noting the review stage should treat the original ticket
`control-revocation-reissuable-tombstone` (deleted; see git history at commits
d1aac1c/a0b0f82/4d470e1) as the spec.
