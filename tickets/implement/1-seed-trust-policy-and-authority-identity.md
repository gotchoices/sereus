----
description: Replace self-asserting seed trust gate with an external trust anchor; source authority identity from the AuthorityKey table
files: packages/cadre-core/src/seed-bootstrap.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/authority-key.ts, schemas/control.qsql, docs/architecture.md
effort: high
----

## Problem

`applySeed` (`packages/cadre-core/src/seed-bootstrap.ts:299-358`) bootstraps trust entirely from data inside the seed. After verifying the ed25519 signature over `seed.signerKey`, the only authority check is:

```ts
const signerIsAuthority = seed.peers.some(
  p => p.isAuthority && p.publicKey === seed.signerKey
);
```

Both inputs (`signerKey` + the `isAuthority`/`publicKey` peer fields) are attacker-controllable. A forged self-consistent seed — one that lists the attacker's own key as an authority peer and is self-signed — passes both the signature check and the authority check. There is no out-of-band root of trust. This is reachable over the network — see the companion ticket `seed-network-path-authn`, which hardens the unauthenticated `POST /seed` surface.

A compounding defect in `queryPeers` (`seed-bootstrap.ts:489-520`): `isAuthority` is derived from the libp2p `peerId` (`peerId === this.libp2pNode?.peerId.toString()`), and the `authorityKeys` set built from `CadreControl.AuthorityKey` is constructed but never consulted. Consequences:
- A seed created by authority node A cannot mark authority node B as an authority → multi-authority cadres are unrepresentable.
- The libp2p `peerId` (base58btc transport identity) is conflated with the ed25519 `AuthorityKey` identity.

## Design

### Trust anchor model

The trust decision for `signerKey` must rest on an anchor that does **not** come from the seed body. Anchors, in priority order:

1. **DB-anchored** — the receiving node's `CadreControl.AuthorityKey` table. Any key already present there is trusted (the node is already enrolled / has synced control state). This is the steady-state anchor.
2. **Pinned out-of-band** — authority keys supplied to the node from outside the seed: carried by a `CadreInvite` (new `authorityKeys` field), or pinned by an operator via config/env. This is the cold-start anchor.
3. **TOFU (opt-in)** — for interactive hosts only, an explicit confirmation callback invoked on first sight of an unknown signer key. Not enabled by default; cadre-host can wire it to its trust-circle UI later.

Secure default: a cold-start node with an empty `AuthorityKey` table, no pinned keys, and no TOFU confirmation **rejects** the seed. This is the intended behavior change — a seed can no longer vouch for its own signer.

### `SeedTrustPolicy` abstraction

Introduce a small policy interface in cadre-core (new file `packages/cadre-core/src/seed-trust-policy.ts`):

```ts
export interface SeedTrustContext {
  partyId: string;
  signerKey: string;                         // ed25519 base64url, already signature-verified
  knownAuthorityKeys: ReadonlySet<string>;   // from the receiver's AuthorityKey table — NOT the seed
}

export interface SeedTrustDecision {
  trusted: boolean;
  reason?: string;
}

export interface SeedTrustPolicy {
  evaluate(ctx: SeedTrustContext): Promise<SeedTrustDecision> | SeedTrustDecision;
}
```

Concrete policies:
- `dbAnchoredTrustPolicy()` — `trusted = knownAuthorityKeys.has(signerKey)`. The default.
- `pinnedKeyTrustPolicy(pinned: Iterable<string>)` — trusts `knownAuthorityKeys ∪ pinned`. Built from `invite.authorityKeys` or operator config.
- `tofuTrustPolicy(confirm: (ctx) => Promise<boolean>)` — trusts DB keys; on an unknown key invokes `confirm`. Opt-in.

`applySeed` then becomes:

```ts
if (!this.validateSeedSignature(seed)) return reject('Invalid seed signature');
const knownAuthorityKeys = await this.controlDatabase.getAuthorityKeys();  // Set<string>
const decision = await this.trustPolicy.evaluate({ partyId: seed.partyId, signerKey: seed.signerKey, knownAuthorityKeys });
if (!decision.trusted) return reject(decision.reason ?? 'Signer key not trusted by trust policy');
// ...existing peer-store population / dialing
```

The self-asserting `seed.peers.some(...)` check is deleted. `trustPolicy` is supplied via `SeedBootstrapConfig` (default `dbAnchoredTrustPolicy()`), and `applySeed` accepts an optional per-call override so an enrollment caller can pass a `pinnedKeyTrustPolicy` derived from an invite without reconfiguring the service.

### Authority identity from the AuthorityKey table (queryPeers fix)

Authority identity must be sourced from `CadreControl.AuthorityKey`, decoupled from the transport peer ID. The link between a `CadrePeer.PeerId` (base58btc) and an `AuthorityKey.Key` (ed25519 base64url) is **derivable**, not stored: an Ed25519 libp2p PeerId embeds its public key (identity multihash). For each peer:

```
pubKeyB64 = base64url(peerIdFromString(peerId).publicKey.raw)   // 32-byte ed25519 key
isAuthority = authorityKeys.has(pubKeyB64)
publicKey   = isAuthority ? pubKeyB64 : undefined
```

This makes any authority node (not just self) correctly markable, and ties `isAuthority` to the `AuthorityKey` table rather than to `peerId === self`. Guard the cases where `peerId` is not Ed25519 or `publicKey` is undefined → treat as non-authority (do not throw the whole seed creation).

> Verify during implementation that `peerIdFromString(id).publicKey?.raw` yields the 32-byte ed25519 key whose base64url matches `authorityKeyFromLibp2p().publicKeyB64` for the self node (it should, per the derivation note in `authority-key.ts:15-30`). If libp2p does not expose the embedded key synchronously, fall back to `publicKeyFromProtobuf`/`peerIdFromString` accessor available in libp2p 3.x.

### Invite carries authority keys

Add `authorityKeys?: string[]` to `CadreInvite` (`types.ts:532-543`). Populate it in `createInvite` (`seed-bootstrap.ts:682-719`) from `controlDatabase.getAuthorityKeys()`. This is the out-of-band channel that lets a cold-start invitee pin the trusted authority set before applying any seed. cadre-host's trust-circle issues invites through `createInvite`, so the keys propagate automatically.

### Control database helper

Add `getAuthorityKeys(): Promise<Set<string>>` to `ControlDatabase` (`control-database.ts`) — `select Key from CadreControl.AuthorityKey`. `queryPeers` and `applySeed` both consume it instead of re-issuing the raw query inline.

### Out of scope (documented deferrals — see backlog ticket `seed-accepted-authority-persistence`)

- Persisting an accepted cold-start signer key into the node's own `AuthorityKey` table (so subsequent seeds become DB-anchored). The `AuthorityKey` control table is governed by signed-transaction constraints (`schemas/control.qsql:22-34`) and a local genesis insert is only valid when the table is empty — establishing it for a node joining an *existing* party belongs to the broader control-sync design. Until then, cold-start enrollment requires pinned keys each time, which is correct if less convenient.
- Applying `seed.transactions[]` to pre-populate the control cache (currently `applySeed` ignores them entirely).

## Key tests

- **Forged self-asserting seed is rejected.** Build a seed signed by an attacker key that lists itself as `isAuthority: true`; apply to a node with an empty `AuthorityKey` table and default policy → `{ success: false }`, reason mentions trust policy. (This is the regression that the current code fails.)
- **DB-anchored accept.** Seed signed by a key present in the receiver's `AuthorityKey` table → accepted.
- **Pinned-key accept.** Empty DB, signer key supplied via `pinnedKeyTrustPolicy` (as from an invite) → accepted; a *different* signer not in the pinned set → rejected.
- **TOFU.** `tofuTrustPolicy` with `confirm` returning false → rejected; returning true → accepted; `confirm` invoked exactly once with the unknown key.
- **queryPeers multi-authority.** Given two CadrePeers whose embedded ed25519 keys are both in `AuthorityKey`, both seed peers come back `isAuthority: true` with `publicKey` set — even though only one matches the local node's peerId.
- **queryPeers non-authority.** A CadrePeer whose key is absent from `AuthorityKey` → `isAuthority: false`, no `publicKey`.
- **Invite carries keys.** `createInvite` output includes `authorityKeys` matching the `AuthorityKey` table.
- Signature-still-required: a seed with a valid trust anchor but a bad signature is still rejected.

## TODO

- [ ] Add `getAuthorityKeys(): Promise<Set<string>>` to `ControlDatabase`.
- [ ] Create `packages/cadre-core/src/seed-trust-policy.ts` with the `SeedTrustPolicy` interface and `dbAnchoredTrustPolicy` / `pinnedKeyTrustPolicy` / `tofuTrustPolicy` factories; export from `index.ts`.
- [ ] Add `trustPolicy?: SeedTrustPolicy` to `SeedBootstrapConfig`; default to `dbAnchoredTrustPolicy()`.
- [ ] Rewrite `applySeed`: drop the `seed.peers.some(...)` self-assertion; consult `trustPolicy.evaluate` against `knownAuthorityKeys` from the DB; accept an optional per-call policy override.
- [ ] Thread the optional policy/pinned-keys override through `CadreNode.applySeed` (`cadre-node.ts:789-801`), including the temp-service path.
- [ ] Rewrite `queryPeers` to derive `isAuthority`/`publicKey` from `peerIdFromString(peerId).publicKey.raw` ∩ the `AuthorityKey` table; guard non-Ed25519 / missing keys.
- [ ] Add `authorityKeys?: string[]` to `CadreInvite`; populate in `createInvite`.
- [ ] Update `docs/architecture.md:292-296`: replace the self-asserting validation bullet and the `TODO: enforce a trust policy` line with the trust-anchor model (DB-anchored / pinned-via-invite / opt-in TOFU; cold-start-without-anchor rejects). Note authority identity is sourced from `AuthorityKey`, not `peerId`.
- [ ] Add unit tests above to `packages/cadre-core` test suite.
- [ ] `yarn build` + `yarn test` in `packages/cadre-core` (stream output with `| tee`).
