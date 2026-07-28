----
description: Built the small on-device list of "my party's real authority keys", seeded from founding a party, from the invite that enrolled the node, or from operator pins. Unlike the shared database, this list cannot be polluted by strangers, so later tickets can use it to decide who is a real member.
files:
  - packages/cadre-core/src/trusted-owner-store.ts (new — interface + in-memory store, cross-platform)
  - packages/cadre-core/src/trusted-owner-store-file.ts (new — Node-only file-backed store, subpath export)
  - packages/cadre-core/src/fs-atomic.ts (new — shared atomic-write helpers, extracted from key-store-file)
  - packages/cadre-core/src/key-store-file.ts (refactored onto fs-atomic; behavior unchanged)
  - packages/cadre-core/src/cadre-node.ts (store construction in start, getTrustedOwnerStore, trustOwnerKeys, genesis seeding in initializeSeedBootstrap)
  - packages/cadre-core/src/types.ts (CadreNodeConfig.trustedOwners), src/index.ts, package.json (new subpath export)
  - packages/cadre-cli/src/commands/start.ts + src/config/{types,loader}.ts (file-backed store next to identity key; operator pins seeded)
  - packages/reference-app-rn/src/use-cadre.ts (invite pins seeded before applySeed)
  - packages/cadre-core/test/trusted-owner-store.spec.ts, test/cadre-node-trusted-owners.spec.ts (new)
  - docs/architecture.md (seed-validation section: new trust-anchor bullet)
difficulty: medium
----

# Review: node-local trusted-authority anchor (ticket 3 of the membership chain)

Implements the non-replicated, per-party store of out-of-band-trusted authority
keys. As specified, NO membership predicate, gate, or seed-trust policy was
changed — this ticket only builds and seeds the store; tickets 4/5 consume it.

## Naming: ticket said "Authority", codebase says "Owner"

The codebase renamed `AuthorityKey`→`OwnerKey`, `getAuthorityKeys`→`getOwnerKeys`,
`CadreInvite.authorityKeys`→`ownerKeys`, `makeOwnAuthority`→`makeOwnOwner` after
tickets 3–6 were written. Everything new follows the current code naming:

- `TrustedAuthorityStore` (ticket) → **`TrustedOwnerStore`** — same interface
  shape (`partyId`, `has`, `all`, `trust(key, source)`).
- Sources: `'genesis' | 'invite' | 'operator'` (type `TrustSource`), as specified.

Tickets 4/5/6 reference the ticket-spelled names; the agents working them need
this mapping (also restated here so grep finds it: `TrustedOwnerStore` ==
"TrustedAuthorityStore", `MemoryTrustedOwnerStore`, `FileTrustedOwnerStore`).

## What was built

- **`TrustedOwnerStore`** (`trusted-owner-store.ts`, exported from the
  cross-platform index): interface + `MemoryTrustedOwnerStore`. One contract
  nuance ADDED beyond the ticket: `trust()` must reflect the key in
  `has()`/`all()` **synchronously**; the returned promise tracks durability
  only. This makes the sync seams (`initializeSeedBootstrap`) deterministic.
  Keys are additive; revocation is explicitly out of scope (documented).
- **`FileTrustedOwnerStore`** (`trusted-owner-store-file.ts`, Node-only subpath
  `@serfab/cadre-core/trusted-owner-store-file`, mirroring `key-store-file`'s
  `node:fs` isolation): JSON at `<dir>/trusted-owners.<encoded-partyId>.json`
  (0600, versioned shape `{version:1, partyId, owners:{key:{source,trustedAt}}}`),
  crash-atomic temp+fsync+rename writes, serialized snapshot persists. Absent /
  corrupt / unknown-shape / wrong-party file ⇒ cold start (empty anchor, logged),
  never a crash. Constructed via `FileTrustedOwnerStore.open(dir, partyId)`.
- **Shared fs helpers** (`fs-atomic.ts`): the atomic-write + filename-encode +
  ENOENT-check logic extracted from `key-store-file.ts` so both file stores use
  one implementation. `FileKeyStore` behavior is unchanged (its full spec passes).
- **`CadreNodeConfig.trustedOwners`**: `{ store?, pinnedKeys?, pinnedSource? }`.
  Injected store's `partyId` must match the node's party — `start()` fails
  closed before any network bring-up. No store injected ⇒ in-memory default.
  The store is kept across `stop()`→`start()` of the same node instance.
- **Seeding seams:**
  - *Genesis*: `CadreNode.initializeSeedBootstrap(ownerPrivateKey)` anchors the
    derived public key with source `'genesis'`. This covers every founder path
    (cadre-cli `--owner`, web/RN owner-genesis, and the integration-test
    `makeOwnOwner` helpers) with zero test edits.
  - *Invite (config-time)*: `trustedOwners.pinnedKeys` seeded during `start()`.
  - *Invite (runtime)*: new public `CadreNode.trustOwnerKeys(keys, 'invite'|'operator')`;
    the RN reference app calls it with the invite's `ownerKeys` BEFORE
    `applySeed` (the ordering ticket 5 requires).
  - *Operator*: cadre-cli's existing `--pin-owner-key`/`CADRE_OWNER_KEYS` keys
    now also seed the anchor (source `'operator'`), and the CLI opens a
    file-backed store next to the protobuf identity key when
    `identity.protobufKeyFile` (or `--identity-protobuf`, which cadre-host
    always passes) is configured.
- Accessor for tickets 4/5: `CadreNode.getTrustedOwnerStore()` (null before start).

## Known gaps / decisions the reviewer should probe

- **Genesis seam over-anchors on joiner nodes.** `initializeSeedBootstrap` is
  also called by NON-founders with their own derived key (e.g. the RN phone's
  `runOwnerGenesis`, needed to self-publish a `CadrePeer` row). Such a node
  anchors its own key as `'genesis'` even though it is not a party authority.
  Locally harmless — the store never replicates and self-trust grants nothing to
  others — but ticket 4's predicate tests should expect "own key may be in own
  anchor". NOTE comment at the site (cadre-node.ts, initializeSeedBootstrap)
  explains the alternative (gate on the actual `OwnerKey` genesis insert) if
  `'genesis'` entries ever feed cross-node decisions.
- **RN persistence gap**: phones get the in-memory store, so invite-pinned
  trust dies with the app process. Filed as
  `backlog/feat-rn-trusted-owner-anchor-persistence` (fail-closed, not unsafe).
- **CLI without a protobuf identity** (keyFile/hex/ephemeral): in-memory anchor
  only; `ResolvedConfig.identityProtobufKeyFile` is the only path surfaced.
  Deliberate minimal cut; extend when another host needs it.
- **File persist failures don't roll back memory**: a failed disk write leaves
  the key trusted for the session (logged; next successful `trust` re-lands the
  full snapshot). Chosen deliberately — this session's out-of-band trust
  decision stands; durability is best-effort.
- **TOFU-accepted keys are not yet persisted into the anchor** — explicitly
  ticket 5's scope (`seed-accepted-authority-persistence` slice).
- **Provenance is write-once**: re-trusting a known key keeps the original
  source. Not observable through the interface today (only the file records it).

## Validation performed

- New specs: `trusted-owner-store.spec.ts` (contract suite over both backends +
  file specifics: reload, corrupt/foreign-party/unknown-shape cold starts,
  cross-party isolation in one dir, concurrent trust, no temp debris) and
  `cadre-node-trusted-owners.spec.ts` (default/injected store, pin seeding,
  runtime seam, genesis anchoring, restart retention, fail-closed party
  mismatch and pre-start `trustOwnerKeys`).
- Full suites green: cadre-core 680 passed / 1 skipped (incl. refactored
  key-store spec), cadre-cli 94, reference-app-rn 133, cadre-host 448 / 3
  skipped. Root `yarn typecheck` and `yarn lint` clean.
- Cross-platform isolation: `fs-atomic.ts` is imported only by the two
  Node-only subpath modules; the index graph gains only `trusted-owner-store.ts`
  (sole import: `debug`), and the `types.ts` import of the store type is
  type-only (erased at emit). Not verified with an actual Metro/Vite bundle run
  — same pattern as the already-proven `key-store-file`/`push-node` isolation.
- NOT run: the real-network integration suite (`packages/integration-tests`).
  Nothing in it consumes the store yet, and its scenarios were untouched;
  ticket 4 reworks them.

## Suggested review focus

- The `trust()` sync-visibility/async-durability contract and its use in
  `initializeSeedBootstrap` (fire-and-forget persist with `.catch` logging).
- `FileTrustedOwnerStore.open` failure taxonomy — is "everything ⇒ empty"
  right, or should an unreadable-but-present file (EACCES) fail loud instead,
  mirroring `FileKeyStore`'s read-error propagation?
- The key-store-file refactor onto `fs-atomic.ts` (must be behavior-preserving).
- CLI wiring: anchor dir derived from `dirname(identity.protobufKeyFile)` —
  correct location for provider/host-managed nodes?
