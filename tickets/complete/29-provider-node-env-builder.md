description: Pulled the hosting provider's container-environment list (party id, bootstrap peers, seed token, owner keys, etc.) out of the Docker orchestrator's inline code into one shared function, so tests outside Docker can build a node the same way the provider does.
files: packages/cadre-provider/src/service/container-env.ts, packages/cadre-provider/src/service/docker-orchestrator.ts, packages/cadre-provider/src/index.ts, packages/cadre-provider/src/service/__tests__/container-env.test.ts
difficulty: easy
---

# Provider node-env builder — complete

Pure extraction of `DockerOrchestrator.createContainer`'s inline `Env` array into
`packages/cadre-provider/src/service/container-env.ts` (`buildNodeEnv(spec): string[]`,
plus `NodeEnvPorts` / `NodeEnvSpec` / `CONTAINER_PORTS`), re-exported from the package
index. Orchestrator now calls `Env: buildNodeEnv({ request, seedToken, resources })`;
`resources` is still merged once in the orchestrator
(`request.resources ?? config.defaultResources ?? {}`) and shared with the
`Memory`/`NanoCpus` limits. No env var name, value, or emission order changed.

The point of the extraction: a non-Docker consumer (the follow-on
`29.5-provider-seed-accepted-by-real-node`, which starts a real `@serfab/cadre-cli`
child) can now reproduce exactly what the provider hands a container instead of
keeping a parallel copy that drifts.

## Review findings

**Checked:** implement diff read first, before the handoff summary. Verified the
extracted array is byte-identical in content and order to the pre-change literal;
verified nothing else in `createContainer` moved (ports allocation, seed-token minting,
volume ensure, cleanup/rollback path, labels, result shape all unchanged). Checked
`.filter(Boolean)` semantics for every optional var, the `?.length` vs `?.join` guard on
`CADRE_OWNER_KEYS`, `CADRE_PUSH` JSON encoding, and that no new log line touches
credentials. Reviewed source hygiene (65-line single-purpose module, comments moved
verbatim with the code they explain), type safety (no `any` outside the one
pre-existing `as unknown as Docker` test cast), and docs.

**Fixed in this pass (minor):**

- *Ports duplicated across two files.* The extraction parameterized the in-container
  ports in `container-env.ts` while `docker-orchestrator.ts` kept literal
  `'8080/tcp'` / `'9090/tcp'` / `'4001/tcp'` `PortBindings` keys — one image port set,
  two sources of truth, created by this diff. Exported `CONTAINER_PORTS` (was a private
  `DEFAULT_PORTS`) and made `PortBindings` key off it. Also exported from `src/index.ts`,
  since the non-Docker consumer needs to know which ports it is substituting.
- *Merge-site coverage gap.* The equality test passed `resources: request.resources`
  against a config with no `defaultResources`, so the
  `request.resources ?? config.defaultResources ?? {}` merge was never exercised — the
  test would have passed even if the orchestrator stopped applying the default. Added
  two cases: config default flows into `CADRE_STORAGE_QUOTA` when the request omits
  resources, and request resources override the default. Factored the fake-dockerode
  setup into one `captureOrchestratorEnv` helper rather than copying it per case.
- Comment-alignment noise in `NodeEnvPorts` (the `// 8080 in the image` trailing
  comments restated the now-exported `CONTAINER_PORTS` values); dropped.

**Filed as tickets (major):** none. The change is scoped extraction with no behaviour
delta, and no defect survived verification — nothing rose to ticket weight.

**Tripwire recorded (conditional):** `CADRE_SEED_TOKEN` is emitted unconditionally, so a
caller passing `seedToken: ''` would ship a present-but-empty var, which `cadre-cli`
reads as "seed endpoint disabled" rather than as a misconfiguration. Unreachable today
(the provider always mints a 32-byte token), so it is a `NOTE:` comment at the emission
site in `container-env.ts`, not a ticket.

**Docs:** read every doc that names the affected env vars — `docs/architecture.md`
(seed trust / owner-key anchor), `docs/cadre-host.md`, `docs/STATUS.md`,
`packages/cadre-provider/README.md`, `packages/cadre-cli/README.md`. All describe the
env *contract* (`CADRE_OWNER_KEYS`, `CADRE_SEED_TOKEN`, `CADRE_PUSH`) and the
`createContainer → CADRE_OWNER_KEYS` path, none of which this refactor changes; the two
`docs/STATUS.md` references to specific test files still point at tests that exist and
still pass. No doc edit needed — stated explicitly rather than left silent.

**Handoff gap closed:** the implementer flagged that no test asserts the exported
symbol shape independent of the orchestrator wiring. Left as-is deliberately —
`index.ts`'s re-export is compiled by `typecheck` on every run, and a hand-written
symbol-shape assertion would restate the type system without catching anything it
misses.

## Validation

- `yarn workspace @serfab/cadre-provider typecheck` — clean.
- `yarn workspace @serfab/cadre-provider test` — 20 files / 134 tests passed
  (132 after implement, +2 merge-site cases here).
- `yarn lint` — clean, repo-wide.
