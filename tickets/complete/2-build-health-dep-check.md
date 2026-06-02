description: COMPLETE — `yarn dep-check` is now a real knip gate covering all nine workspaces; reviewed and verified
files: knip.ts, package.json, packages/cadre-cli/package.json, packages/cadre-core/package.json, packages/cadre-host/package.json, packages/cadre-provider/package.json, packages/integration-tests/package.json, packages/quereus-plugin-sereus/package.json, packages/strand-proto/package.json, packages/reference-app-rn/package.json, docs/STATUS.md
----

# Complete: `yarn dep-check` is a real gate (knip 6)

`yarn dep-check` was a no-op (root `foreach -A run dep-check`, no package defined the script →
exit 0). It now runs **knip 6** from the repo root via a single root config (`knip.ts`, Option A)
covering all nine workspaces. Dependency-class issues (`dependencies`, `unlisted`, `binaries`,
`unresolved`) fail the gate (knip default `error`); dead-code classes are downgraded to `warn`.

See the original review/implement ticket history and `docs/STATUS.md` "Dependency-check coverage"
for the full change list (phantom deps added, unused deps removed, ignore rationale).

## Review findings

Adversarial pass over the implement diff (`6a5806e`). The diff is dependency-manifest + a new
`knip.ts` only — no `src/` runtime code changed.

### Verified correct (checked, no action needed)

- **Phantom/missing deps added are genuinely imported** (not just claimed). Confirmed real imports:
  `@multiformats/multiaddr` in `cadre-core/src/{seed-bootstrap,strand-formation-protocol}.ts`;
  `@libp2p/crypto` in `cadre-cli/src/config/loader.ts`; `@libp2p/interface` in
  `cadre-host/src/installer/identity.ts`; `@libp2p/peer-id` in `cadre-cli/test/protobuf-identity.spec.ts`.
- **Removed deps are truly unused.** `aegir` — no `.aegir*` config file anywhere in the tree and no
  package.json script references it (cli/core/provider). `@serfab/cadre-core` — not imported anywhere
  in `cadre-provider/src` or `/test`. Root `esbuild` — only `quereus-plugin-sereus` uses esbuild and
  it lists its own. No orphaned config/scripts left behind.
- **No orphaned per-package `dep-check` scripts** remain; `docs/STATUS.md` is the only doc that
  references dep-check and it accurately reflects the new knip gate.
- **Version coherence.** `vitest` resolves to `4.1.8` in the lockfile (satisfies `@vitest/coverage-v8`'s
  exact-version peer); added `@libp2p/*` ranges match sibling packages.
- **`ignoreDependencies` rationale spot-checked and genuine:** `cadre-host` `@serfab/cadre-cli` via
  `req.resolve('@serfab/cadre-cli/bin/cadre.js')` in `orchestrator/host-process-orchestrator.ts:724`;
  `qrcode-terminal` via `requireForQr(...)` in `bin/host.ts:452`; `@achingbrain/nat-port-mapper` via
  dynamic `import()` in `nat/port-mapper.ts:72`; `reference-app-web` `readable-stream`/`buffer` via
  vite resolve-aliases and `@multiformats/multiaddr` via vite `dedupe` (`vite.config.ts`). These are
  real implicit uses knip cannot see statically.

### Gates run (all green)

- `yarn install --immutable` → consistent (only the pre-existing `@react-native/gradle-plugin` peer warning).
- `yarn dep-check` → **exit 0**, output is `warn`-level dead-code only, zero `error`-level findings.
- **Gate-bite test:** temporarily added a bogus `zzz-bogus-bite-test` dep to `cadre-core/package.json`
  → `yarn dep-check` reported `Unused dependencies (1)` and **exit 1**. Reverted. The gate provably bites.
- `yarn typecheck` → exit 0. `yarn build` → exit 0 (vite dynamic-import warnings are pre-existing,
  from `../optimystic` db-p2p, not this repo). `yarn lint` → exit 0 (note: completes in ~0s; few/no
  workspaces actually define a `lint` script — a separate gap, out of scope here).
- `yarn workspace @serfab/cadre-host run test` → **359 passed / 3 skipped** (covers the 3 `@libp2p/*`
  deps this ticket added to cadre-host).

### Findings

- **Pre-existing test failure flagged (NOT this ticket).** `yarn test` / `yarn workspace
  @serfab/integration-tests run test` fail **12 of 86** integration tests — multi-node convergence /
  replication `waitUntil` timeouts (`convergence-stress`, `enrollment-e2e`, `multi-party-workflows`,
  `websocket-chat`, `deliver-seed-cross-network`). Proven pre-existing: runtime dep versions
  (`libp2p` 3.1.3, db-p2p/db-core workspace portals, tcp, noise) are **unchanged** by the diff, and
  re-running the suite against the **parent commit's** lockfile+manifests reproduces the **identical
  12 failed | 74 passed**. This ticket is manifest-only and cannot affect convergence logic. Written
  up in `tickets/.pre-existing-error.md` for the triage pass. (The implement handoff had separately
  noted two `cadre-host` smoke tests as flaky-under-load; those pass 359/359 in isolation here.)
- **Minor / accepted — conservative `ignoreDependencies` on the reference apps.** `reference-app-web`
  ignores `@optimystic/db-core` / `@quereus/quereus` / `idb` (and `reference-app-rn` ignores
  `@expo/vector-icons` / `expo-updates`) that *may* be genuinely removable or should instead be
  promoted to real deps. Left as documented ignores. **Low risk:** `ignoreDependencies` only suppresses
  *unused*-dep flagging — it cannot mask a *missing/unlisted* import (that still errors). Worst case is
  a few stale manifest entries, never a build/runtime break. No change made; noted for future cleanup.
- **Major → filed backlog ticket `dead-code-cleanup-and-knip-gate`.** ~15 unused files (incl. the
  never-imported barrels `cadre-provider/src/{server,service}/index.ts`), ~40 unused exports, ~29
  unused exported types remain as `warn`. Cleaning them and deciding whether to promote dead-code
  rules to `error` is a separate, deliberately-out-of-scope concern; captured as a backlog spec.

### Disposition

No inline fixes were required — the implementation is correct, the gate works and bites, and all
build-health gates are green. One backlog ticket filed (dead-code), one pre-existing failure flagged
for triage. Nothing in the diff was reverted or modified.
