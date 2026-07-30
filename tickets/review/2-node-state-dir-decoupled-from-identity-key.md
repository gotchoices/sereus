description: A node only kept its durable notes — which group members to dial, which owners it trusts — when its key happened to be stored in one particular format; that gap is closed so every node the CLI runs keeps those notes on disk regardless of its identity source.
files: packages/cadre-cli/src/commands/start.ts, packages/cadre-cli/src/config/loader.ts, packages/cadre-cli/src/config/types.ts, packages/cadre-cli/test/protobuf-identity.spec.ts, docs/architecture.md, docs/cadre-host.md
---

# What changed

`ResolvedConfig` gained a new, always-set field `nodeStateDir: string`
(`packages/cadre-cli/src/config/types.ts`). `resolveConfig`
(`packages/cadre-cli/src/config/loader.ts:279-286`) resolves it with this
precedence:

1. `nodeState.dir` in the config file (new `CliConfigFile.nodeState` block).
2. `CADRE_NODE_STATE_DIR` env var (new `ENV_MAPPINGS` entry — applied by the
   existing `applyEnvironmentOverrides` mechanism, so it also overrides #1).
3. Otherwise, the directory containing the config file `resolveConfig` was
   handed (`path.dirname(path.resolve(configPath))`).

`start.ts` now opens `FileTrustedOwnerStore` and `FileBootstrapPeerStore` from
`config.nodeStateDir` **unconditionally** (`packages/cadre-cli/src/commands/start.ts:142-159`)
— previously both were gated behind `config.identityProtobufKeyFile` being set,
so a node configured with `identity.keyFile` or `identity.privateKeyHex` fell
back to in-memory stores and forgot its dial addresses / trusted-owner anchor
on every restart. That gate is gone; the stores always persist.

`identityProtobufKeyFile` was removed entirely from `ResolvedConfig` (and the
now-unused local var in `loader.ts`) — nothing else in the repo read it once
`start.ts` stopped needing it for `dirname()`.

## Tradeoff, as flagged in the originating ticket

This **relocates** `cadre-host`'s own owner node's stores. The owner node's
`identity.key` lives at `<dataDir>/identity.key` (installer-managed,
`packages/cadre-host/src/installer/paths.ts:80`), but its `cadre.json` is
written by `HostProcessOrchestrator` into
`<dataDir>/orchestrator/owner/` (`rootDir` = `<dataDir>/orchestrator`,
owner workdir = `<rootDir>/owner` —
`packages/cadre-host/src/orchestrator/host-process-orchestrator.ts:58,313-356,548-550`,
and `rootDir` construction in `packages/cadre-host/src/bin/host.ts:288`). So
the owner node's node-state directory is now `<dataDir>/orchestrator/owner/`
— **not** `<dataDir>/` beside `identity.key` as before. This directory
already persists across owner restarts (`ensureOwnerNode` never deletes the
workdir), and the owner re-establishes its anchor on its own (genesis
`ensureOwnerKey` + operator pins), so the effect is a one-time cold start —
no migration performed, per "no backwards compat yet."

Donated nodes are unaffected in *location*: `HostProcessOrchestrator` writes
each donated node's `identity.key` and `cadre.json` into the *same* workdir
(`<rootDir>/<containerId>/`), so the config-file-directory default already
puts the node-state directory there — same as before, just no longer gated on
`identityProtobufKeyFile` being present (it always was, for donated nodes, so
no behavior change there beyond the removed conditional).

## Docs updated

- `docs/architecture.md` — the cold-start-bootstrap-retries paragraph no
  longer says the file-backed bootstrap-peer store lives "under the
  identity-key directory" or that both stores "open only when a protobuf
  identity key file is configured"; it now describes `nodeStateDir` and its
  resolution precedence.
- `docs/cadre-host.md` — the admin-channel section's back-up-together
  paragraph now calls out the split: `<dataDir>/identity.key` for identity,
  `<dataDir>/orchestrator/owner/` for the trusted-owner anchor + bootstrap-peer
  store. The donated-node paragraph now says the two stores "always open"
  rather than "open only when [the identity path] is configured."

# Testing done

- `yarn workspace @serfab/cadre-cli test` — 98 passed (was 94; added 4 new
  cases to `packages/cadre-cli/test/protobuf-identity.spec.ts`):
  - `nodeStateDir` defaults to the config file's directory (both for a
    `protobufKeyFile`-identity config in the existing describe block, and
    standalone in a new `resolveConfig nodeStateDir` describe block).
  - an explicit `nodeState.dir` wins.
  - the `CADRE_NODE_STATE_DIR` env override wins (and beats the file value —
    not separately asserted, but follows from `applyEnvironmentOverrides`
    running before the `nodeStateDir` computation reads `fileConfig`).
  - **the regression this ticket closes**: a `keyFile`-identity config still
    yields a `nodeStateDir` (previously such a config produced
    `identityProtobufKeyFile: undefined`, which gated both stores off).
- `yarn workspace @serfab/cadre-host test` — 465 passed, 4 skipped (pre-existing
  skips, unrelated — not touched by this change).
- `yarn workspace @serfab/cadre-cli build` — clean (tsc).
- `yarn lint` — clean, exit 0.

# Gaps / things the reviewer should look at

- I did **not** add a dedicated integration/unit test that spawns
  `cadre-host`'s owner node end-to-end and asserts its trusted-owner-anchor
  file actually lands in `<dataDir>/orchestrator/owner/` post-change — the
  relocation is inferred from reading `host-process-orchestrator.ts` and
  `installer/paths.ts`, not exercised by a new host-side test. The existing
  `cadre-host` test suite passed unchanged, but none of those tests assert on
  the *location* of `trusted-owners.<partyId>.json` /
  `bootstrap-peers.<partyId>.json`, so a location regression there wouldn't be
  caught by CI as it stands.
- Did not add a test asserting env override beats an explicit `nodeState.dir`
  in the *same* config (only that env alone, and file alone, each work) —
  low-risk given `applyEnvironmentOverrides` is shared, well-tested plumbing
  used identically by every other config field.
- `CliConfigFile.nodeState.dir` is not validated/sanitized beyond
  `path.resolve` — consistent with how every other path-shaped config field
  (`storage.path`, `identity.keyFile`, etc.) is handled in this codebase, so
  not a new gap, but noting it since it's a new user-facing knob.
