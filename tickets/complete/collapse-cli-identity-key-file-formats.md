---
description: The command-line tool used to accept a node's identity key in four different file shapes and guess which one it was handed; one of those guesses could silently turn a damaged key file into a different working identity. It now accepts exactly one format and fails loudly on anything else.
files: packages/cadre-cli/src/config/loader.ts, packages/cadre-cli/src/config/types.ts, packages/cadre-cli/src/commands/enroll.ts, packages/cadre-cli/src/commands/start.ts, packages/cadre-cli/test/identity-key.spec.ts, packages/cadre-cli/test/one-shot-node.spec.ts, packages/cadre-cli/example.cadre.yaml, packages/cadre-cli/README.md, packages/cadre-host/src/orchestrator/host-process-orchestrator.ts, packages/cadre-host/src/__tests__/orchestrator-node-identity.test.ts, packages/cadre-host/src/installer/identity.ts, packages/integration-tests/src/harness/provider-process-orchestrator.ts, packages/integration-tests/src/scenarios/cadre-host-owner-node.integration.ts, docs/architecture.md, docs/cadre-host.md
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

Behaviour changes:

- `cadre enroll create` writes **binary** protobuf, not hex text — byte-identical in format to
  cadre-host's installer `identity.key`. Filenames (`<name>.key` / `<name>.id`), the 0600 chmod and
  the printed PeerId are unchanged, so the docker entrypoint's create-then-config ordering keeps
  working untouched.
- A key file in any other shape (raw bytes, hex text, truncated, empty) throws
  `Invalid identity key file <abs path>: not a libp2p protobuf-encoded private key. …` with the
  libp2p error preserved as `{ cause }`. It never falls through to "no identity configured",
  because that path generates a fresh keypair — the same wrong-identity outcome.
- The `identity` block is allowlisted: `keyFile` only, and it must carry a non-empty string path.
  Retired names (`protobufKeyFile`, `privateKeyHex`) get a pointed error; anything else
  (`keyfile`, `keyPath`) gets "unknown key"; a valueless `keyFile:` gets "must be a path".
- `CADRE_IDENTITY_PROTOBUF` being set throws, naming `CADRE_KEY_FILE`. Checked inside
  `applyEnvironmentOverrides`, so it fires for every caller, not only `resolveConfig`.
- `--identity-protobuf` → `--identity-file`, routed through `CADRE_KEY_FILE`. Precedence preserved:
  env beats file, so the flag still outranks a child config's own `identity.keyFile` — which is how
  cadre-host hands its spawned nodes their identity. It deliberately overwrites a `CADRE_KEY_FILE`
  the docker entrypoint already exported.
- `cadre enroll create` now refuses to overwrite an existing `<name>.key` (added during review).

Deleted: `loadPrivateKey`, `decodePrivateKey`, the `privateKeyFromRaw` import,
`identity.protobufKeyFile`, `identity.privateKeyHex`, `CADRE_IDENTITY_PROTOBUF` from
`ENV_MAPPINGS`. `loadProtobufPrivateKey` → `loadIdentityKey`.
`test/protobuf-identity.spec.ts` → `test/identity-key.spec.ts`.

## Review findings

### Validation run (all green)

`yarn workspace @serfab/cadre-cli build` + `test` (16 files, **232 tests**, up from 224),
`yarn workspace @serfab/cadre-host build` + `test` (66 files, 608 passed / 4 skipped),
`yarn lint`, `yarn typecheck`. Integration: `provider-seed-accepted`,
`cadre-host-owner-node`, `cadre-host-node-donation` — 23 tests, 58 s, all pass. These are the
three that spawn real `cadre-cli` child processes and shell out to the real `enroll create`.
No pre-existing failures surfaced; `tickets/.pre-existing-error.md` was not written.

Manual smoke on the real binary (the gap the handoff flagged as uncovered), all confirmed:
`enroll create` wrote a 68-byte file starting `08 01 12 40`; `start --identity-file <that file>`
came up under exactly the PeerId `enroll create` printed; `start --identity-file <same file
truncated to 64 bytes>` failed with the "not a libp2p protobuf-encoded private key" error instead
of starting under a new PeerId. That also proves the renamed flag actually parses on the built
binary — nothing automated in cadre-cli covered that.

### Major — none filed

Nothing needed a new ticket. Everything found resolved at the site, and no finding pointed at an
unsettled design decision.

### Fixed in this pass

- **A `keyFile:` line with no value silently re-keyed the node** — `packages/cadre-cli/src/config/loader.ts`.
  The allowlist checked key *names* only, so YAML `identity:` / `  keyFile:` parsed to
  `{ keyFile: null }`, passed validation, then failed the truthiness test that selects the loader
  and resolved to *no identity* — a fresh keypair and a new PeerId. Confirmed by running
  `resolveConfig` against exactly that config: `privateKey === undefined`. Same for `''`,
  whitespace, and a non-string. This is the precise failure the block was written to prevent, and
  it survived it. `validateIdentityBlock` now also rejects an unusable `keyFile` value, split into
  `rejectUnknownIdentityKeys` / `rejectUnusableKeyFile`. An empty `identity: {}` stays legal (it
  names nothing) and is now pinned by a test so the guard is not widened by accident. Env override
  still rescues such a config, since validation runs after `applyEnvironmentOverrides` — also
  pinned.
- **`enroll create` silently destroyed a live identity** — `packages/cadre-cli/src/commands/enroll.ts`.
  It overwrote `<name>.key` with no check. Pre-existing, but this change's own new error message
  tells operators to "regenerate it with `cadre enroll create`", which makes aiming that at a
  directory holding a good key a realistic slip rather than a contrived one. It now refuses and
  exits 1. Both unattended callers (the docker entrypoint's `create_identity`, the integration
  harness's `runEnrollCreate`) already guard on the file existing, so nothing regressed —
  confirmed by the integration run above.
- **The documented Docker backup command corrupted the key** — `packages/cadre-cli/README.md`.
  `docker compose exec cadre-node cat /data/cadre-peer.key > …` was fine when the file was hex
  text (the old loader trimmed the stray CR), but this change made the file binary and
  `docker compose exec` allocates a TTY by default, which mangles it. Replaced with
  `docker compose cp` in both directions.
- **Docs for the new `enroll create` behaviour** — `packages/cadre-cli/README.md` now states what
  the command writes, that the key is the one accepted format, and that it will not overwrite.

### Tripwires recorded, not filed

- **Relative `identity.keyFile` resolves against the process working directory**, not the config
  file's directory (which is what `nodeStateDir` falls back to). Every shipped launcher passes an
  absolute path — the docker entrypoint, cadre-host's spawn args, and `cadre-install.sh`'s `sed`
  over `example.cadre.yaml` — and the mismatch fails loudly ("Identity key file not found") rather
  than quietly, so it is fine today. `NOTE:` at `loadIdentityKey` in
  `packages/cadre-cli/src/config/loader.ts`.
- **`rejectRetiredIdentityEnv` is transitional** and had no marker, unlike the
  `RETIRED_IDENTITY_KEYS` map beside it. `NOTE:` added to its doc comment saying it is deletable
  once no launcher still exports the variable.
- Carried forward from the implementation: the flipped-byte-inside-payload case is parked as a
  `NOTE:` at the decode site pointing at `backlog/debt-identity-key-file-has-no-integrity-check`
  (verified present), and the `RETIRED_IDENTITY_KEYS` map carries its own deletable-when marker.
  Both re-read and left as they stand.

### Checked and found clean

- **No stale references anywhere.** A repo-wide grep for `protobufKeyFile`, `privateKeyHex`,
  `CADRE_IDENTITY_PROTOBUF`, `identity-protobuf`, `loadPrivateKey`, `loadProtobufPrivateKey`
  across `.ts` / `.md` / `.yaml` / `.json` / `.sh` / `.js` returns only the deliberate
  retired-name error strings in `loader.ts` and the tests that assert them.
- **Both writers agree with the reader.** `EnrollmentService.createCadrePeer` returns
  `privateKeyToProtobuf` output, which `enroll create` now writes verbatim; cadre-host's installer
  writes the same form. Byte check on the real binary above.
- **`cadre-install.sh` still works.** Its `sed 's|keyFile: ./cadre-peer.key|…|'` still matches
  `example.cadre.yaml` after that file was rewritten, and its documented step 2 is `enroll create`.
- **`docker/entrypoint.sh` needs no change.** It mints via `enroll create`, writes
  `identity:\n  keyFile:` only when the file exists, and exports `CADRE_KEY_FILE` — all consistent
  with the collapsed format. Its spec (`test/entrypoint.spec.ts`) uses a stub CLI, so the format
  change does not reach it.
- **`status.ts` calls `loadConfigFile` without `applyEnvironmentOverrides`** and so skips the
  identity guards — harmless, because it reads only `controlNetwork` / `profile` / `strandFilter` /
  `hibernation` and never touches identity.
- **Docs read end-to-end, not skimmed.** `docs/architecture.md` (Docker volume / entrypoint
  section), `docs/cadre-host.md` (identity + donated-node sections), `packages/cadre-cli/README.md`,
  `example.cadre.yaml`, `packages/cadre-host/README.md`, `packages/cadre-provider/README.md` all
  describe the current single-format reality. The two README defects above were the only
  divergences.
- **Test isolation concern raised in the handoff is unfounded in practice.** `rejectRetiredIdentityEnv`
  living inside `applyEnvironmentOverrides` does make a leaked `CADRE_IDENTITY_PROTOBUF` able to
  fail unrelated specs, but Vitest isolates test files, only `identity-key.spec.ts` sets the
  variable, and it deletes it in `afterEach`. The three other specs that call
  `applyEnvironmentOverrides` directly (`env-override-empty`, `push-config`, `strand-filter`) all
  pass. No change made.
- **Error-path shape is deliberate and correct.** `readFileSync` sits *outside* the try block, so
  an unreadable file (EACCES on a 600-mode key owned by another user, EISDIR on a directory)
  surfaces its own OS error rather than the misleading "not a libp2p protobuf-encoded private key".
- **File sizes are fine.** `loader.ts` 355 → 383 lines, `enroll.ts` 114 → 125,
  `identity-key.spec.ts` 362 → 424 (`wc -l`). No split warranted; the added logic is three short
  single-purpose functions.

### Known gaps left standing (unchanged from the handoff, re-confirmed)

- **The 64-byte-payload flip is still undetected** — a flipped byte inside the payload decodes fine
  and yields a different PeerId. Deliberate scope boundary; tracked by
  `backlog/debt-identity-key-file-has-no-integrity-check`.
- **Only the `identity` block is validated**; every other config key is still an unchecked cast —
  `backlog/debt-cli-config-file-has-no-schema-validation`.
- **`enroll create` is still exercised in-process** by the cadre-cli unit test (commander
  `parseAsync`), not as a spawned binary. The spawned path is covered by
  `provider-seed-accepted.integration.ts` and by the manual smoke recorded above.
- **No migration path for existing hex key files**, by design (`AGENTS.md`: no backwards compat
  yet). An operator with a pre-change `cadre-peer.key` gets a clear error and must re-enroll. The
  ticket established there are no live instances; that claim was not re-verified in this pass
  either.
- **Windows `chmodSync(0o600)` is effectively a no-op** — pre-existing, untouched.
- **Not run:** the full 40-scenario integration suite (sequential, well past the ten-minute
  agent-runnable window). The three scenarios that spawn real `cadre-cli` children or touch
  identity wiring were run instead; the rest use in-process `CadreNode`s and never read a key file.
