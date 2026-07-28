description: Built the small on-device list of "my party's real authority keys", seeded from founding a party, from the invite that enrolled the node, or from operator pins. Unlike the shared database, this list cannot be polluted by strangers, so later tickets can use it to decide who is a real member.
files:
  - packages/cadre-core/src/trusted-owner-store.ts (interface + in-memory store, cross-platform)
  - packages/cadre-core/src/trusted-owner-store-file.ts (Node-only file-backed store, subpath export)
  - packages/cadre-core/src/fs-atomic.ts (shared atomic-write helpers, extracted from key-store-file)
  - packages/cadre-core/src/key-store-file.ts (refactored onto fs-atomic; behavior unchanged)
  - packages/cadre-core/src/cadre-node.ts (store construction in start, getTrustedOwnerStore, trustOwnerKeys, genesis seeding)
  - packages/cadre-core/src/types.ts (CadreNodeConfig.trustedOwners), src/index.ts, package.json
  - packages/cadre-cli/src/commands/start.ts + src/config/{types,loader}.ts
  - packages/reference-app-rn/src/use-cadre.ts
  - packages/cadre-core/test/trusted-owner-store.spec.ts, test/cadre-node-trusted-owners.spec.ts
  - docs/architecture.md, docs/cadre-host.md
difficulty: medium
----

# Complete: node-local trusted-authority anchor (ticket 3 of the membership chain)

The non-replicated, per-party record of out-of-band-trusted owner keys now
exists and is seeded on every enrollment path. No membership predicate, gate, or
seed-trust policy was changed — tickets 4/5 consume the store.

## Naming: ticket text said "Authority", codebase says "Owner"

Tickets 4/5/6 were written before the `AuthorityKey`→`OwnerKey` rename. Mapping
for whoever picks them up: `TrustedAuthorityStore` == **`TrustedOwnerStore`**
(same shape: `partyId`, `has`, `all`, `trust(key, source)`), with
`MemoryTrustedOwnerStore` / `FileTrustedOwnerStore` implementations and
`TrustSource = 'genesis' | 'invite' | 'operator'`.

## What shipped

- **`TrustedOwnerStore`** (`trusted-owner-store.ts`, cross-platform export):
  interface + `MemoryTrustedOwnerStore`. Contract nuance beyond the original
  ticket: `trust()` reflects the key in `has()`/`all()` **synchronously**; the
  returned promise tracks durability only. Keys are additive — revocation is out
  of scope and documented as such.
- **`FileTrustedOwnerStore`** (Node-only subpath
  `@serfab/cadre-core/trusted-owner-store-file`): JSON at
  `<dir>/trusted-owners.<encoded partyId>.json` (0600, `{version:1, partyId,
  owners:{key:{source,trustedAt}}}`), crash-atomic temp+fsync+rename writes,
  serialized snapshot persists, one directory can hold several parties without
  leakage. Load policy after review (changed — see findings): absent / corrupt /
  unknown-shape / foreign-party ⇒ empty anchor; present-but-unreadable ⇒ throws.
- **Shared fs helpers** (`fs-atomic.ts`): atomic write + filename encoding +
  ENOENT check extracted from `key-store-file.ts`; both file stores share one
  implementation and `FileKeyStore` behavior is unchanged.
- **`CadreNodeConfig.trustedOwners`**: `{ store?, pinnedKeys?, pinnedSource? }`.
  An injected store scoped to another party fails `start()` closed before any
  network bring-up. No store injected ⇒ in-memory default. The store survives
  `stop()`→`start()` of the same node instance.
- **Seeding seams**: genesis (`initializeSeedBootstrap` anchors the derived
  public key), config pins (seeded in `start()`), runtime enrollment
  (`CadreNode.trustOwnerKeys(keys, 'invite'|'operator')`, called by the RN app
  with the invite's `ownerKeys` before `applySeed`), and operator pins
  (cadre-cli `--pin-owner-key` / `CADRE_OWNER_KEYS`). Accessor for tickets 4/5:
  `CadreNode.getTrustedOwnerStore()` (null before start).

## Review findings

### Checked

Read the implement diff first, then every file it touched and the ones it should
have: the three new cadre-core modules, the `key-store-file` refactor,
`cadre-node.ts` wiring, `types.ts`/`index.ts`/`package.json`, the cadre-cli
config + start path, the RN enrollment seam, and the architecture doc. Traced
**every** deployment path that establishes owner trust end-to-end — cadre-cli
`--owner`, cadre-host's owner node and its donated foreign-party node,
cadre-provider tenants, the `ops/docker` compose stack, the RN invite flow, and
reference-app-web — to check the anchor is actually seeded on each. Verified the
`node:fs` isolation claim by walking the cross-platform index import graph.

Ran: root `yarn typecheck` and `yarn lint` (both clean), cadre-core 682 passed /
1 skipped, cadre-cli 94, reference-app-rn 133. **Not run:** the real-network
`packages/integration-tests` suite — nothing in it consumes the store yet and no
scenario was touched (ticket 4 reworks them); and the cadre-host suite, since
nothing under `packages/cadre-host/src` changed (its doc did).

### Fixed in this pass (minor)

- **Present-but-unreadable anchor silently became an empty one, then got
  clobbered.** `FileTrustedOwnerStore.open` caught *every* `readFile` error and
  cold-started empty. For a transient or permission failure (EACCES, EISDIR,
  EIO) that both hides a real misconfiguration and lets the very next `trust()`
  snapshot-write **destroy a still-intact anchor file**. Now only ENOENT is a
  cold start; any other read error throws with the failing path and cause,
  mirroring `FileKeyStore.get`'s existing "do not clobber an existing key"
  policy. This was the exact question the implement handoff raised for review.
  Covered by a new test (anchor path replaced with a directory ⇒ `open()`
  rejects).
- **Provenance was persisted but never asserted.** No test read the file back,
  so a bug swapping or dropping `source`/`trustedAt` would have passed. Added a
  test asserting the on-disk `version`/`partyId`/per-key `source`/`trustedAt`
  and that re-trusting a known key with a *different* source keeps the original.
- **DRY**: `CadreNodeConfig.trustedOwners.pinnedSource` re-spelled the source
  union by hand — now `Exclude<TrustSource, 'genesis'>`, matching
  `trustOwnerKeys`. `encodeFileSafeComponent(partyId)` was recomputed in both
  path builders — hoisted to one field.
- **Doc**: `docs/cadre-host.md` said `<dataDir>` holds the identity key; it now
  also holds the trusted-owner anchor, so the identity paragraph says to back up
  and restore the two together.

### Major (new tickets): none

Deliberately none, with a reason rather than by omission. The one gap worth
worrying about is "which hosts get an ephemeral anchor", so it was checked
exhaustively: cadre-host's own node and any `cadre-cli` with a protobuf identity
get the file-backed store; cadre-provider tenants, the `ops/docker` stack, and
cadre-host's *donated* foreign-party nodes all receive their pinned owner keys
as `CADRE_OWNER_KEYS` on **every** spawn, so an in-memory anchor is re-seeded
from the operator's configuration at each start and loses nothing across
restarts. reference-app-web has no seed/enrollment path at all. That leaves the
React Native invite flow as the only place where trust arrives purely at runtime
and dies with the process — already filed as
`backlog/feat-rn-trusted-owner-anchor-persistence`. Nothing else rose to a
ticket.

### Tripwires (parked in code, not filed)

- `all()` copies into a fresh Set on every call — free at anchor sizes, but a
  `NOTE:` on the interface says to use `has()` or cache if a hot path ever calls
  it per message.
- Re-trusting an already-known key resolves immediately instead of joining the
  in-flight write chain, so "durable by the time `trust()` resolves" does not
  hold for a repeat key. Harmless for today's callers; `NOTE:` at the site.
- The genesis seam over-anchors on joiner nodes (a non-founder that wires
  seed-bootstrap with its own derived key self-anchors as `'genesis'`). The
  implementer's `NOTE:` in `initializeSeedBootstrap` was verified accurate and
  left in place — ticket 4's predicate tests should expect "own key may be in
  own anchor".

### Reviewed and accepted as-is (no change)

- Corrupt / unknown-shape / foreign-`partyId` files still cold-start empty:
  those are *decidable* non-anchors, and empty is the fail-closed direction for
  a trust anchor. Only the undecidable read error was promoted to a throw.
- A failed persist leaves the key trusted for the session (logged; the next
  successful `trust()` re-lands the full snapshot) — deliberate and documented.
- The fire-and-forget genesis persist in `initializeSeedBootstrap` is correct
  precisely because `trust()` reflects synchronously; only durability is
  deferred, and failure is logged.
- The `key-store-file` refactor is behavior-preserving (the `mkdir` moved inside
  `writeFileAtomically` in the same order); `key-store.spec.ts` is green.
- Persisting TOFU-accepted keys into the anchor stays out of scope — it is
  ticket 5's `seed-accepted-authority-persistence` slice.
