----
description: Build a small on-device list of "these are my party's real authority keys," set from the invite that enrolled the node (or from being the founder). Unlike the shared database, this list cannot be polluted by strangers, so it is a trustworthy basis for deciding who is a real member.
prereq: membership-cadrepeer-voucher-persist
files:
  - packages/cadre-core/src/seed-trust-policy.ts (pinnedKeyTrustPolicy L73, dbAnchoredTrustPolicy L53 — same anchor concept, replicated source)
  - packages/cadre-core/src/cadre-node.ts (initializeSeedBootstrap, makeOwnAuthority/genesis path, config)
  - packages/cadre-core/src/control-database.ts (getAuthorityKeys L390 — the REPLICATED set, which the spike proved is pollutable)
  - packages/cadre-core/src/key-store-file.ts (existing node-local on-disk persistence pattern to mirror)
  - packages/cadre-core/src/types.ts (CadreNodeConfig; where to surface pinned authority keys)
  - tickets/backlog/seed-accepted-authority-persistence.md (the deferred design this pulls forward — its "separate node-local pinned-trust store distinct from the control DB")
difficulty: hard
----

# A node-local, non-replicated trusted-authority anchor

Step 3 of the Option-B chain, and the crux. The spike in
`membership-gate-authority-anchor-decision` proved the shared `AuthorityKey` table
(`control-database.ts getAuthorityKeys`) is polluted the instant an outsider that
self-mints an authority connects — its key replicates into every peer's local table.
So no read of the shared store can anchor trust. This ticket builds the anchor that
can: a **node-local, non-replicated** record of "these are *my* party's authority
keys," established out-of-band. This is the interim "separate node-local pinned-trust
store distinct from the control DB" named in `seed-accepted-authority-persistence`.

**This ticket builds and seeds the store only.** It does NOT yet change the membership
predicate or any gate (that is ticket 4) — so nothing breaks here. Land it, unit-test
it, wire its seeding, done.

## Interface

```ts
export interface TrustedAuthorityStore {
  /** Party this anchor is scoped to. */
  readonly partyId: string;
  /** Is this ed25519 (base64url) key one of my party's out-of-band-trusted authorities? */
  has(authorityKey: string): boolean;
  /** All anchored authority keys (for seed-trust `knownAuthorityKeys` in ticket 5). */
  all(): ReadonlySet<string>;
  /** Add a key established out-of-band (genesis self-trust / invite pin / operator). */
  trust(authorityKey: string, source: 'genesis' | 'invite' | 'operator'): Promise<void>;
}
```

Two implementations, chosen by whether the node has durable storage:

- **File-backed** (default for host/CLI): persisted next to the identity key, mirroring
  `key-store-file.ts` (JSON, `0600`). Survives restart — an enrolled member keeps
  trusting its party's authorities without re-supplying the invite.
- **In-memory** (ephemeral/test nodes with no identity key): same interface, no disk.

The store is keyed by `partyId` and is **never** sourced from the replicated control
DB. That is the whole point.

## Seeding — where the out-of-band trust enters

- **Genesis / founder.** When a node establishes its OWN authority (the
  `insertAuthorityKey` genesis path used by `makeOwnAuthority` in tests and by the host
  when a user founds a party), also `trust(ownAuthorityPub, 'genesis')`. A founder
  trusts its own authority key by construction.
- **Invited member.** An invite (`CadreInvite.authorityKeys`, the same pinned keys
  `pinnedKeyTrustPolicy` consumes) carries the party's genuine authority keys out of
  band. On enrollment, `trust(k, 'invite')` for each. Find the enrollment seam where
  the invite's authority keys are already available (the `pinnedKeyTrustPolicy`
  construction site) and persist them into the anchor there.
- **Operator pin** (optional, host): a `cadre-host` command / config path to pin a key
  manually. Can be minimal or deferred to a fast-follow — note which.

Wire the store into `CadreNode` (construct in `start`, from config + persistence),
expose it internally for ticket 4's predicate and ticket 5's gater. Add a config
surface on `CadreNodeConfig` for pinned authority keys and the store's persistence
location.

## Edge cases & interactions

- **Ephemeral test nodes with no identity key** must still work: in-memory store,
  seeded by whatever `makeOwnAuthority` does. The existing integration helpers
  (`makeOwnAuthority`) become the seam that seeds genesis self-trust — ticket 4 reworks
  the tests that rely on this.
- **A node that both genesis'd AND later gets more authorities** — `trust()` is
  additive; keys are never removed by this ticket (revocation is out of scope; note it).
- **Cross-platform**: file-backed store must not be imported into the RN/browser bundle
  path — follow the same server-only isolation `key-store-file` uses; the cross-platform
  entry re-exports only types/in-memory. Verify Metro/Vite do not pull `node:fs`.
- **Persistence format + location** — choose and document (JSON alongside identity key).
  A corrupt/absent file is a cold start (empty anchor), not a crash — fail to empty.
- **Idempotent seeding** — enrolling twice, or restarting, must not duplicate or error.

## TODO

- Define `TrustedAuthorityStore` + file-backed and in-memory implementations
  (server-only isolation for the file one), with unit tests (persist/reload, idempotent
  trust, cold-start empty).
- Seed genesis self-trust at the `insertAuthorityKey` genesis / `makeOwnAuthority` seam.
- Seed invite-pinned keys at the `pinnedKeyTrustPolicy` construction seam on enrollment.
- Add `CadreNodeConfig` surface (pinned keys + persistence path); construct + hold the
  store in `CadreNode.start`.
- Do NOT change any membership predicate or gate here.
- `yarn lint` / `yarn typecheck` / cadre-core unit tests green; confirm no `node:fs`
  leaks into the cross-platform bundle.
