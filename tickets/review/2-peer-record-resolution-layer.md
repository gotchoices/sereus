----
description: Review the peer-record resolution layer — CadrePeer rewritten into a signed, freshness-stamped PeerAddressRecord, with a self-publish path (CadreNode.registerSelf) and a transport-agnostic CadreNode.resolvePeerAddrs(peerId). Resolve a member's current signaling/relay multiaddrs from its PeerId alone.
files: schemas/control.qsql, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/peer-record.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/seed-bootstrap.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/peer-record.spec.ts, packages/cadre-core/test/peer-record-resolution.spec.ts, docs/architecture.md, docs/STATUS.md
----

## What landed

The `CadreControl.CadrePeer` row is now a **signed, freshness-stamped peer-address
record**, and `@serfab/cadre-core` gained both halves of the discovery flow:

1. **Publish** — `CadreNode.registerSelf()` (now public/awaitable/idempotent,
   replacing the no-op TODO) writes the node's own row: current dialable addrs
   (signaling `/p2p-circuit` first), an ed25519 `PublicKey` whose libp2p identity
   *is* the PeerId, a monotonic `UpdatedAt`, and a self-`Sig`.
2. **Resolve** — `CadreNode.resolvePeerAddrs(peerId, opts?)` reads that row,
   re-verifies the signature + `PublicKey↔PeerId` binding + freshness, applies a
   pluggable trust gate, and returns signaling-first `Multiaddr[]` (or `[]`).

### Schema (`schemas/control.qsql` + embedded copy in `control-database.ts` — kept in sync)

`CadrePeer` columns are now `PeerId pk, PublicKey text null, Multiaddr text,
UpdatedAt int null, Sig text null`.

- `AuthorizedInsert` unchanged (authority signs `digest(PeerId)`); it now also
  vouches the `PublicKey↔PeerId` binding, which cadre-core enforces *by
  construction* (it DERIVES `PublicKey` from the PeerId, never trusts a caller).
- `AuthorizedUpdate` self-branch (the previously-broken "peer updates own
  multiaddr" path) is rewritten to verify `new.Sig` against the stored
  `new.PublicKey` — fixing the original defect where it verified against
  `new.PeerId` (a base58 multihash) as if it were a base64url key. It also
  enforces immutable `PeerId`/`PublicKey` and strictly-increasing `UpdatedAt`
  (replay/rollback guard). The authority-override branch is preserved.

### Signed payload — a deliberate deviation from the ticket, please confirm

The ticket's record comment said `sig = ed25519(canonical(peerId,publicKey,addrs,updatedAt))`
and sketched three concatenated base64url digests. I instead sign a **single**
digest of a pipe-delimited string, mirrored exactly in the SQL constraint:

```
peer-record.ts:  digest(`${peerId}|${multiaddr}|${updatedAt}`, 'sha256','utf8','base64url')
control.qsql:    digest(new.PeerId || '|' || new.Multiaddr || '|' || cast(new.UpdatedAt as text), 'sha256','utf8')
```

Rationale (the ticket explicitly granted this latitude): (a) a single digest
round-trips cleanly as base64url, whereas concatenating several 43-char base64url
digests and re-decoding is fragile; (b) `publicKey` is excluded because it is the
key the signature is verified *with* (a sig already commits to exactly one key)
and its PeerId binding is checked separately — re-signing it adds nothing; (c)
plain string-concat + sha256 is trivially deterministic cross-platform, no JSON
canonicalizer needed. **Reviewer: confirm this trade-off is acceptable** (it is
the single source of truth, in `peerRecordSignedPayload`, used by publish,
resolve, and the SQL constraint — keep all three byte-identical if changed). The
`'|'` delimiter is safe: base58 PeerId / multiaddr (`/`-delimited) / base-10 int
never contain it.

### Sig is persisted and re-verified at read time (not just write time)

The row carries `Sig`, so `resolvePeerAddrs` verifies the record **independently**
of trusting that the write path enforced the constraint — this is what makes a
resolved address "trust-checkable" per the title. Consequence: an
**authority-inserted row for *another* peer has `Sig = null`** (the authority
cannot produce that peer's self-signature) and therefore **resolves to `[]` until
that peer self-publishes**. This is intentional (we want self-attested *current*
addrs, not authority guesses), but it is a behavior worth a careful look.

## Validation performed

- `yarn typecheck` + `yarn build` (cadre-core): clean. `cadre-cli` + `cadre-host`
  typecheck clean against the rebuilt cadre-core (public surface change is purely
  additive).
- `yarn test` (cadre-core): **260 passed (19 files)**, including the two new specs:
  - `test/peer-record.spec.ts` — 16 pure-helper tests (payload determinism &
    golden value vs `digest`, sign/verify round-trip, tamper/wrong-key/missing-key
    rejection, freshness boundaries, signaling-first ordering, default trust policy).
  - `test/peer-record-resolution.spec.ts` — 10 tests against a **real Quereus
    control DB** (boots a real CadreNode, transaction profile). These are the only
    coverage of the rewritten SQL constraint.

### Key scenarios covered (the floor — extend, don't trust as exhaustive)

- **Publish + resolve:** after `registerSelf`, the own row has the derived
  `PublicKey`, positive monotonic `UpdatedAt`, a verifying `Sig`; `resolvePeerAddrs`
  returns addrs signaling-first; `signalingOnly` returns only `/p2p-circuit`.
- **Cross-peer resolve:** a *different* member (minted + inserted with its own
  valid self-sig) resolves from its PeerId alone.
- **Monotonic/replay:** a self-update with `UpdatedAt <= old` is rejected *by the
  constraint*; the stored row is unchanged.
- **Wrong-key:** a self-update whose `Sig` is by a key other than the row
  `PublicKey` is rejected by the constraint.
- **Freshness:** a record past `maxAgeMs` resolves to `[]` (never a dead relay).
- **Binding mismatch:** a row whose stored `PublicKey` isn't the key embedded in
  the PeerId resolves to `[]`.
- **No self-pub / non-member:** an authority-inserted (null-`Sig`) member, and a
  stranger PeerId, both resolve to `[]`.
- **Trust gate:** an injected `{ evaluate: () => false }` filters an otherwise
  valid record before any addr is returned.

## Gaps / risks to probe (work treated as a starting point)

1. **Overlaps two sibling tickets — needs reconciliation.** This ticket fully
   implements self-registration, subsuming `tickets/implement/authority-self-registration-cadrepeer.md`
   (authority-only insert/refresh, no schema change) and the open question in
   `tickets/backlog/peer-self-update-own-multiaddr.md` (the verify-against-PeerId
   defect — *resolved here* by the `PublicKey` column). Those tickets' designs now
   conflict with the schema landed here. **I did NOT do the sibling's CLI wiring or
   its removal of `scheduleSelfRegistration`** (see #2). The reviewer should decide
   whether to (a) re-scope/close the sibling implement ticket, or (b) let it run
   and adapt. I left mine self-contained and did not edit the sibling files.
2. **Production auto-publish for the authority node is NOT fully wired.**
   `registerSelf` is invoked from a hardened 1s `scheduleSelfRegistration` timer
   that now safely no-ops when it can't sign/insert. But an authority installs its
   key *after* `start()` (CLI `initializeSeedBootstrap`), so the 1s timer fires too
   early for the first *insert*; the TTL heartbeat (7.5 min) would eventually catch
   it, but the clean fix is an explicit `await node.registerSelf()` in the CLI
   `--authority` branch after `initializeSeedBootstrap` (that wiring was the
   sibling ticket's deliverable and is left undone here). Self-*update* (refresh)
   on restart works from the timer since it needs only `config.privateKey`.
3. **Self-publish requires `config.privateKey`.** The signing key is sourced from
   `config.privateKey` (the CLI/host always provide it). A node whose libp2p
   identity was generated internally (no `config.privateKey`) cannot self-sign and
   `registerSelf` logs + skips — I found no clean way to extract a libp2p node's
   private key post-construction. Confirm all production entry points pass it.
4. **Refresh triggers are verified by logic, not live.** The `self:peer:update`
   listener and the `maxAgeMs/2` heartbeat both just call `registerSelf`; tests
   prove repeated `registerSelf` produces a monotonic republish with changed
   addrs, but the actual event firing / timer / a real relay-reservation rotation
   are not exercised (no relay in unit tests).
5. **Resolve reads only the local control DB.** It assumes the target's `CadrePeer`
   row has already replicated to this node (Optimystic pull-on-read); there is no
   active fetch/wait — an un-synced row resolves to `[]`.
6. **Wall-clock freshness.** `updatedAt`/`maxAgeMs` use `Date.now()`; publisher↔
   resolver clock skew can shift the freshness verdict (standard TTL caveat).
7. **Trust gate default is permissive** (any existing member row passes). The
   `PeerResolveTrustPolicy` seam is in place for `seed-signerkey-trust-policy` to
   inject a stricter policy later; that wiring is not done.
8. **The resolver imports no WebRTC** (as required) — it returns `Multiaddr[]` for
   any transport; unparsable stored addrs are dropped (logged), not thrown.

## Out of scope (correctly deferred)

- FRET-backed, coordinate-keyed record/liveness store: `tickets/backlog/fret-backed-peer-record-liveness.md`.
- Strand-cohort bootstrap wiring: `tickets/complete/bootstrap-dht-discovery-and-strand-cohort-wiring.md` (shares the CadrePeer substrate; kept coherent).
