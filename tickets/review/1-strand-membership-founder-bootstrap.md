description: Review the founder-only bootstrap that writes a strand's identity record and (for private strands) enrolls the founder as first member/admin, while a node that merely joins writes nothing and relies on sync.
prereq:
files: packages/cadre-core/src/strand-membership-writer.ts, packages/cadre-core/src/strand-member-key.ts, packages/cadre-core/src/strand-database.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/strand-membership-writer.spec.ts, packages/cadre-core/test/strand-founder-bootstrap.spec.ts, docs/architecture.md
difficulty: hard
----

## What landed

The first runtime *writer* of the layer-2 `Strand.*` membership/RBAC tables (the schema
was already applied by `composeStrand` in `apply-strand-membership-schema`). On the strand's
**founder**, a one-time idempotent bootstrap runs at bring-up; a **joiner** writes nothing and
relies on Optimystic sync. Also lands the shared signing/key-bridge primitives the later
invite/peer/rotation tickets reuse.

### New module — `packages/cadre-core/src/strand-membership-writer.ts`
- `signStrandPayload(payload, privateKeyB64)` — the **single-digest** ed25519 signer the
  `Strand.*` constraints verify (`digest(payload,'sha256','utf8','bytes')` → ed25519-sign the
  raw bytes → base64url). Distinct from the control layer's multi-field
  `buildAuthorizationMessage`. **Exported and unit-tested, but NOT yet consumed by any runtime
  writer** — it is a forward primitive for the invite/peer/rotation flows (the founder rows here
  use the schema's unsigned `count(…) <= 1` bootstrap branch).
- `bootstrapFounderMembership(db, { strandId, type, sApp, founderKeyPair? })` — idempotent
  founder bootstrap: `Header` always; `Member`+`Authority` only for `type==='c'`. Validates a
  closed strand has a `founderKeyPair` **before** writing anything (so no stranded keyless
  closed `Header`). Each insert guarded by `select count(1) from Strand.<T>` (insert-if-absent).
- `STRAND_ENGINE='quereus'`, `STRAND_ENGINE_VERSION='0.1.0'` — **placeholder** Header columns
  (no engine-selection seam exists yet; documented as future work).

### Key bridge — `strand-member-key.ts`
- `strandMemberKeyPair(memberPrivateKey)` — decodes the base64-protobuf libp2p key
  (`privateKeyFromProtobuf(fromString(.,'base64'))`) and reuses `authorityKeyFromLibp2p` to get
  `{ privateKeyB64, publicKeyB64 }`. The founding `Member.Key`/`Authority.MemberKey` are that
  `publicKeyB64`.

### Plumbing
- `founder?: boolean` added to `StrandConfig` (types.ts), `StartStrandConfig`
  (strand-instance-manager.ts), `StrandDatabaseConfig` (strand-database.ts). `StrandDatabaseConfig`
  also gains required `strandType` + optional `memberPrivateKey`.
- Threaded `CadreNode.addStrand` → `launchStrand` → `StrandInstanceManager.startStrand` →
  `buildStrandRuntime` (which reads `strandRow.Type` / `strandRow.MemberPrivateKey`).
- `StrandDatabase.initialize()` calls the bootstrap **after** `connectToStrand` returns, gated
  on `founder===true`; a throw propagates so `buildStrandRuntime`'s rollback tears the strand down.
- The control-discovered join path (`handleStrandAdded` → `launchStrand` with no `founder`)
  never founds — joiners only sync.

### Docs
- `docs/architecture.md` → new "Strand Membership Bootstrap" subsection (three-layer
  reconciliation + founder/joiner behavior + key bridge + signing idiom).

## Validation performed (this is a floor, not a ceiling)

- `yarn workspace @serfab/cadre-core test` → **37 files / 493 tests pass** (incl. 13 new).
- `yarn workspace @serfab/cadre-core typecheck` → exit 0.
- `npx eslint` over all changed files → exit 0.

### Test coverage added
`test/strand-membership-writer.spec.ts` (writer + crypto, real strand DB via `connectToStrand`
in bootstrap mode + `MemoryRawStorage`):
- key-bridge round-trip (derived pubkey stable; `== getPublicKey(seed)`; sign/verify under the
  strand idiom);
- `signStrandPayload` verifies via `verify(digest(payload,'sha256','utf8'), sig, pub,'ed25519')`,
  and a wrong-payload signature fails;
- closed bootstrap → exactly one `Header(c)` + `Member` + `Authority`, all Header columns
  correct, `Member.Key == Authority.MemberKey == founder pubkey`;
- open bootstrap → one `Header(o)`, zero Member/Authority;
- re-run is a no-op (no `InsertOnly`/PK violation);
- unsigned `sApp.signature` coalesces to `''` (NOT-NULL Header column);
- closed-without-key throws and writes **nothing** (Header count 0).

`test/strand-founder-bootstrap.spec.ts` (end-to-end plumbing via `StrandInstanceManager`,
bootstrap mode):
- founder closed strand seats Header+Member+Authority from `MemberPrivateKey`;
- joiner (`founder:false`) closed strand writes nothing locally;
- founder open strand → Header(o) only;
- founding a closed strand with no `MemberPrivateKey` rejects and `releaseRuntime` tears the
  runtime down (`status==='error'`, `database===undefined`).

## Known gaps / things to probe (be adversarial)

1. **Nothing sets `founder: true` in production yet.** Per the ticket the flag is explicitly
   caller-supplied; this PR only *threads and tests* it. No real caller (formation responder,
   host attach, solo creator — wherever `publishStrand` is paired with `addStrand`) passes
   `founder:true` today, so the bootstrap does **not** fire in any existing end-to-end flow. The
   next lifecycle/invite ticket (or a host/formation wiring change) must set it. **Confirm this
   is acceptable scoping and that the follow-up is captured.**
2. **Restart idempotency tested at writer level only.** The no-op test re-runs the bootstrap on
   the *same* live connection (proves the count guards). A true cross-process restart (fresh
   `Database` over persisted storage → reopen → no duplicate `Header`) is **not** directly tested
   for the founder bootstrap, though the underlying persist/hydrate path is covered by the
   existing `strand-schema.e2e` warm-restart test and `resumeStrand` re-runs the bootstrap. A
   `FileRawStorage` reopen assertion would close this.
3. **Founder-vs-joiner race is isolated, not networked.** The joiner test asserts "writes
   nothing locally" in bootstrap mode with no sync. The real two-node networked case (founder
   bootstraps → joiner receives rows via sync, count stays 1) is **deferred** to integration-tests.
4. **Idempotency guards are count-based, not key-specific** (`count(Strand.<T>) > 0 → skip`), per
   the ticket. Correct for a true founder (member #1), but worth a sanity check that no path
   could legitimately reach the bootstrap with foreign rows already present and the founder's own
   row absent.
5. **Engine columns are placeholders** (`'quereus'` / `'0.1.0'`). `EngineVersion` is an arbitrary
   pinned string — a reviewer may prefer pinning to a real source. No engine-selection seam built.
6. **`signStrandPayload` is exported but unused at runtime** in this ticket. Verify the chosen
   byte construction is exactly what the invite/peer/rotation constraints will hash, so the later
   tickets don't have to re-derive it (the unit test pins it against `verify(digest(...),…)`).

## Out of scope (do not expand here)
Invite minting/consumption, MemberPeer publication, authority rotation, and wiring `founder:true`
into the real formation/host/solo callers — all owned by downstream lifecycle tickets.
