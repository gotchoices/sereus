---
description: Tests and documentation for the fix that lets a hosted customer node keep the same network identity across restarts are written, reviewed, and passing.
files: packages/cadre-cli/docker/entrypoint.sh, packages/cadre-cli/test/entrypoint.spec.ts, packages/cadre-cli/test/protobuf-identity.spec.ts, packages/cadre-provider/src/service/container-service.ts, packages/cadre-provider/src/service/docker-orchestrator.ts, packages/cadre-provider/src/service/__tests__/fake-docker.ts, packages/cadre-provider/src/service/__tests__/docker-orchestrator-volume.test.ts, packages/cadre-provider/src/service/__tests__/container-peer-id-record.test.ts, packages/cadre-provider/README.md, docs/architecture.md, docs/STATUS.md
---

## Summary

The runtime fix — a hosted node mints its libp2p identity into a per-container named
Docker volume, before config generation, exported to the started child so it is
re-applied on every start — landed earlier (`366c246`, `f01e715`). This ticket added
the test coverage and documentation for it; the review pass below closed the gaps that
coverage still had.

## What the implement stage delivered

- `packages/cadre-cli/test/entrypoint.spec.ts` — runs the real `docker/entrypoint.sh`
  under `sh` against a fake `node` stub: identity created before config, exported to
  the child, mirrored into `cadre.yaml`; byte-identical key on a second start.
- `packages/cadre-provider/src/service/__tests__/docker-orchestrator-volume.test.ts` —
  volume create/reuse/cleanup wiring on `createContainer` / `removeContainer`.
- `packages/cadre-provider/src/service/__tests__/container-peer-id-record.test.ts` —
  `provisionContainer` stamping `peerId` from the node's `/status` poll.
- `docs/architecture.md` + `docs/STATUS.md` — the durability mechanism written up.

## Review findings

### Checked

Read the implement diff (`ee3d192`) before the handoff summary, against the runtime it
covers (`docker-orchestrator.ts`, `container-service.ts`, `entrypoint.sh`, the
`Dockerfile`'s env defaults) and every doc the change touches or should have touched
(`docs/architecture.md`, `docs/STATUS.md`, `docs/cadre-host.md`,
`packages/cadre-provider/README.md`). Verified the entrypoint test's fake `node` stub
matches what `cadre enroll create` actually writes (`<name>.key` under `--output`), that
the `CADRE_KEY_FILE` / `CADRE_NODE_STATE_DIR` env mappings the entrypoint relies on exist
in `ENV_MAPPINGS`, and that the new suites are typecheck-clean (the provider's
`tsconfig.typecheck.json` excludes `__tests__`, so this was checked by running `tsc` over
the package's full program — the only errors are the four pre-existing ones already
tracked by `debt-widen-typecheck-to-test-files`).

### Fixed in this pass (minor)

- **The `docs/STATUS.md` link pointed at a section that did not contain the claim.**
  `architecture.md#provider-integration` described the provider trust boundary and said
  nothing about durable identity. Added a `### Durable Container Identity` subsection
  there (volume lifecycle, who mints the key, node-local stores riding along, deletion on
  terminate) and repointed the STATUS link at it.
- **`packages/cadre-provider/README.md` never mentioned the per-tenant volume.** Added a
  "Per-tenant durable state" section under Deployment, plus a sentence on the Kubernetes
  path: a custom orchestrator must supply durable `/data` and delete it on terminate, or
  it silently reintroduces the re-keying bug.
- **`ensureVolume`'s non-404 rethrow was uncovered.** Its comment states the safety
  property ("provisioning failing is far cheaper than deleting a tenant's identity") but
  a change that swallowed all inspect errors kept the suite green. Added a test: a 500 on
  inspect aborts the provision, creates no volume, removes none, and never reaches
  `createContainer`.
- **`removeContainer` with an unreadable container was uncovered.** Added a test that a
  failing pre-removal inspect still force-removes the container and reaps no volume.
- **The entrypoint's "repairs a pre-fix `cadre.yaml`" claim was uncovered.** This is the
  point of the export, and nothing tested it. Added: (a) an entrypoint test with a
  pre-existing `cadre.yaml` that has no `identity:` block — key still minted, both env
  vars still reach the child, stale config left untouched; (b) an assertion that the
  export survives the second (config-already-exists) start; (c) two `resolveConfig` tests
  in `protobuf-identity.spec.ts` — `CADRE_KEY_FILE` supplies the identity when the config
  has no `identity` block, and beats an explicit `identity.keyFile` when both are present.
- **`entrypoint.sh` config/mkdir disagreement.** The generated config defaulted storage to
  the literal `/data/storage` while the `mkdir` above it used `$DATA_DIR/storage`. Inert
  today (the image sets `CADRE_STORAGE_PATH` explicitly), but a needless inconsistency in
  a file this ticket is about — aligned to `$DATA_DIR/storage`.
- **Test-file duplication.** `docker-orchestrator-volume.test.ts` rebuilt the fake daemon
  in all seven tests and `container-peer-id-record.test.ts` repeated a five-line
  store/service/fetch setup in all three; both now go through small local helpers
  (`orchestratorOver`, `provisionable` / `stubStatus`). Also added one test that the
  orchestrator's endpoints and seed token land on the record alongside the peerId — a
  dropped `seedEndpoint`/`seedToken` breaks seed delivery long after provisioning
  "succeeds".

### Major findings (new tickets)

None. The gaps found were all missing coverage or documentation reachable inside this
pass, not design or correctness defects in the runtime. Two adjacent concerns already
have tickets and were deliberately not re-filed: seed trust / owner-key pinning
(`provider-owner-key-pinning`) and test files being outside the provider's typecheck
program (`debt-widen-typecheck-to-test-files`).

### Tripwires (recorded, not ticketed)

- `entrypoint.spec.ts` skips silently on a runner without `sh`, so the entrypoint would be
  unguarded there. `NOTE:` at the `describe.skipIf` site — if CI moves to a shell-less
  Windows runner, make the skip loud.
- `provisionContainer` stamps `peerId` once and never backfills it if the node reported
  healthy before it had an identity. Harmless while every consumer reads live `/status`
  (`getPeerInfo` does). `NOTE:` at the recording site in `container-service.ts`.

## Verification

- `yarn workspace @serfab/cadre-provider test` — 110/110 pass, 17 files (was 107; +3 here).
- `yarn workspace @serfab/cadre-cli test` — 160/160 pass, 13 files (was 157; +3 here).
  Ran `entrypoint.spec.ts` alone with `--reporter=verbose`: all three tests execute (not
  skipped) on this Windows/Git-Bash box.
- `yarn typecheck` in both packages — clean. Provider tests additionally checked via a
  full-program `tsc` run (see above).
- `eslint` over `packages/cadre-provider/src`, `packages/cadre-cli/src`,
  `packages/cadre-cli/test` — clean.
- No pre-existing failures surfaced; `tickets/.pre-existing-error.md` not written.
