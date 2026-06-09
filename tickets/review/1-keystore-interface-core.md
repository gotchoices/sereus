priority: 2
description: Review the pluggable KeyStore interface + reference backends in @serfab/cadre-core and the CadreNode identity-resolution wiring (the platform-agnostic half of mobile secure key storage)
files: packages/cadre-core/src/key-store.ts, packages/cadre-core/src/key-store-file.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/index.ts, packages/cadre-core/package.json, packages/cadre-core/test/key-store.spec.ts, packages/cadre-core/test/cadre-node-identity.spec.ts, docs/architecture.md
----

## What landed

A backend-agnostic `KeyStore` seam in `@serfab/cadre-core` plus the routing of
`CadreNode` identity (and the identity-derived authority key) through it. No
mobile/Expo/RN dependency was added — the `expo-secure-store` backend + app
wiring are the dependent ticket `keystore-rn-secure-store` (sits in `implement/`).

### New modules

- **`src/key-store.ts`** (dependency-free; safe in every entry graph):
  - `KeyId` (string alias), `KeyStore` interface (`get`/`set`/`delete`/`list`),
    `KeyStoreAccessError` (carries `keyId` + forwards `cause`; never material),
    `DEFAULT_IDENTITY_KEY_ID = 'cadre/identity'`.
  - `InMemoryKeyStore` — `Map`-backed; **defensively copies** material on both
    `set` and `get` (slice) so a caller mutating its own buffer can't alter
    stored state, matching the fresh-buffer semantics of a file/keyring backend.
- **`src/key-store-file.ts`** (Node-only; imports `node:fs/promises` + `node:path`):
  - `FileKeyStore(dir)` — one file per slot `<dir>/<encoded keyId>.key`, raw
    bytes, best-effort `0o600` file / `0o700` dir (no-op on Windows). Directory
    created lazily on first `set`.
  - keyId↔filename encoding: `encodeURIComponent` **plus** escaping the chars it
    leaves intact that are fs-unsafe (`!'()*~.`), so the `.key` suffix is the
    only literal dot and Windows-illegal `*` is encoded. `decodeURIComponent`
    reverses every escape. Round-trips slashes/spaces/unicode/`*:<>|?` ids.
  - Exported via the **subpath** `@serfab/cadre-core/key-store-file` (added to
    `package.json` `exports`) so `node:fs` never lands in the cross-platform
    default entry. `InMemoryKeyStore`/interface/error are exported from the root.

### CadreNode wiring (`src/cadre-node.ts`, `src/types.ts`)

- `CadreNodeConfig` gains `keyStore?: KeyStore` + `identityKeyId?: KeyId`,
  documented as mutually exclusive with `privateKey`.
- New private `identityKey?: PrivateKey`, resolved **once** early in `start()`
  (before any libp2p/network bring-up) by `resolveIdentityKey()`:
  1. both `keyStore` + `privateKey` → config error (fail closed);
  2. `keyStore` → `get(slot)`: bytes → `privateKeyFromProtobuf`; empty →
     `generateKeyPair('Ed25519')` + persist `privateKeyToProtobuf`; **get
     rejects → propagate** (never regenerate over an unreadable slot);
  3. `privateKey` → use it; 4. neither → libp2p ephemeral.
- Every former `this.config.privateKey` **read** now uses the resolved
  `this.identityKey`: `createControlNode()`, `getSelfSigningKey()`, and
  `launchStrand()` (the strand-level identity). Remaining `config.privateKey`
  mentions are doc comments only.
- New public `getIdentityAuthorityKey(): AuthorityKeyPair` — derives the
  authority pair from the resolved identity (`authorityKeyFromLibp2p`); throws
  before `start()`/resolve and on the ephemeral path. Authority **genesis stays
  app-controlled** — cadre-core does not auto-run it.
- User-facing "config.privateKey unset" error/log strings reworded to
  "node identity" (no test asserted on them).

### Docs

`docs/architecture.md`: new "Node Key Material & the KeyStore Seam" subsection
(interface, get-undefined-vs-throw contract, resolution order, app-controlled
genesis), updated `CadreNodeConfig` code block, and an Implementation-Status bullet.

## How to validate

From `packages/cadre-core`:
- `yarn workspace @serfab/cadre-core build` (tsc) — green.
- `yarn workspace @serfab/cadre-core typecheck` (src + test) — green.
- `yarn test` — **479 passed (35 files)**; the two new files contribute 33.
- Root `npx eslint <changed files>` — clean (full `yarn lint` is the repo gate).

## Test coverage (this is a floor, not a ceiling)

`test/key-store.spec.ts` — contract suite parametrized over **both**
`InMemoryKeyStore` and `FileKeyStore`: set/get round-trip, get-missing→undefined,
overwrite, caller-buffer isolation, delete idempotency (incl. delete-absent),
`list` reflects writes/deletes, awkward keyIds (`cadre/identity`, spaces, unicode,
`*:<>|?`, nested slashes) round-trip without collision. Plus FileKeyStore
missing-dir `get`/`list` → undefined/[], and `KeyStoreAccessError` shape.

`test/cadre-node-identity.spec.ts` — resolution: generate+persist on first run,
custom `identityKeyId`, persisted bytes == protobuf of resolved key, reload →
identical PeerId (InMemory **and** FileKeyStore), **rejecting `get` does not
regenerate** (asserts `set` never called), corrupt bytes surface an error,
keyStore+privateKey config error thrown before bring-up (node stays down, no
peerId), legacy `privateKey` verbatim, ephemeral leaves identity undefined,
double-resolve neither regenerates nor double-persists. Accessor: throws before
resolve, throws on ephemeral, equals `authorityKeyFromLibp2p`. No-leak: debug
logger captured across resolve + `getSelfSigningKey` + `getIdentityAuthorityKey`;
asserts the protobuf bytes (base64/base64url/hex) and the authority seed never
appear. Full integration: FileKeyStore-backed node has a **stable PeerId across
two real `start()`/`stop()` lifecycles** (60s).

## Known gaps / things to scrutinize

- **No atomic write in `FileKeyStore.set`** — a crash mid-write could leave a
  torn/partial slot. This fails *loudly* on next load (corrupt bytes → error, no
  regeneration, so the real identity is not silently orphaned) but the slot is
  unusable until restored. If durability matters for headless Node nodes,
  consider temp-file + rename. Not required by the ticket; flagged for judgment.
- **No concurrency guard** on `FileKeyStore` for concurrent `set` to the same
  key (untested). `CadreNode` resolves identity single-flight via the
  `identityKey` guard, so the in-process node path is safe; cross-process or
  multi-writer use of one directory is out of scope.
- **No-leak test exercises the three identity-material functions directly**
  (via an injected control node), not a full networked `start()`. The other
  loggers on the start path (`createControlNode`, control DB, seed-bootstrap)
  were **audited by reading** and log only peerIds/party names/counts — no key
  material — but were not all exercised under the capture harness. Worth a second
  read of `seed-bootstrap.ts` / `cadre-node.ts` debug calls along the identity path.
- **Best-effort permissions are not asserted** (the `0o600`/`0o700` modes are
  passed but not verified in tests, since the dev/CI platform is Windows where
  they are ignored). A posix reviewer could add a stat-based check.
- **Behavior change worth confirming**: with a `keyStore`, a node can now
  self-sign records and strands receive a stable identity (previously only the
  injected-`privateKey` path could). Ephemeral nodes are unchanged
  (`identityKey` undefined → `getSelfSigningKey` returns null, strands get
  `undefined` privateKey — same as before). Confirm this is the intended seam
  for the RN backend.
- Empty (zero-length) bytes from `get` are treated as "present" (truthy object)
  and routed to `privateKeyFromProtobuf`, which throws — i.e. an empty slot is a
  *corrupt* slot, not an *absent* one. Backends must return `undefined`, not an
  empty array, for "no key".
- The `authorityKeyId` separate-authority-slot extension is intentionally **not**
  built (anticipated only). Single-key model: authority == identity.

## Downstream

`keystore-rn-secure-store` (in `implement/`, `prereq: keystore-interface-core`)
implements the `expo-secure-store` backend and wires the RN phone node + app
through this seam, replacing plaintext-LevelDB key persistence.
