----
description: Peer-record resolution layer — CadrePeer is now a signed, freshness-stamped PeerAddressRecord with a self-publish path (CadreNode.registerSelf) and a transport-agnostic resolver (CadreNode.resolvePeerAddrs(peerId)) that re-verifies signature + PublicKey↔PeerId binding + freshness + a pluggable trust gate. Resolves a member's current signaling/relay multiaddrs from its PeerId alone.
files: schemas/control.qsql, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/peer-record.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/seed-bootstrap.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/peer-record.spec.ts, packages/cadre-core/test/peer-record-resolution.spec.ts, docs/architecture.md, docs/STATUS.md
----

## What shipped

`CadreControl.CadrePeer` became a **signed, freshness-stamped peer-address
record**, and `@serfab/cadre-core` gained both halves of the discovery flow:

- **Publish** — `CadreNode.registerSelf()` (public/awaitable/idempotent) writes
  the node's own row: signaling-first dialable addrs, an ed25519 `PublicKey`
  whose libp2p identity *is* the PeerId, a monotonic `UpdatedAt`, and a self
  `Sig`. Wired to a hardened startup timer + a `self:peer:update` listener + a
  TTL heartbeat (`maxAgeMs/2`).
- **Resolve** — `CadreNode.resolvePeerAddrs(peerId, opts?)` reads the row and
  gates it: record present → `PublicKey↔PeerId` binding → self-signature →
  freshness → pluggable trust policy → signaling-first `Multiaddr[]` (or `[]`).
  Imports no WebRTC; unparsable stored addrs are dropped/logged, not thrown.
- **Schema** — `CadrePeer (PeerId pk, PublicKey null, Multiaddr, UpdatedAt null,
  Sig null)`. The `AuthorizedUpdate` self-branch was rewritten to verify
  `new.Sig` against the stored `new.PublicKey` (fixing the original defect that
  verified against `new.PeerId` as if a base58 multihash were a key), with
  immutable `PeerId`/`PublicKey` and strictly-increasing `UpdatedAt` (replay
  guard). The single source of truth for the signed bytes is
  `peer-record.ts:peerRecordSignedPayload`, mirrored byte-for-byte in the SQL
  constraint.

## Review findings

### Scope / what was checked
Read the full implement diff (commit `0b4e702`) with fresh eyes before the
handoff: `peer-record.ts`, the `types.ts` additions, both schema copies
(`schemas/control.qsql` + the embedded copy in `control-database.ts`),
`control-database.ts` query/update methods, the `seed-bootstrap.ts` insert
rewrite, `cadre-node.ts` publish/resolve/refresh paths, `index.ts` exports, and
both new spec files. Cross-checked all callers of the new API across `packages/`
and the doc surface (`architecture.md`, `STATUS.md`, `cadre-host.md`).
Re-ran `yarn typecheck` (clean) and `yarn test` (now **261 passed, 19 files**).

### Deviation confirmation (handoff asked the reviewer to sign off)
**Confirmed acceptable.** The signed payload is a single base64url SHA-256 digest
of `peerId|multiaddr|updatedAt`, not three concatenated digests, and excludes
`publicKey`. Rationale holds: (a) a single digest round-trips cleanly as
base64url; (b) the signature already commits to exactly one key and the
`PublicKey↔PeerId` binding is checked separately at resolve, so re-signing the
key adds nothing; (c) plain string-concat + sha256 is deterministic
cross-platform and reconstructable inside the SQL constraint. The TS-sign ↔
SQL-verify round trip is proven end-to-end against a real Quereus control DB by
`peer-record-resolution.spec.ts` (the self-update succeeds, and the replay /
wrong-key updates are rejected by the constraint). Maintenance note preserved:
`peerRecordSignedPayload` and the `AuthorizedUpdate` digest expression must stay
byte-identical if either changes.

### Correctness — no defects found
The five resolve gates, the monotonic/immutable/own-key constraint branches, the
`queryPeerRecord` round-trip (`split(',')` is the exact inverse of `join(',')`),
and the `orderSignalingFirst`-after-verify ordering were all traced and are
correct. NULL handling is right: a `PublicKey = null` row (authority-inserted for
a non-Ed25519 peer, or pre-self-publish) can never satisfy the self-branch
(`null = null` is not true in SQL) and resolves to `[]` — intentional and tested.
The `PublicKey↔PeerId` binding is enforced at *read* time (resolve re-derives the
key from the PeerId), which correctly compensates for the `AuthorizedInsert`
constraint not itself binding the key column.

### Tests — one coverage gap filled inline (minor)
The implementer's specs are a solid floor (16 helper + 10 DB tests). Gap found
and fixed in this pass: the **non-authority drone self-update** path (peer
refreshes its own row with its *own* key, key distinct from the authority key)
was only exercised implicitly via the authority node, whose signing key happens
to equal the authority key. Added
`peer-record-resolution.spec.ts` → *"lets a NON-authority member self-update its
own row with its OWN key, then resolves"*: authority inserts a drone (Sig null →
resolves `[]`), the drone signs an update with its own key, `updateSelfPeerRecord`
succeeds via the self-branch, and the row then resolves signaling-first.
Suite: **261 passed**.

### Cross-ticket reconciliation (the handoff's flagged major) — resolved
- `tickets/implement/authority-self-registration-cadrepeer.md` — **re-scoped**.
  `registerSelf` (public/awaitable/idempotent) and the schema change already
  landed here, so its original instruction to *delete* `scheduleSelfRegistration`
  now conflicts (this ticket's refresh path depends on that hardened timer +
  heartbeat). Rewrote it to its genuinely-remaining work: the explicit
  `await node.registerSelf()` in the CLI `--authority` branch (fixes the
  first-insert latency in risk #2 below), the in-process test member-count
  fixes, the seed-includes-authority verification test, and the doc updates.
  Added `prereq: peer-record-resolution-layer`.
- `tickets/backlog/peer-self-update-own-multiaddr.md` — **deleted as subsumed**.
  Its open research question (does `verify` accept a base58 PeerId as the key? —
  no) is answered by the `PublicKey` column, and its expected behavior
  (non-authority peer self-updates its own Multiaddr with its own key) is
  implemented here and now explicitly tested (see the inline test above). Nothing
  referenced it as a prereq.

### Known risks / deferred (documented, not fixed — out of scope for this layer)
- **First-insert latency for the authority node (major, but owned by the
  re-scoped sibling).** The 1s startup timer fires before the authority key is
  installed, so the authority's own row is not written until the ~7.5 min
  heartbeat; seeds minted in that window omit the authority peer. The clean fix
  (explicit `registerSelf()` in the CLI `--authority` path) is the re-scoped
  `authority-self-registration-cadrepeer` deliverable — left to that ticket
  rather than duplicated here.
- **Resolve reads only the local control DB** — no active fetch/wait; an
  un-replicated row resolves to `[]`. FRET-backed liveness is future work
  (`tickets/backlog/fret-backed-peer-record-liveness.md`).
- **Wall-clock freshness** — `updatedAt`/`maxAgeMs` use `Date.now()`; publisher↔
  resolver clock skew can shift the verdict (standard TTL caveat).
- **Self-publish requires `config.privateKey`** — a node whose libp2p identity
  was generated internally cannot self-sign; `registerSelf` logs + skips. All
  production entry points (CLI/host) pass it.
- **Trust gate default is permissive** (any existing member row passes). The
  `PeerResolveTrustPolicy` seam is in place for a stricter policy
  (`seed-signerkey-trust-policy` / `wire-pinned-trust-into-coldstart-seed-callers`).
- **`registerSelf` no longer early-returns on zero addrs** (the old stub did).
  Benign: an empty-addr record resolves to `[]` and the heartbeat still bumps
  `UpdatedAt`; not worth a guard.
- **Schema is duplicated** (`schemas/control.qsql` vs the embedded copy in
  `control-database.ts`) and kept in sync by hand — drift risk already tracked by
  `tickets/implement/control-schema-drift-guard.md`; no new ticket filed.

### Lint / build
`@serfab/cadre-core` has no `lint` script (the repo's root `lint` is per-workspace
and skips it); `tsc -p tsconfig.build.json --noEmit` is the type gate and passes
clean. `yarn test` passes (261/261).
