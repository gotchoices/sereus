----
description: The command-line tool accepts a node's identity key in several different file shapes and guesses which one it is given. One of those guesses can silently turn a damaged key file into a different, working identity instead of reporting the damage, so the node comes up as the wrong node.
files: packages/cadre-cli/src/config/loader.ts, packages/cadre-cli/src/config/types.ts, packages/cadre-cli/test/protobuf-identity.spec.ts, packages/cadre-cli/README.md, packages/cadre-cli/example.cadre.yaml, docs/architecture.md
difficulty: medium
----

# `cadre-cli` guesses the identity key-file format, and one guess can substitute a different identity

## Why this is filed now

The maintainer's standing directive is that there are no live instances and no deployed data, so
any format break we know we want should be taken now rather than becoming a migration later. This
is the second wave of that sweep — `plan/retire-backwards-compatibility-affordances` covered the
affordances that were merely redundant. This one is not merely redundant: it has a failure mode.

## The failure mode

`decodePrivateKey` (`packages/cadre-cli/src/config/loader.ts:203`) is a two-arm guess:

```ts
function decodePrivateKey(bytes: Uint8Array): PrivateKey {
  try {
    return privateKeyFromProtobuf(bytes);
  } catch {
    return privateKeyFromRaw(bytes);
  }
}
```

The `catch` arm exists for backward compatibility — the doc comment above it says "older/hand-made
key files may hold the raw key bytes", and `packages/cadre-cli/test/protobuf-identity.spec.ts:88`
labels its coverage "Backward-compat: a bare raw key (hex) still loads via the fallback decoder."

The problem is what the arm does when the *protobuf* file is damaged rather than absent. A
truncated or corrupted protobuf fails `privateKeyFromProtobuf` and falls into
`privateKeyFromRaw`, which for Ed25519 accepts a byte string of the right length **without
validating that it was ever a key**. So a damaged `identity.key` does not fail — it yields a
*different, perfectly valid* private key, and the node starts under a PeerId nobody expects.

That is worse than a startup error. Every `MemberPeer` row, peer-store entry, and relay
reservation that names the real PeerId goes stale, and the operator's only symptom is that peers
stop recognising the node. **Verify this before building on it** — confirm that
`privateKeyFromRaw` really does accept arbitrary bytes of the right length for Ed25519 rather than
rejecting them, and say which it is in the implement ticket. If it validates, this is ordinary
compat debt; if it does not, the fallback is a live hazard and its removal is the point of the
ticket, not a side effect.

## The surrounding ambiguity

The guess above sits inside a second guess. `loadPrivateKey` (`:174`) sniffs the file's *encoding*
before anything sniffs its *format*:

```ts
const text = content.toString('utf-8').trim();
if (/^[0-9a-fA-F]+$/.test(text)) return Buffer.from(text, 'hex');
return new Uint8Array(content);
```

Any binary key file whose bytes happen to be entirely ASCII hex digits is read as hex text
instead. Unlikely, not impossible, and silent when it happens.

And above both, `resolveConfig` (`:302-310`) offers three config keys for the same thing:

| key | path |
| --- | --- |
| `identity.protobufKeyFile` | protobuf only, no guessing |
| `identity.keyFile` | encoding guess → format guess |
| `identity.privateKeyHex` | inline hex → format guess |

So one concept has three spellings, two of which run a four-way guess. `types.ts:10` describes
`keyFile` as "(hex or raw bytes)" — which is already out of date, since the documented
`enroll create` output is protobuf.

## What to decide

This is a plan ticket because the shape is a judgement call, not a deletion:

- **Which single on-disk form survives.** `protobufKeyFile`'s form is the one `cadre enroll create`
  writes and the one cadre-host's installer writes to `identity.key`; it carries a key-type tag,
  which raw bytes do not. That makes it the obvious survivor, but confirm nothing else writes the
  raw form first.
- **Whether the three config keys collapse to one**, and if so what it is called and what happens
  to the other two names — a hard error naming the replacement is friendlier than silent
  ignoring, and costs nothing now.
- **Whether `privateKeyHex` survives at all.** It is documented "not recommended for production"
  and puts key material in a config file. Removing it is in scope if that is wanted; say so
  either way rather than leaving it unaddressed.
- **What a damaged key file should do.** Named explicitly so the implementer does not reinvent it:
  fail with a message that says the file is not a valid protobuf key and names the path.

## Edge cases & interactions

- **cadre-host's installer writes `identity.key`** and cadre-cli reads it. A format decision here
  is a decision for both; check `packages/cadre-host/src/installer/identity.ts` before settling.
- **The Docker entrypoint and `CADRE_*` environment mappings** (`config/types.ts` `ENV_MAPPINGS`)
  may name whichever config keys change. `ops/` may too.
- **`example.cadre.yaml` and `packages/cadre-cli/README.md`** both document the key surface; a
  change that leaves them stale is not done.
- **The existing spec at `protobuf-identity.spec.ts:88` asserts the fallback works.** It is not a
  test to delete silently — invert it into an assertion that a raw/damaged file is *rejected*, so
  the removal has a regression test rather than a hole.
- Removing a decode arm changes a **startup** failure path: a node that used to come up (wrongly)
  now refuses to start. That is the intent, but it should be one clear error, not a stack trace
  from inside libp2p.
