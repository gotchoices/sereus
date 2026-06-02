----
description: Guard length-prefixed seed/ack frame parsing and sign seeds over a canonical serialization
files: packages/cadre-core/src/seed-bootstrap.ts, packages/cadre-core/src/canonical-json.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/seed-bootstrap.spec.ts, packages/cadre-host/src/update/manifest.ts
effort: medium
----

`SeedBootstrapService` (`packages/cadre-core/src/seed-bootstrap.ts`) frames seed and
ack messages as a 4-byte big-endian length prefix followed by JSON, and authenticates
seeds with an ed25519 signature over a JSON serialization of `{ partyId, peers }`. Two
classes of latent defect, both confirmed by direct reproduction:

## 1. Unguarded length-prefix parsing

Two parse sites read the declared length with `DataView.getUint32(0, false)` then
`slice(4, 4 + length)`:

- ack read in `deliverSeed`: `seed-bootstrap.ts:380-390`
- seed read in the inbound protocol handler: `seed-bootstrap.ts:509-519`

Confirmed failures:
- An empty / sub-4-byte buffer throws `RangeError: Offset is outside the bounds of the
  DataView` from `getUint32`, rather than a descriptive error.
- A frame whose declared length exceeds the bytes actually present slices short/empty and
  surfaces as an opaque `JSON.parse` SyntaxError. Reproduced: a 6-byte buffer declaring
  length 200 yields a 2-byte body slice.
- `MAX_SEED_SIZE` (`seed-bootstrap.ts:40`) bounds only the *accumulated* byte count in the
  inbound loop (`seed-bootstrap.ts:504`), never the declared `messageLength`/`responseLength`
  used in the slice. A frame can declare an out-of-bounds length while staying under the cap.

### Fix

Extract a single pure decoder and use it at both sites:

```ts
/** Decode a 4-byte big-endian length-prefixed frame; returns the body bytes. */
function decodeLengthPrefixedFrame(data: Uint8Array, maxLength = MAX_SEED_SIZE): Uint8Array {
  if (data.length < 4) {
    throw new Error(`Seed frame too short: ${data.length} bytes, need ≥4 for length prefix`);
  }
  const length = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0, false);
  const available = data.length - 4;
  if (length > maxLength) {
    throw new Error(`Seed frame declares length ${length} exceeding max ${maxLength}`);
  }
  if (length > available) {
    throw new Error(`Seed frame declares length ${length} but only ${available} body bytes present`);
  }
  return data.subarray(4, 4 + length);
}
```

Notes:
- Pass the full `(buffer, byteOffset, byteLength)` triple to `DataView` so the guard is
  correct even if a non-zero-offset view is ever passed (current callers pass fresh
  zero-offset arrays, but the helper should not assume it).
- Use `subarray` (view, no copy) — the result is immediately handed to `TextDecoder`.
- The inbound handler's existing accumulation cap stays; the helper's `maxLength` is the
  declared-length guard. Both bound by `MAX_SEED_SIZE`.

## 2. Seed signing relies on incidental JSON key order

`createSeed` signs `JSON.stringify({ partyId, peers })` (`seed-bootstrap.ts:225-240`).
`validateSeedSignature` independently rebuilds an object and re-stringifies it
(`seed-bootstrap.ts:423-431`), and — separately a real bug — conditionally spreads in a
`transactions` field that `createSeed`'s signed object never contains. Consequences:

- Correctness depends on literal key insertion order matching across the two code paths
  and surviving the wire round-trip. Any field reorder/addition, a non-spec seed producer,
  or a key-reordering round-trip would silently invalidate legitimate signatures.
- Latent today: any seed legitimately carrying `transactions` fails validation, because the
  verifier folds `transactions` into the signed digest while the creator does not. (Seed
  transactions are not yet populated — see `tickets/plan/seed-transactions-cache-prepopulation-unimplemented.md`
  — so this is dormant, not yet observable, but must not ship into the security boundary.)

Seed signature validation is a security boundary (`tickets/complete/1-seed-authority-validation.md`
builds authority checks directly on it), so the signed byte representation must be defined
and stable.

### Fix

Add a canonical JSON serializer to cadre-core and route both signing paths through one
shared payload builder.

There is already a battle-tested implementation in
`packages/cadre-host/src/update/manifest.ts` (`canonicalJson`, lines ~201-219: recursively
sort object keys, drop `undefined`, no whitespace, arrays preserve order — an RFC 8785
subset). **cadre-host depends on cadre-core, not the reverse**, so cadre-core cannot import
it; copy the implementation into a new `packages/cadre-core/src/canonical-json.ts`, export
`canonicalJson` from `packages/cadre-core/src/index.ts`, and have cadre-host re-import from
`@serfab/cadre-core` to keep DRY (delete the local copy in `manifest.ts`, keeping its
`signManifestForTesting`/verify call sites pointing at the shared export).

Then define one payload builder used by both seed paths so the signed bytes are identical
regardless of key order or optional-field presence:

```ts
import { canonicalJson } from './canonical-json.js';

/** Canonical byte representation of the authenticated seed fields. */
function canonicalSeedPayload(seed: Pick<ControlNetworkSeed, 'partyId' | 'peers' | 'transactions'>): string {
  // canonicalJson sorts keys and drops `undefined`, so {partyId, peers} and
  // {partyId, peers, transactions: undefined} serialize identically — and a seed
  // that does carry transactions is now signed/verified over the same bytes.
  return canonicalJson({ partyId: seed.partyId, peers: seed.peers, transactions: seed.transactions });
}
```

`createSeed` (`seed-bootstrap.ts:231`) signs `digest(canonicalSeedPayload(seedData), ...)`;
`validateSeedSignature` (`seed-bootstrap.ts:430`) verifies against
`digest(canonicalSeedPayload(seed), ...)`. Drop the ad-hoc `...(seed.transactions ? ...)`
spread.

## Test impact (must update, not just add)

The existing spec hand-rolls signing with raw `JSON.stringify` and will break once the
canonical form differs from insertion order (peer objects insert `peerId, multiaddrs,
isAuthority` but canonical sorts to `isAuthority, multiaddrs, peerId, publicKey`):

- `packages/cadre-core/test/seed-bootstrap.spec.ts:118` (`validateSeedSignature` positive case)
- `packages/cadre-core/test/seed-bootstrap.spec.ts:156` (tampered-data case — already `peers: []`, but route through the helper for consistency)
- `packages/cadre-core/test/seed-bootstrap.spec.ts:359` (`createSignedSeed` helper in the authority-validation block)

Update these to sign over the exported canonical payload (export a small test-usable seam,
or have the tests import `canonicalJson` and build `{ partyId, peers, transactions }`
themselves). Keep the negative/forged cases asserting the same outcomes.

## TODO

- [ ] Add `packages/cadre-core/src/canonical-json.ts` (port `canonicalJson` from `packages/cadre-host/src/update/manifest.ts`) and export it from `packages/cadre-core/src/index.ts`.
- [ ] Point `packages/cadre-host/src/update/manifest.ts` at the shared `canonicalJson` from `@serfab/cadre-core`; remove its local copy. Confirm cadre-host build + `manifest.test.ts` still pass.
- [ ] In `seed-bootstrap.ts`, add `canonicalSeedPayload(...)` and route both `createSeed` and `validateSeedSignature` through it; drop the conditional `transactions` spread.
- [ ] In `seed-bootstrap.ts`, add `decodeLengthPrefixedFrame(...)` and use it in `deliverSeed` (ack read, ~380-390) and the inbound handler (seed read, ~509-519), replacing the inline `getUint32`/`slice` logic.
- [ ] Update the three hand-rolled signing sites in `seed-bootstrap.spec.ts` (lines ~118, ~156, ~359) to use the canonical payload.
- [ ] Add unit tests: `decodeLengthPrefixedFrame` rejects sub-4-byte buffers, rejects declared-length > available, rejects declared-length > max, and decodes a valid frame; canonical signing is key-order independent; a seed carrying `transactions` validates (regression for the latent mismatch).
- [ ] `cd packages/cadre-core; yarn build 2>&1 | tee /tmp/cc-build.log` and `yarn test 2>&1 | tee /tmp/cc-test.log` — stream output, both green.
- [ ] `cd packages/cadre-host; yarn build 2>&1 | tee /tmp/ch-build.log` and `yarn test 2>&1 | tee /tmp/ch-test.log` — confirm the manifest refactor didn't regress.

References: `packages/cadre-core/src/seed-bootstrap.ts` (`createSeed`, `validateSeedSignature`,
`deliverSeed`, inbound handler), `packages/cadre-host/src/update/manifest.ts` (`canonicalJson`),
`tickets/complete/1-seed-authority-validation.md`,
`tickets/complete/3-deliverSeed-libp2p-v3-handler-signature.md`.
