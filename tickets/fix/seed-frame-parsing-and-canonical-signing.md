----
description: Seed/ack frame parsing can throw on short frames and signing relies on incidental JSON key order
files: packages/cadre-core/src/seed-bootstrap.ts
----

`SeedBootstrapService` exchanges seeds and acknowledgements over libp2p streams using a length-prefixed framing (4-byte big-endian length followed by JSON), and authenticates seeds with an ed25519 signature over a JSON serialization of the seed payload. Both the framing parser and the signing scheme currently make assumptions that are not enforced, producing failures that are hard to diagnose at cold start and a signature scheme whose correctness depends on incidental serialization behavior rather than a defined canonical form.

## Frame length parsing lacks guards

On both the ack-read path in `deliverSeed` and the seed-read path in the inbound protocol handler, all stream chunks are concatenated into a single buffer and then parsed with `new DataView(...).getUint32(0, false)` to read the declared length, followed by `data.slice(4, 4 + length)` to extract the JSON body:

- ack read: `packages/cadre-core/src/seed-bootstrap.ts:380-390`
- seed read: `packages/cadre-core/src/seed-bootstrap.ts:509-519`

Neither path verifies that at least 4 bytes were received before calling `getUint32(0, false)`, so an empty or truncated frame causes a `RangeError` rather than a clean, descriptive failure. Neither path validates that the declared length fits within the received buffer before slicing; `slice` will silently return a short/empty buffer, leading to an opaque `JSON.parse` error. The existing `MAX_SEED_SIZE` check at `seed-bootstrap.ts:504` bounds only the total accumulated byte count, not the declared `messageLength`/`responseLength` value used in the slice, so a frame can declare a length that is out of bounds while staying under the accumulation cap. The net effect is that malformed, partial, or peer-incompatible frames surface as low-level runtime exceptions, making cold-start and cross-network bootstrap failures difficult to triage.

## Seed signing relies on incidental JSON key order

`createSeed` signs `JSON.stringify({ partyId, peers })` (`seed-bootstrap.ts:225-240`), and `validateSeedSignature` independently reconstructs an object and re-stringifies it before verifying (`seed-bootstrap.ts:423-431`). The verifier's reconstructed object also conditionally spreads in a `transactions` field that the creator's signed object does not include, so the two serializations are already shaped differently. More broadly, correctness depends entirely on the literal key insertion order matching between the two code paths and surviving the JSON wire round-trip on the wire. There is no canonical or deterministic serialization: any future field reordering or addition, a different (non-spec) seed producer, or a JSON round-trip that reorders keys would silently invalidate otherwise-legitimate signatures, or worse, mask a mismatch. Seed signature validation is a security boundary (authority validation builds directly on it), so the signed byte representation must be defined and stable rather than emergent.

## Expected behavior

- On both the ack-read and seed-read paths, validate the frame before slicing: require at least 4 bytes to be present, read the declared length, and confirm that the declared length is within sane bounds and does not exceed the bytes actually available after the 4-byte prefix. On violation, fail with a clear, descriptive error rather than a `RangeError` or an opaque `JSON.parse` failure.
- Use a canonical / deterministic serialization (for example, sorted keys or explicit, fixed field concatenation) for the signed seed payload, shared by `createSeed` and `validateSeedSignature`, so that the signed byte sequence is well-defined and identical across both paths regardless of key insertion order, optional-field presence, or wire round-trips.

References: `packages/cadre-core/src/seed-bootstrap.ts` (`createSeed`, `validateSeedSignature`, `deliverSeed`, and the inbound seed protocol handler). Related completed work: `tickets/complete/1-seed-authority-validation.md` (signature-derived authority checks) and `tickets/complete/3-deliverSeed-libp2p-v3-handler-signature.md` (stream handler framing).
