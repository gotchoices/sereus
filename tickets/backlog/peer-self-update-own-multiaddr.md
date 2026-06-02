----
description: A non-authority CadrePeer should be able to refresh its own Multiaddr using its own peer key (the AuthorizedUpdate own-key branch), so drones/phones whose addresses change stay dialable without re-involving an authority.
prereq: authority-self-registration-cadrepeer
files: packages/cadre-core/src/control-database.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/seed-bootstrap.ts, packages/cadre-core/src/authority-key.ts
----

## Context

`authority-self-registration-cadrepeer` makes an *authority* node persist and
refresh its own `CadrePeer` row using the authority key. That covers the host /
CLI `--authority` node. It does **not** cover a non-authority peer (a drone or
phone) that was authorized by an authority — possibly with an empty or stale
`Multiaddr` — and later needs to advertise a different, currently-dialable
address.

The `CadrePeer` schema already anticipates this: the `AuthorizedUpdate`
constraint (`packages/cadre-core/src/control-database.ts:70-75`) has an
own-key branch:

```
verify(digest(new.PeerId, 'sha256', 'utf8') || digest(new.Multiaddr, 'sha256', 'utf8'),
       context.Signature, new.PeerId, 'ed25519')
```

A peer can sign an update to its own `Multiaddr` with the Ed25519 key behind its
own PeerId — no authority involvement. The node already holds this key as
`config.privateKey` (a libp2p Ed25519 `PrivateKey`), and
`authorityKeyFromLibp2p()` (`packages/cadre-core/src/authority-key.ts`) shows
the seed/public-key bridge into the base64url form the crypto plugin consumes
— the same bridge would yield the peer's signing key here.

## Open question to resolve first (research)

The own-key branch verifies against `new.PeerId` *as the key*:
`verify(…, context.Signature, new.PeerId, 'ed25519')`. `new.PeerId` is a
base58btc libp2p PeerId string (e.g. `12D3Koo…`), not a base64url raw Ed25519
public key. Before building this, confirm how `@optimystic/quereus-plugin-crypto`'s
`verify` interprets that key argument:

- Does it decode a libp2p PeerId multihash to the embedded Ed25519 public key, or
- does the schema need to change to verify against a stored/derived raw public
  key (e.g. an added `PublicKey` column, or a `getPublicKey`-from-PeerId step)?

The existing `AuthorizedInsert`/authority branches deliberately verify against
`digest(PeerId, 'sha256', 'utf8')` with an *authority* key (a known base64url
key), sidestepping this question — so it is currently unverified whether the
own-key branch is satisfiable as written.

## Expected behavior

- A previously-authorized non-authority peer can update its own `CadrePeer`
  `Multiaddr` to its current dialable address set, authorized solely by a
  signature from its own peer key (the `AuthorizedUpdate` own-key branch).
- It cannot INSERT itself (that still requires an authority) and cannot mutate
  other peers' rows.
- This refresh path composes with authority self-registration so that every
  cadre member — authority or not — can keep a current, dialable `Multiaddr` in
  `CadrePeer`, giving intra-cadre discovery, seed peer lists, and strand-cohort
  bootstrap a complete and live data source.

## Use cases

- A phone/drone authorized with `multiaddrs: []` (NAT'd, address unknown at
  authorization time) later learns its dialable/relay address and publishes it
  to `CadrePeer` itself.
- A peer whose network address changes refreshes its row without round-tripping
  to an authority.
