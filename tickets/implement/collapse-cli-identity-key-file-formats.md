---
description: The command-line tool accepts a node's identity key in four different file shapes and guesses which one it was handed. One of those guesses can silently turn a damaged key file into a different working identity, so the node starts up as the wrong node. Collapse it to a single accepted format that fails loudly when the file is damaged.
files: packages/cadre-cli/src/config/loader.ts, packages/cadre-cli/src/config/types.ts, packages/cadre-cli/src/commands/enroll.ts, packages/cadre-cli/src/commands/start.ts, packages/cadre-cli/test/protobuf-identity.spec.ts, packages/cadre-cli/test/one-shot-node.spec.ts, packages/cadre-cli/example.cadre.yaml, packages/cadre-cli/README.md, packages/cadre-cli/docker/entrypoint.sh, packages/cadre-host/src/orchestrator/host-process-orchestrator.ts, packages/cadre-host/src/__tests__/orchestrator-node-identity.test.ts, packages/cadre-host/src/installer/identity.ts, packages/integration-tests/src/harness/provider-process-orchestrator.ts, docs/architecture.md, docs/cadre-host.md
difficulty: medium
---

# One identity key format, one config key, no guessing

## The hazard, verified

The plan ticket asked for this to be confirmed before building on it. **Confirmed by running it** —
`privateKeyFromRaw` does *not* validate Ed25519 key material, it only checks the length:

```
JUNK ACCEPTED  type=Ed25519  peerId=12D3KooWAHoEkEqnKzM5PXFygh2movVBCSX3k8tDsT2cneU68Gyt
```

That is `new Uint8Array(64).fill(7)` — sixty-four identical bytes — accepted as a working private
key with a working PeerId. The chain in `@libp2p/crypto` is `privateKeyFromRaw` →
(`byteLength === 64`) → `unmarshalEd25519PrivateKey` → `ensureEd25519Key(bytes, 64)`, which
compares a length and returns. The last 32 bytes are simply *declared* to be the public half; that
they do not correspond to the first 32 is never checked.

So the real failure, also run end-to-end: take a genuine 68-byte protobuf key, truncate it to 64
bytes, feed it to `decodePrivateKey` (`loader.ts:203`):

```
trunc protobuf rejected by protobuf decoder: index out of range: 4 + 64 > 64
  -> FALLBACK ACCEPTED, peerId=12D3KooWLmr14tzTekcNwAmjC8WNdcG45YkCFySiwQuNUJZZmtbw
```

A damaged identity file does not fail the node. It starts it under a **different PeerId**. Every
`MemberPeer` row, peer-store entry and relay reservation naming the real PeerId goes stale, and the
operator's only symptom is that peers quietly stop recognising the node.

This is therefore a live hazard, not ordinary compatibility debt, and removing the fallback is the
point of this ticket rather than a side effect of it.

## What is actually on disk today

The plan ticket assumed the raw-bytes arm might have a producer. It does not — **nothing in the
repo has ever written the raw form.** There are exactly two writers, and they disagree only on
*encoding*, not on format:

| writer | file | bytes on disk |
| --- | --- | --- |
| `enroll create` (`commands/enroll.ts:37`) | `<name>.key` | protobuf, **hex text** |
| cadre-host installer (`installer/identity.ts`) | `identity.key` | protobuf, **binary** |

Both are `privateKeyToProtobuf` output. The hex writer is the one the Docker entrypoint and the
systemd install script both point `identity.keyFile` at — which is why the `keyFile` path needs two
of the four guess arms today (hex-sniff, then protobuf-decode), and why "keep `protobufKeyFile`,
delete `keyFile`" would have broken every container and every systemd install: `loadProtobufPrivateKey`
reads binary only.

## Decisions (settled — do not re-open)

**`identity.keyFile` is the one surviving config key.** Not `protobufKeyFile`. Two reasons: it is
the neutral name (`protobufKeyFile` bakes an encoding into the config surface and becomes a lie the
day the format changes), and it is already the spelling used by `entrypoint.sh`,
`contrib/cadre-install.sh`, `example.cadre.yaml`, the README env table and the integration harness —
so keeping it leaves the deployment paths' *shape* untouched while the format changes underneath.

**The one on-disk format is binary libp2p protobuf** (`privateKeyToProtobuf` output, no encoding
layer). It is what `privateKeyFromProtobuf` consumes directly, it carries the key-type tag that raw
bytes do not, and it is already what cadre-host writes. Consequence: **`enroll create` must stop
hex-encoding** — its output becomes byte-identical to the installer's, so the whole repo has one
identity file format. Rejected alternative: standardise on hex-of-protobuf and change cadre-host to
match — that keeps a file an operator can `cat` (not a virtue for key material) at the cost of
doubling every key file and keeping the hex-sniff guess we are here to delete.

**`identity.privateKeyHex` is removed outright.** It puts key material in a config file, its own
docs call it "not recommended for production", and it has no consumer anywhere outside the loader
and one commented-out line in `example.cadre.yaml`.

**`CADRE_IDENTITY_PROTOBUF` is removed; `CADRE_KEY_FILE` survives.** One concept, one env var.

**`--identity-protobuf` is renamed `--identity-file`.** Leaving a flag named `-protobuf` pointing at
`identity.keyFile` would re-create the "one concept, two spellings" this ticket exists to kill.

**Precedence is preserved, and this is load-bearing.** Today `protobufKeyFile` outranks `keyFile`,
which is how cadre-host's `--identity-protobuf` beats a child config's `keyFile`. After the collapse
there is nothing left to rank — but `--identity-file` must still win over a config-file value, so
route it through `CADRE_KEY_FILE` exactly as `start.ts:95` routes the flag today
(`applyEnvironmentOverrides` already makes env beat file). Overwriting an entrypoint-set
`CADRE_KEY_FILE` is correct: an explicit flag outranks the ambient environment.

**A damaged file fails, loudly, with one error.** Never a libp2p stack trace, and never a silent
fall-through to "no identity configured" — that generates a fresh keypair, which is the same
wrong-identity outcome by a different door.

## Rejecting retired and misspelled keys is the permanent half of this change

`loadConfigFile` is `yaml.load(content) as CliConfigFile` — a bare cast. **There is no schema
validation and no unknown-key rejection anywhere.** So simply deleting `protobufKeyFile` from the
type would make an existing `identity: { protobufKeyFile: … }` config parse fine, resolve to *no
identity block*, and generate a fresh keypair on every start. That is the identical class of bug
this ticket is closing.

So the `identity` block gets an explicit allowlist. Worth doing as a permanent guard rather than a
transitional one, because it also catches the case that will still exist in five years — a plain
typo (`identity.keyfile`, `identity.keyPath`) silently costing a node its identity.

```ts
/** The only key the `identity` block accepts. Anything else is a typo or a retired name. */
const IDENTITY_KEYS = new Set(['keyFile']);

// NOTE: transitional — this map exists only to give old configs a pointed error instead of a
// generic "unknown key". Safe to delete once no config in circulation names either key; the
// IDENTITY_KEYS allowlist above is the permanent guard and must stay.
const RETIRED_IDENTITY_KEYS: Record<string, string> = {
	protobufKeyFile: "renamed to 'keyFile' — same libp2p protobuf format, no file change needed",
	privateKeyHex: "removed — write the key to a file ('cadre enroll create') and set 'keyFile'",
};
```

Same treatment for the retired env var: `CADRE_IDENTITY_PROTOBUF` being set must throw naming
`CADRE_KEY_FILE`, not be silently ignored.

Whole-config schema validation is the obvious generalisation and is deliberately **out of scope** —
parked as `backlog/debt-cli-config-file-has-no-schema-validation`.

## What the new loader looks like

`loadPrivateKey` (the hex/raw byte reader) has **no consumers outside `loader.ts`** — verified by
grep across `packages/`. Delete it along with `decodePrivateKey`. Rename `loadProtobufPrivateKey` to
`loadIdentityKey`, since there is no longer a second kind of identity key to distinguish it from.

```ts
/**
 * Load the node identity from a libp2p protobuf-encoded private key file.
 *
 * This is the ONE on-disk identity format: what `cadre enroll create` writes, what cadre-host's
 * installer writes to `identity.key`, and what the docker entrypoint mints into `cadre-peer.key`.
 */
export function loadIdentityKey(keyPath: string): PrivateKey
```

Errors, both naming the resolved absolute path:

- missing — `Identity key file not found: <abs path>`
- undecodable — `Invalid identity key file <abs path>: not a libp2p protobuf-encoded private key. Regenerate it with 'cadre enroll create', or point identity.keyFile at the correct file.` — thrown with `{ cause: err }` so the libp2p detail survives for `--debug` without being the operator's first line.

And the tripwire, parked at the decode site because that is where the next reader will meet it:

```ts
// NOTE: no fallback decoder here, deliberately. `privateKeyFromRaw` accepts ANY 64 bytes as an
// Ed25519 key without validating them, so a truncated protobuf used to decode as a *different,
// valid* identity and the node came up under a PeerId nobody expected.
// NOTE: this catches structural damage only. A single flipped byte INSIDE the 64-byte payload
// still decodes, and still yields a different PeerId, because the payload carries no checksum.
// Closing that needs a recorded peer id to verify against —
// backlog/debt-identity-key-file-has-no-integrity-check.
```

## Expected decoder outcomes (measured — use as the test table)

Run against `privateKeyFromProtobuf` with a real key. Every structurally-damaged shape is rejected;
the last row is the honest limit of this change.

| input | outcome |
| --- | --- |
| valid protobuf (68 B) | accepts, same PeerId |
| empty file | rejects — `UnsupportedKeyTypeError: Unsupported key type` |
| hex **text** of the protobuf (what `enroll create` writes today) | rejects — `invalid wire type 7 at offset 41` |
| bare raw 64-byte key, no protobuf wrapper | rejects — `Invalid enum value` |
| protobuf truncated to 64 B | rejects — `index out of range: 4 + 64 > 64` |
| protobuf truncated to 30 B | rejects — `index out of range: 4 + 64 > 30` |
| protobuf with one flipped byte in the payload | **accepts, different PeerId** — see the second NOTE above |

Note the third row: an operator upgrading a container whose `cadre-peer.key` predates this change
gets the clear "not a libp2p protobuf-encoded private key" error rather than a wrong identity. Given
no live instances that is only a nicety, but it is the right nicety.

## Edge cases & interactions

- **Docker entrypoint round-trip.** `create_identity` shells out to `enroll create` and
  `generate_config` writes `identity:\n  keyFile: $CADRE_KEY_FILE`. Once `enroll create` writes
  binary, that whole path keeps working unchanged — but only if `enroll create` still names the file
  `<name>.key` and still chmods 0600. Do not disturb either.
- **`contrib/cadre-install.sh` needs no edit** (it `sed`s the `keyFile:` line in
  `example.cadre.yaml`, which survives). Confirm the sed still matches after you edit the example —
  if you reflow that line, the install script silently stops rewriting the path.
- **`entrypoint.spec.ts` uses a stub CLI that writes `stub-key-material\n`** and only asserts the
  file is reused across restarts, never decoded. It should keep passing untouched; if it does not,
  you changed something you did not mean to.
- **`one-shot-node.spec.ts` already writes binary protobuf** (`writeIdentity`, line 143) — it only
  needs `protobufKeyFile` → `keyFile` at lines 239 and 253. It spawns real CLI child processes, so
  it is the end-to-end proof that the surviving key name actually starts a node.
- **cadre-host spawns with the flag, twice** — `host-process-orchestrator.ts:292` (donated nodes)
  and `:444` (the owner node, alongside `--owner`). Both must move to `--identity-file`. Miss one and
  the child dies at argument parsing; `orchestrator-node-identity.test.ts` should catch it, since its
  fake CLI reads the flag off its own command line.
- **`start.ts:284`'s `--owner` error message** names all three retired spellings. Collapse it.
- **The precedence test at `protobuf-identity.spec.ts:139`** ("lets `CADRE_KEY_FILE` override an
  explicit `identity.keyFile`") is the regression guard for cadre-host's flag still outranking a
  child config. Keep it, converted to binary keys.
- **`protobuf-identity.spec.ts:88` asserts the fallback works.** Invert it rather than deleting it —
  it becomes the regression test that a raw key file is now *rejected*.
- **Partial write during container start.** The entrypoint's create-then-start ordering means a
  partially written key file is possible if a container is killed mid-`enroll create`. That now
  produces the clear error instead of a wrong identity — exactly the intended behaviour change, and
  worth an explicit test (truncated file ⇒ throws) rather than leaving it implied.
- **`installer/identity.ts`'s doc comment** explains *why* protobuf and not raw. It is now the
  repo-wide rationale rather than a cadre-host-local one; point the CLI loader at it rather than
  restating it (stay DRY).
- **Docs carry the three-name list in prose.** `docs/architecture.md:204` says "whatever form its
  identity is configured in (`identity.protobufKeyFile` / `keyFile` / `privateKeyHex`)", and
  `docs/cadre-host.md:182` and `:184` name `protobufKeyFile` / `--identity-protobuf`. A change that
  leaves these stale is not done.

## TODO

### Phase 1 — the loader

- Delete `decodePrivateKey` and `loadPrivateKey` from `config/loader.ts`; drop the now-unused
  `privateKeyFromRaw` import.
- Rename `loadProtobufPrivateKey` → `loadIdentityKey`; wrap its decode in the two-error contract
  above (`{ cause: err }` on the invalid case) and add both `NOTE:` comments at the decode site.
- Add `validateIdentityBlock(identity, configPath)`: allowlist `keyFile`, pointed errors for
  `protobufKeyFile` / `privateKeyHex`, generic unknown-key error otherwise. Call it from
  `resolveConfig` **before** resolving the key.
- Add the `CADRE_IDENTITY_PROTOBUF`-is-set check, throwing and naming `CADRE_KEY_FILE`.
- Collapse `resolveConfig`'s three-branch identity block to the single `keyFile` branch.

### Phase 2 — the config surface

- `config/types.ts`: `identity` becomes `{ keyFile?: string }` with a doc comment naming the one
  format and its two writers; drop `CADRE_IDENTITY_PROTOBUF` from `ENV_MAPPINGS`; fix the
  three-name list in the `nodeStateDir` comment at `:144`.
- `commands/enroll.ts`: write `result.privateKey` (already protobuf bytes) directly, dropping the
  `uint8ArrayToString(..., 'hex')` call and the now-unused `uint8arrays` import. Keep the 0600
  chmod, the `<name>.key` / `<name>.id` filenames and the printed PeerId exactly as they are.
- `commands/start.ts`: rename the flag to `--identity-file` (description: the one protobuf identity
  format; takes precedence over config), route it through `CADRE_KEY_FILE`, and collapse the
  `--owner` error message at `:284`.

### Phase 3 — downstream call sites

- `cadre-host/src/orchestrator/host-process-orchestrator.ts`: `--identity-file` at both `:292` and
  `:444`; update the doc comments at `:402` and `:958`.
- `cadre-host/src/__tests__/orchestrator-node-identity.test.ts`: flag name in the fake CLI, the
  assertions and the header comment.
- `cadre-cli/test/one-shot-node.spec.ts`: `protobufKeyFile` → `keyFile` at `:239` and `:253`.
- `integration-tests/src/harness/provider-process-orchestrator.ts`: the comment at `:150` says
  "materialise the hex identity key" — no longer hex.

### Phase 4 — tests

Rewrite `packages/cadre-cli/test/protobuf-identity.spec.ts` around the single format. Convert
`writeEnrolledKey` to write binary protobuf and keep using it everywhere, so the spec keeps
asserting against what `enroll create` really emits.

- `loadIdentityKey` loads a binary protobuf key and round-trips the PeerId.
- Missing file ⇒ throws `/not found/`.
- **Inverted from `:88`** — a bare raw 64-byte key (binary *and* hex) is now **rejected**, with the
  "not a libp2p protobuf-encoded private key" message. This is the regression test for the whole
  ticket; assert the message, not merely that it throws.
- A protobuf truncated to 64 bytes is rejected. Guards specifically against the fallback returning:
  64 bytes is exactly the length `privateKeyFromRaw` would have accepted.
- Hex **text** of a protobuf is rejected (the pre-change `enroll create` output).
- An empty key file is rejected.
- `identity.protobufKeyFile` in a config ⇒ throws naming `keyFile`.
- `identity.privateKeyHex` in a config ⇒ throws naming `keyFile`.
- An unknown/misspelled key (`identity.keyfile`) ⇒ throws. This is the typo guard; without it the
  allowlist is untested.
- `CADRE_IDENTITY_PROTOBUF` set ⇒ throws naming `CADRE_KEY_FILE`.
- Keep, converted to binary: `nodeStateDir` for a `keyFile`-identity config, `CADRE_KEY_FILE`
  adopted when the config has no identity block, and `CADRE_KEY_FILE` overriding an explicit
  `identity.keyFile`.
- Add: `enroll create` writes a file that `loadIdentityKey` reads back to the PeerId it printed.
  This closes the writer/reader loop the hex/binary split had left open, and is the test that would
  have caught the original "No decoder for tag 8" bug at its source.

Rename the spec file to `identity-key.spec.ts` — "protobuf" is no longer a distinguishing word.

### Phase 5 — docs

- `example.cadre.yaml`: document `keyFile` as the protobuf key from `cadre enroll create`; delete
  the `privateKeyHex` comment. Keep the `keyFile: ./cadre-peer.key` line textually intact so
  `contrib/cadre-install.sh`'s sed still matches.
- `README.md`: delete the `CADRE_IDENTITY_PROTOBUF` row at `:182`; expand the `CADRE_KEY_FILE` row
  at `:181` to name the format.
- `docker/entrypoint.sh`: the ENV_MAPPINGS comment at `:13` is still accurate; check the surrounding
  prose does not claim hex.
- `docs/architecture.md:204` and `docs/cadre-host.md:182`/`:184`: replace the three-name lists and
  the `--identity-protobuf` references with the single key and flag.

### Phase 6 — validate

- `yarn workspace @serfab/cadre-cli test`
- `yarn workspace @serfab/cadre-host test`
- `yarn lint` and the workspace typechecks — the `identity` type narrowing will surface every
  remaining `protobufKeyFile` reference, which is the cheapest way to find one you missed.
- Integration tests touching the provider harness if they are runnable inside the idle-timeout
  window; if not, say so in the review handoff rather than implying they ran.
