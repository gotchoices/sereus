---
description: The command-line tool used to accept a node's identity key in four different file shapes and guess which one it was handed; one of those guesses could silently turn a damaged key file into a different working identity. It now accepts exactly one format and fails loudly on anything else. Review the collapse.
files: packages/cadre-cli/src/config/loader.ts, packages/cadre-cli/src/config/types.ts, packages/cadre-cli/src/commands/enroll.ts, packages/cadre-cli/src/commands/start.ts, packages/cadre-cli/test/identity-key.spec.ts, packages/cadre-cli/test/one-shot-node.spec.ts, packages/cadre-cli/example.cadre.yaml, packages/cadre-cli/README.md, packages/cadre-host/src/orchestrator/host-process-orchestrator.ts, packages/cadre-host/src/__tests__/orchestrator-node-identity.test.ts, packages/cadre-host/src/installer/identity.ts, packages/integration-tests/src/harness/provider-process-orchestrator.ts, packages/integration-tests/src/scenarios/cadre-host-owner-node.integration.ts, docs/architecture.md, docs/cadre-host.md
difficulty: medium
---

# One identity key format, one config key, no guessing

## What landed

Before: `cadre-cli` accepted a node identity through four doors — `identity.protobufKeyFile`,
`identity.keyFile` (hex-sniffed, then protobuf-decoded, then **raw-decoded as a fallback**),
`identity.privateKeyHex`, and the `CADRE_IDENTITY_PROTOBUF` env var. The raw fallback was the
hazard: `privateKeyFromRaw` validates only *length*, so a protobuf key file truncated to 64 bytes
decoded as a **different, perfectly valid identity** and the node came up under a PeerId nobody
expected.

After: one config key (`identity.keyFile`), one env var (`CADRE_KEY_FILE`), one flag
(`--identity-file`), one on-disk format (binary libp2p protobuf — `privateKeyToProtobuf` output),
and one error when the file is anything else.

**Behaviour changes a reviewer should hold in mind:**

- `cadre enroll create` now writes **binary** protobuf, not hex text. Its output is byte-identical
  in format to cadre-host's installer `identity.key`. Filenames (`<name>.key` / `<name>.id`), the
  0600 chmod and the printed PeerId are unchanged, so the docker entrypoint's create-then-config
  ordering keeps working untouched.
- A key file in **any** other shape (raw bytes, hex text, truncated, empty) now throws
  `Invalid identity key file <abs path>: not a libp2p protobuf-encoded private key. …` with the
  libp2p error preserved as `{ cause }`. It never silently falls through to "no identity
  configured", because that path generates a fresh keypair — the same wrong-identity outcome.
- The `identity` block is **allowlisted**. `loadConfigFile` is still a bare
  `yaml.load(...) as CliConfigFile` cast, so without this a config naming the deleted
  `protobufKeyFile` would parse fine, resolve to no identity, and re-key the node. Retired names
  get a pointed error; anything else (`keyfile`, `keyPath`) gets "unknown key".
- `CADRE_IDENTITY_PROTOBUF` being set throws, naming `CADRE_KEY_FILE`. Checked inside
  `applyEnvironmentOverrides`, so it fires for every caller, not only `resolveConfig`.
- `--identity-protobuf` → `--identity-file`, and it now routes through `CADRE_KEY_FILE`.
  Precedence is preserved: env beats file, so the flag still outranks a child config's own
  `identity.keyFile` — which is exactly how cadre-host hands its spawned nodes their identity.
  It deliberately overwrites a `CADRE_KEY_FILE` the docker entrypoint already exported.

Deleted: `loadPrivateKey`, `decodePrivateKey`, the `privateKeyFromRaw` import,
`identity.protobufKeyFile`, `identity.privateKeyHex`, `CADRE_IDENTITY_PROTOBUF` from
`ENV_MAPPINGS`. `loadProtobufPrivateKey` → `loadIdentityKey`.
`test/protobuf-identity.spec.ts` → `test/identity-key.spec.ts`.

## How to validate

```
yarn workspace @serfab/cadre-cli build     # dist must be fresh or the stale-build guard fails
yarn workspace @serfab/cadre-cli test
yarn workspace @serfab/cadre-host build
yarn workspace @serfab/cadre-host test
yarn lint
yarn typecheck
```

The typecheck is the cheap sweep for a missed `protobufKeyFile` reference — the narrowed
`identity` type surfaces every one.

End-to-end (each ~25–70 s, all pass):

```
yarn workspace @serfab/integration-tests exec vitest run \
  src/scenarios/provider-seed-accepted.integration.ts \
  src/scenarios/cadre-host-owner-node.integration.ts \
  src/scenarios/cadre-host-node-donation.integration.ts \
  src/scenarios/cadre-host-bootstrap.integration.ts \
  src/scenarios/cadre-host-trust-circle.integration.ts \
  src/scenarios/strand-formation-e2e.integration.ts
```

`provider-seed-accepted` is the one that proves the whole loop with real child processes: it shells
out to the real `cadre enroll create`, points `CADRE_KEY_FILE` at what it wrote, starts a real
node — and its step 5 restarts that node from its volume and checks it comes back as the same peer.
`cadre-host-owner-node` and `cadre-host-node-donation` are the proof for `--identity-file`.

**Manual smoke worth doing by hand** (nothing automated covers the flag on a real binary):

```
node packages/cadre-cli/dist/bin/cadre.js enroll create --output /tmp/x --name n
node packages/cadre-cli/dist/bin/cadre.js start -c <cfg> --identity-file /tmp/x/n.key
# then: truncate n.key to 64 bytes and start again — expect the "not a libp2p protobuf-encoded
# private key" error, NOT a node running under a new PeerId.
```

## Test coverage added (`test/identity-key.spec.ts`)

Loader: valid protobuf round-trips the PeerId; missing file; **raw 64-byte key rejected (binary and
hex)**; protobuf truncated to 64 bytes rejected; truncated to 30 bytes rejected; hex text of a
protobuf rejected; empty file rejected; the decoder error survives as `{ cause }`.

Config: retired `protobufKeyFile` and `privateKeyHex` each throw naming `keyFile`; a misspelled
`keyfile` throws; `CADRE_IDENTITY_PROTOBUF` throws naming `CADRE_KEY_FILE`; `nodeStateDir` resolves
for a `keyFile` config; `CADRE_KEY_FILE` is adopted when the config has no identity block **and**
overrides an explicit `identity.keyFile`.

Writer/reader loop: `enroll create` writes a file that `loadIdentityKey` reads back to the PeerId
it printed, and the first byte is `0x08` (protobuf tag, i.e. binary not hex).

## Known gaps — treat these as the floor, not the finish line

- **The 64-byte-payload flip is still undetected.** A single flipped byte *inside* the payload
  decodes fine and yields a different PeerId; nothing here catches it. Parked as a `NOTE:` at the
  decode site pointing at `backlog/debt-identity-key-file-has-no-integrity-check`. Deliberate scope
  boundary, but it means "the file loaded" is still not "the file is the right key".
- **Only the `identity` block is validated.** Every other config key is still an unchecked cast —
  `backlog/debt-cli-config-file-has-no-schema-validation`.
- **`rejectRetiredIdentityEnv` lives inside `applyEnvironmentOverrides`**, which three other spec
  files call directly. That is intentional (one gate, every caller) but it does mean an env var
  leaked by one test can now fail an unrelated one. `identity-key.spec.ts` deletes it in
  `afterEach`; worth a reviewer's eye on whether that is enough isolation.
- **The `enroll create` → `loadIdentityKey` test runs the command in-process** via commander's
  `parseAsync`, not as a spawned binary — so it does not exercise the `bin/cadre.js` wrapper. The
  spawned-binary path is covered indirectly by `provider-seed-accepted.integration.ts`
  (`runEnrollCreate`), not by a cadre-cli unit test.
- **No migration path for existing hex key files**, by design (`AGENTS.md`: no backwards compat
  yet). An operator with a pre-change `cadre-peer.key` gets a clear error and must re-enroll. The
  ticket established there are no live instances; that claim was not re-verified here.
- **Windows `chmodSync(0o600)` is effectively a no-op** — pre-existing, unchanged by this work.
- **Not run:** the full 40-scenario integration suite (sequential; well past the ten-minute
  agent-runnable window). Six scenarios were selected as the ones that spawn real `cadre-cli`
  children or touch identity wiring, and all pass. The other 34 use in-process `CadreNode`s and
  never read a key file.

## Review findings

- Tripwire recorded, not filed: the flipped-byte-inside-payload case parked as a `NOTE:` at
  `packages/cadre-cli/src/config/loader.ts` (`loadIdentityKey`'s decode site), pointing at the
  existing `backlog/debt-identity-key-file-has-no-integrity-check`.
- Transitional marker recorded: the `RETIRED_IDENTITY_KEYS` map in `loader.ts` carries a `NOTE:`
  saying it is deletable once no config in circulation names either key, and that the
  `IDENTITY_KEYS` allowlist beside it is the permanent guard that must stay.
