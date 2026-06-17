description: When a node founds a strand it must write the strand's one-time identity record and (for private strands) enroll the founder as the first member and admin; when a node merely joins an existing strand it must write nothing and rely on sync. Build that founder-only bootstrap.
prereq:
files: packages/cadre-core/src/strand-database.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/strand-member-key.ts, packages/cadre-core/src/authority-key.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/index.ts, schemas/strand.qsql
difficulty: hard
----

## Context

`apply-strand-membership-schema` (complete) applied `schemas/strand.qsql` to every strand DB
via `composeStrand`, so the `Strand.*` membership/RBAC tables (`Header`, `Invite`,
`ConsumedInvite`, `Member`, `MemberPeer`, `Authority`) and their `verify()`-gated constraints
are present and active — but **no runtime code writes to them**. This ticket lands the first
writer: the **founder bootstrap** that runs once at bring-up on the strand's founder, plus the
shared signing/key-bridge primitives the later invite/peer/rotation tickets reuse.

### Three-layer reconciliation (settled — do not re-litigate)

There are three independent consent/RBAC layers. This work owns layer 2 only:

1. **Control/cadre layer** (`CadreControl.*` in the shared control DB): `Strand`,
   `FormationInvite`/`FormationUsage`, `AuthorityKey`, `CadrePeer`. Governs which cadre operates
   a strand and cadre-operator consent to *form* it. **Unchanged.**
2. **Strand RBAC layer** (`Strand.*` inside each strand DB, from `schemas/strand.qsql`):
   authoritative per-strand membership. **This is what we populate.**
3. **sApp layer** (`App.*`): application data RBAC. Already covered by `rbac-signed-write`.

The `Strand` (layer-1, control) `MemberPrivateKey` is the closed-strand read-gating secret; the
founding `Member.Key`/`Authority.MemberKey` (layer 2) are *derived from it* (see key bridge
below). Do not confuse the two.

### Signing idiom (differs from control.qsql — important)

`schemas/control.qsql` signs a multi-field digest concatenation via
`buildAuthorizationMessage` (`control-database.ts:70`). `schemas/strand.qsql` uses a **single
digest over a `'|'`-joined payload**, e.g. `Member.Authorized`:
`verify(digest(new.Key, 'sha256', 'utf8'), context.AuthoritySignature, A.MemberKey, 'ed25519')`.
The signer must therefore hash the payload to raw bytes and ed25519-sign those bytes — exactly
the proven `signItem` helper in
`packages/integration-tests/src/scenarios/rbac-signed-write.integration.ts:110`:

```ts
const hashBytes = digest(payload, 'sha256', 'utf8', 'bytes') as Uint8Array;
sign(hashBytes, privateKeyB64, 'ed25519', 'bytes', 'base64url', 'base64url') as string;
```

`digest(...)` default output is base64url and `verify(...)` default `inputEncoding` is base64url,
so signer and verifier operate on identical bytes (confirmed in the
`apply-strand-membership-schema` review). All strand keys are ed25519, so the explicit
`'ed25519'` curve arg is mandatory.

### Key bridge (settled)

`Strand.MemberPrivateKey` is a **base64 protobuf** libp2p ed25519 key (minted by
`generateStrandMemberKey`, `strand-member-key.ts:13`). The crypto-plugin constraints want a raw
base64url keypair. Bridge: `privateKeyFromProtobuf(fromString(memberPrivateKey, 'base64'))` →
reuse `authorityKeyFromLibp2p(pk)` (`authority-key.ts:32`) to get `{ privateKeyB64,
publicKeyB64 }`. The founding `Member.Key` and `Authority.MemberKey` are that `publicKeyB64`.

### Founder designation (settled)

Add an explicit `founder?: boolean` to the strand config and thread it through. The founder is
the party that provisioned/published the strand (the responder in formation; the creator in
host/solo paths) — the same party that calls `CadreNode.publishStrand`. Joiners default to
`founder: false` and write nothing; they receive the bootstrap rows via Optimystic sync. All
founder writes are **idempotent (insert-if-absent)** so a restart / founder re-`addStrand` does
not double-insert and does not race a joiner.

### Header columns (settled)

Quereus defaults unqualified columns to **NOT NULL** (Third Manifesto; see the
`rbac-signed-write` review). `Header` declares no `null` columns, so every column must be
supplied non-null:

| Column | Source |
|---|---|
| `Id` | `strandRow.Id` |
| `Type` | `strandRow.Type` (`'o'`/`'c'`) |
| `sAppId` | `sAppConfig.id` |
| `sAppVersion` | `sAppConfig.version` |
| `sAppSchema` | `sAppConfig.schema` |
| `sAppSignature` | `sAppConfig.signature ?? ''` (optional under dev `requireSignedSchemas:false`) |
| `Engine` | constant `STRAND_ENGINE = 'quereus'` (new export) |
| `EngineVersion` | constant `STRAND_ENGINE_VERSION` (new export; a pinned string) |

`Header` carries only `InsertOnly` (no signature constraint) and a singleton PK, so the insert
needs **no `with context`** — just the 8 values, guarded by an insert-if-absent count check.
There is no engine-config seam yet; the `Engine`/`EngineVersion` constants are a documented
placeholder (a real engine-selection seam is future work — note it, do not build it here).

### Founder bootstrap behavior

- **Open strand (`Type='o'`)**: insert `Header` only. `Member`/`Invite`/`Authority` are
  `OnlyClosed` — skip them entirely.
- **Closed strand (`Type='c'`)**: insert `Header(Type='c')`, then the founding `Member`
  (`Key = publicKeyB64` from the key bridge; satisfies the `count(1) from Member <= 1` bootstrap
  branch — no signature needed), then the founding `Authority` (`MemberKey = publicKeyB64`;
  satisfies the `count(1) from Authority <= 1` bootstrap branch — no signature). All three
  insert-if-absent.

Header must exist (Type='c') for `Member.OnlyClosed`/`Authority.OnlyClosed` to pass; those are
deferred (subquery) checks evaluated at commit, so sequential auto-commit inserts in
Header→Member→Authority order are safe.

### Plumbing path

`CadreNode.addStrand(StrandConfig)` (`cadre-node.ts:1350`) → `launchStrand`
(`cadre-node.ts:1463`) → `StrandInstanceManager.startStrand` (`StartStrandConfig`,
`strand-instance-manager.ts:26`) → `buildStrandRuntime` constructs `StrandDatabase`
(`StrandDatabaseConfig`, `strand-database.ts:13`). Thread `founder` through all three. The
strand `Type` and `MemberPrivateKey` are on `config.strandRow` in `buildStrandRuntime` — pass
them into `StrandDatabaseConfig` (e.g. `strandType`, `memberPrivateKey`). `StrandDatabase`
already holds `sAppConfig`.

Run the bootstrap in `StrandDatabase.initialize()` **after** `connectToStrand` returns (the
schema is applied by then), gated on `config.founder === true`. Keep all SQL in cadre-core
(`StrandDatabase` + a new `strand-membership-writer.ts`); `composeStrand` continues to apply
schema only.

## New module: `packages/cadre-core/src/strand-membership-writer.ts`

Shared primitives (exported via `index.ts`) — also consumed by the invite/peer/rotation tickets:

- `signStrandPayload(payload: string, privateKeyB64: string): string` — the single-digest
  ed25519 signer above.
- `strandMemberKeyPair(memberPrivateKey: string): AuthorityKeyPair` — the protobuf→base64url
  bridge (place in `strand-member-key.ts` next to `generateStrandMemberKey`, or here; reuse
  `authorityKeyFromLibp2p`).
- `bootstrapFounderMembership(db: Database, params: { strandId; type; sApp; founderKeyPair? }):
  Promise<void>` — the idempotent founder bootstrap (Header always; Member+Authority when
  `type==='c'`). `founderKeyPair` derived from `memberPrivateKey` by the caller; required when
  `type==='c'`, must throw if a closed strand has no `memberPrivateKey`.
- `STRAND_ENGINE`, `STRAND_ENGINE_VERSION` constants.

Tables are addressed as `Strand.Header`, `Strand.Member`, `Strand.Authority` (the
`declare schema Strand { … } apply schema Strand` namespace), mirroring `CadreControl.*` and
`App.*`.

## Edge cases & interactions

- **Idempotency / restart**: founder re-runs bootstrap on every `addStrand`/`resumeStrand`.
  Each insert must be guarded by `select count(1) … from Strand.<T>` and skipped if present.
  Assert a second `initialize()` is a no-op (no duplicate Header / no `InsertOnly` violation).
- **Founder-vs-joiner race (networked mode)**: only the `founder` flag writes; joiners never
  insert. Test a two-party closed strand where founder bootstraps and the joiner's
  `initialize()` writes nothing (count stays 1 until the joiner later consumes an invite — next
  ticket).
- **Open strand**: must NOT insert Member/Authority/Invite (they would trip `OnlyClosed`).
  Assert only `Header(Type='o')` exists; `Member`/`Authority` counts are 0.
- **Closed strand missing `MemberPrivateKey`**: founder bootstrap must throw a clear error
  rather than insert a Header with no founding member (a closed strand with no Authority can
  never admit anyone).
- **Header NOT-NULL columns**: a missing `sAppConfig.signature` (dev `requireSignedSchemas:false`)
  must coalesce to `''`, not insert null (NOT NULL violation). Cover with an unsigned-config case.
- **Deferred `OnlyClosed`**: Header must be inserted before (or in the same txn as) Member/
  Authority so the deferred check passes at commit. Verify closed bootstrap commits cleanly.
- **bootstrap vs networked mode**: bootstrap runs in both. In `bootstrap` mode the known
  optimystic deferred-constraint-rollback bug only affects *rejections* (not the accept path
  here); founder inserts are all accept-path. No interaction expected — assert closed bootstrap
  succeeds in bootstrap mode.
- **Failure during bootstrap**: a throw in `bootstrapFounderMembership` must propagate out of
  `initialize()` so `buildStrandRuntime`'s existing rollback (`releaseRuntime`,
  `strand-instance-manager.ts:297`) tears the half-built strand down (no leaked node).
- **Key-bridge correctness**: `strandMemberKeyPair(memberPrivateKey).publicKeyB64` must equal
  `getPublicKey` of the derived seed — unit-test the round-trip so the founding `Member.Key`
  matches what a later signature verifies against.

## TODO

### Phase 1 — primitives + unit tests
- Add `strandMemberKeyPair` (protobuf→base64url bridge, reusing `authorityKeyFromLibp2p`) and
  `signStrandPayload` (single-digest ed25519 signer). Export from `index.ts`.
- Unit test: key-bridge round-trip (derived pubkey stable); `signStrandPayload` output verifies
  via the crypto plugin's `verify(digest(payload,'sha256','utf8'), sig, pub, 'ed25519')`.

### Phase 2 — founder bootstrap writer
- Add `STRAND_ENGINE`/`STRAND_ENGINE_VERSION` constants and `bootstrapFounderMembership`
  (idempotent Header always; Member+Authority for `type==='c'`; throw on closed-without-key).
- Unit/component test against a real strand DB: closed bootstrap → exactly one
  `Header(Type='c')`, one `Member`, one `Authority`; open bootstrap → one `Header(Type='o')`,
  zero Member/Authority; re-run is a no-op; unsigned-config Header coalesces signature to `''`.

### Phase 3 — plumbing
- Add `founder?: boolean` to `StrandConfig` (`types.ts`), `StartStrandConfig`
  (`strand-instance-manager.ts`), and `StrandDatabaseConfig` (`strand-database.ts`); add
  `strandType` + `memberPrivateKey` to `StrandDatabaseConfig`. Thread `founder` through
  `addStrand`→`launchStrand`→`startStrand`→`buildStrandRuntime`, and pass
  `strandRow.Type`/`strandRow.MemberPrivateKey` into `StrandDatabaseConfig`.
- Call `bootstrapFounderMembership` from `StrandDatabase.initialize()` after `connectToStrand`,
  gated on `founder===true`, deriving the founder keypair via `strandMemberKeyPair` when closed.

### Phase 4 — validate
- `yarn workspace @serfab/cadre-core test 2>&1 | tee /tmp/cadre-core.log` (stream; do not silent-redirect).
- `yarn workspace @serfab/cadre-core lint` on changed files. Typecheck.
- Update `docs/architecture.md` (Strand Formation / membership) to note founder bootstrap +
  the three-layer reconciliation.
