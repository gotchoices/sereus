priority: 2
description: Pluggable KeyStore interface + reference backends (InMemory/File) in @serfab/cadre-core, with CadreNode identity + derived-authority-key resolution routed through it. Platform-agnostic half of mobile secure key storage. Reviewed and accepted.
files: packages/cadre-core/src/key-store.ts, packages/cadre-core/src/key-store-file.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/index.ts, packages/cadre-core/package.json, packages/cadre-core/test/key-store.spec.ts, packages/cadre-core/test/cadre-node-identity.spec.ts, docs/architecture.md
----

## What landed

A backend-agnostic `KeyStore` seam in `@serfab/cadre-core` plus the routing of
`CadreNode` identity (and the identity-derived authority key) through it. No
mobile/Expo/RN dependency was added — the `expo-secure-store` backend + app
wiring are the dependent ticket `keystore-rn-secure-store` (in `implement/`).

- **`src/key-store.ts`** (dependency-free): `KeyId`, `KeyStore`
  (`get`/`set`/`delete`/`list`), `KeyStoreAccessError` (carries `keyId`, never
  material), `DEFAULT_IDENTITY_KEY_ID = 'cadre/identity'`, and `InMemoryKeyStore`
  (Map-backed, defensively copies on both `set` and `get`).
- **`src/key-store-file.ts`** (Node-only, subpath export
  `@serfab/cadre-core/key-store-file`): `FileKeyStore(dir)` — one raw-bytes file
  per slot, lazy dir creation, best-effort `0o600`/`0o700`, injective
  `encodeURIComponent`-plus-extra-escape keyId↔filename codec.
- **`CadreNode`**: `keyStore?` + `identityKeyId?` config (mutually exclusive with
  `privateKey`); `resolveIdentityKey()` runs once early in `start()` (fail-closed,
  never regenerates over an unreadable/corrupt slot); all former
  `config.privateKey` *reads* now use the resolved `this.identityKey`
  (`createControlNode`, `getSelfSigningKey`, `launchStrand`); new public
  `getIdentityAuthorityKey()` exposes the derived authority pair for
  app-controlled genesis.
- **Docs**: `docs/architecture.md` "Node Key Material & the KeyStore Seam"
  subsection + updated `CadreNodeConfig` block + status bullet.

Full implementation detail is in the implement commit `83868a0`
(`ticket(implement): keystore-interface-core`).

## Review findings

Adversarial pass over implement commit `83868a0`. Read the full diff (src,
tests, docs) with fresh eyes before the handoff summary, cross-checked against
the original implement ticket's requirements, and re-derived the keyId-codec
injectivity and the no-leak audit independently.

### Verified correct (checked, nothing to change)

- **Requirement coverage** — every item in the implement ticket is present:
  interface + error + default slot id + `InMemoryKeyStore` + `FileKeyStore`
  (subpath export in `package.json`), the 4-step fail-closed resolution order,
  replacement of *all* `config.privateKey` reads with `this.identityKey`
  (`createControlNode`, `getSelfSigningKey`, and `launchStrand` — the last not
  named in the ticket but correctly caught; grep confirms no other identity
  read remains, remaining `config.privateKey` mentions are doc comments and the
  unrelated push-credential fields), the `getIdentityAuthorityKey()` accessor,
  and the docs update.
- **keyId↔filename codec injectivity** — re-derived: `encodeURIComponent` is
  injective; the extra `[!'()*~.]` → `%XX` replace cannot alias any other
  input (literal `%` always becomes `%25`), so no two distinct keyIds can
  collide on a filename. Output is `[A-Za-z0-9-_]` + `%XX`; `.key` is the only
  literal dot, so suffix-stripping is unambiguous. Matches the parametrized
  awkward-keyId round-trip test (slashes, spaces, unicode, `*:<>|?`).
- **Fail-closed resolution** — both-keys → throw before bring-up; rejecting
  `get` → propagate, no regenerate, no `set`; corrupt bytes → throw; empty slot
  → generate + persist exactly once; double-resolve idempotent. All asserted by
  `cadre-node-identity.spec.ts`, and the both-keys case asserts the node stays
  down (`isRunning === false`, no `peerId`).
- **Buffer isolation** — `InMemoryKeyStore` copies on `set` and `get`;
  `FileKeyStore.get` copies out of the Node `Buffer` pool. Caller-mutation test
  covers both backends.
- **No key-material leak** — re-audited every `log(...)` on the identity/start
  path in `cadre-node.ts` and `seed-bootstrap.ts` (grep for
  privateKey/seed/protobuf/raw/material). None emit key bytes/seeds/base64; the
  "seed" loggers refer to the peer-discovery bootstrap seed (party/peer IDs +
  counts), not the Ed25519 seed. `getSelfSigningKey` logs only on failure and
  only the error shape; `authorityKeyFromLibp2p` embeds no material. The
  no-leak test (namespace `sereus:cadre:*` matches the module logger
  `sereus:cadre:node`) confirms the three identity-material functions emit no
  base64/base64url/hex protobuf nor authority seed.
- **Behavior change confirmed intended** — with a `keyStore`, strands now
  receive a stable identity via `this.identityKey` (previously only the injected
  `privateKey` path did). Legacy `privateKey` path is byte-identical
  (`identityKey === config.privateKey`) and the ephemeral path is unchanged
  (`identityKey` undefined → same as before). `launchStrand` runs only post-start
  so the keyStore-resolved identity is always present by then — no regression.
- **Validation** — `yarn workspace @serfab/cadre-core typecheck` clean; `eslint`
  on all changed files clean; `yarn test` green (480 passed after this pass).

### Found & fixed in this pass (minor)

- **`FileKeyStore.list()` could throw `URIError` on a foreign `.key` file.** It
  mapped `decodeURIComponent` over every `.key` filename, so one undecodable
  file (an invalid percent-sequence the store never wrote) would break
  enumeration of *all* real slots. Hardened `decodeKeyId` to return `undefined`
  on a decode failure (logging it via a new `sereus:cadre:key-store-file`
  debug logger, per the no-eat-exceptions rule) and `list()` now filters those
  out. Added a regression test
  (`list() skips a foreign .key file with an undecodable name`).

### Filed as follow-up (major → new ticket)

- **`FileKeyStore.set` is not crash-atomic** (implementer-flagged, confirmed).
  A crash mid-write leaves a torn slot. It fails *loudly* on next load (corrupt
  bytes → throw, no regeneration, real identity never silently orphaned), so it
  is acceptable for the current state (FileKeyStore is test-only / not yet wired
  into headless cli/host persistence; the production mobile target uses the
  atomic `expo-secure-store`). Out of this ticket's scope and non-trivial to do
  correctly cross-platform (temp-file + atomic rename, `.tmp` cleanup, rename-
  over-existing on Windows, fsync question). Filed
  `tickets/backlog/filekeystore-atomic-write.md`.

### Noted, not actioned (acceptable as-is)

- **Best-effort `0o600`/`0o700` perms are not asserted** in tests — dev/CI is
  Windows where the modes are ignored. A posix reviewer could add a stat-based
  assertion; tracked in the atomic-write backlog ticket's test list.
- **Windows reserved device names** (a literal keyId `con`/`nul`/`prn` → e.g.
  `con.key`) remain reserved even with an extension. Purely theoretical — the
  default slot `cadre/identity` encodes the slash away, and no realistic keyId is
  a bare reserved name. Not worth special-casing.
- **Empty (zero-length) `get` bytes are treated as "present"** (truthy object) →
  `privateKeyFromProtobuf` throws (corrupt, not absent). This is a documented
  backend contract ("return `undefined`, not an empty array, for no key"), not a
  bug.
- **`enrollment.createCadrePeer` not reused** in `resolveIdentityKey` — the
  ticket said "reuse … *or* factor a shared helper if cleaner." Inlining the two
  trivial library calls (`generateKeyPair` + `privateKeyToProtobuf`) is cleaner
  than threading through `createCadrePeer`'s wrapped `CreatePeerResult` (which
  also computes an unused peerId). Acceptable.

## Downstream

`keystore-rn-secure-store` (in `implement/`, `prereq: keystore-interface-core`)
implements the `expo-secure-store` backend and wires the RN phone node + app
through this seam, replacing plaintext-LevelDB key persistence.
