description: Playwright e2e suite for @serfab/reference-app-web — Tier 1 (solo) green, Tier 2 (distributed) red pending upstream optimystic CLI fix
files: packages/reference-app-web/package.json, packages/reference-app-web/playwright.config.ts, packages/reference-app-web/tsconfig.e2e.json, packages/reference-app-web/e2e/, packages/reference-app-web/src/App.svelte, packages/reference-app-web/src/Home.svelte, packages/reference-app-web/src/Messages.svelte, packages/reference-app-web/src/Activity.svelte, packages/reference-app-web/src/Diagnostics.svelte, packages/reference-app-web/README.md, .gitignore
----

## What landed

- `packages/reference-app-web/playwright.config.ts` — Chromium-only Playwright config, baseURL `http://127.0.0.1:4173`, `webServer` runs `yarn build && yarn preview`, `globalSetup`/`globalTeardown`, `fullyParallel: false`, retries on CI.
- `packages/reference-app-web/tsconfig.e2e.json` — separate tsconfig that pulls in `e2e/**/*.ts` and the playwright.config under strict + node + @playwright/test types.
- `e2e/fixtures/optimystic-detect.ts`, `e2e/fixtures/reference-peer.ts`, `e2e/fixtures/state.ts` — Tier 2 fixture: detect the sibling reference-peer build, spawn it on WS port 9191 (`interactive --no-tcp --relay`), gather candidate listen addrs for 250 ms then prefer 127.0.0.1, marshal `{available, multiaddr, …}` through `.fixture-state.json` for specs.
- `e2e/global-setup.ts` / `e2e/global-teardown.ts` — env-override (`OPTIMYSTIC_WS_BOOTSTRAP`) → detect-and-spawn → mark unavailable; stash the handle on `globalThis.__referencePeer` for teardown.
- `e2e/distributed/_helpers.ts` — `requireFixture` (per-spec `test.beforeAll` skip when Tier 2 unavailable), `connectToBootstrap` (fill bootstrap textarea, click Connect, wait for mode badge + ≥ 1 connection row).
- `e2e/solo/` — 5 specs, 10 tests covering boot + identity, hash routing × 4, messages CRUD round-trip, reload persistence, diagnostics surface invariants.
- `e2e/distributed/` — 5 specs, 6 tests covering mode flip × 2, bootstrap persistence, two-tab convergence, cross-tab activity ordering, disconnect mid-session.
- Mechanical testid additions across `App.svelte`, `Home.svelte`, `Messages.svelte`, `Activity.svelte`, `Diagnostics.svelte` — no behaviour changes.
- `package.json` — `@playwright/test ^1.60.0` devDep; `test:e2e`, `test:e2e:install`, `test:e2e:ui` scripts.
- `.gitignore` — `e2e/.fixture-state.json`, `test-results/`, `playwright-report/`.
- `README.md` — automated-e2e section documenting tiers, install/run, fixture resolution order, and (after review) a "Tier 2 is currently red" callout pointing to the follow-up fix ticket.

## Validation

```
yarn workspace @serfab/reference-app-web typecheck         # → 0
( cd packages/reference-app-web && npx tsc -p tsconfig.e2e.json --noEmit )  # → 0
yarn workspace @serfab/reference-app-web test:e2e --grep "Tier 1"           # → 10/10 in ~19s
yarn workspace @serfab/reference-app-web test:e2e --grep "Tier 2 / distributed / mode flip"   # → 0/2 (see findings)
```

## Review findings

### Inline-fixed during this review

- **Dead empty `for` loop in `solo/reload-persistence.spec.ts`** — the implementer left a no-op iteration over `contents` with an explanatory comment because per-message activity IDs were not captured pre-reload. Removed; consolidated the explanation into a one-line comment above the surviving `created`-row count assertion. Net assertion unchanged.
- **Misleading `--offline` references** — the spawn args in `e2e/fixtures/reference-peer.ts` *do not* include `--offline` (commander would reject it on the current upstream `interactive` command), but both the function-level JSDoc and the README "Tier 2 fixture resolution" step still claimed `--no-tcp --relay --offline`. Rewrote the docstring and the README step to describe the actual `interactive --no-tcp --relay` invocation and link out to the new fix ticket. The inline comment block that re-explained the same point inside the spawn body was also removed; the docstring now carries the explanation once.
- **`pid: process.pid` in `global-setup.ts`** was the Playwright runner's PID, not the spawned reference-peer's, which is misleading to anyone reading `.fixture-state.json`. Since no caller actually consumes the field, switched the `spawned`-path write to `pid: null`. (The `env`-override path already wrote `null`.)

### Filed as new tickets (major)

- **`tickets/fix/web-e2e-tier2-connectivity`** — every Tier 2 spec fails inside `connectToBootstrap` waiting for `[data-testid="diag-connection-row"]`. The mode badge flips to `distributed` but `node.getConnections()` stays at 0 for the full 60 s window with zero entries in the in-app errors ring buffer. Confirmed independently: a raw `ws://127.0.0.1:9191/` dial from Node succeeds. Likely cause: the optimystic `interactive` subcommand does not declare `--offline` (only `service`/`run` do), so the spawned peer comes up as a multi-node `Distributed` cluster the browser cannot join solo. The ticket carries the smallest-credible upstream patch plus a fallback path (use `run --stay-connected --offline` instead) and an acceptance criterion that all 6 Tier 2 specs pass and the README callout is removed.
- **`tickets/backlog/reference-app-web-diagnostics-storage-backend-label`** — `collectStorage()` reads `storage.constructor.name`, which Vite minifies in the production bundle. The solo diagnostics spec was loosened during implement to "non-empty and not `—`" because of this; with a stable label the spec can tighten back to `expect(backend).toBe('IndexedDBRawStorage')`.

### Checked and accepted as-is

- **`throw new Error('unreachable')` after `testInfo.skip(true, …)`** in `e2e/distributed/_helpers.ts:19-22` is intentional — `skip(true)` throws synchronously, so the `throw` never executes; it exists only to narrow the return type for the type-checker. Comment in place. Kept.
- **`storage-backend` minification** — covered by the new backlog ticket above; current loosened assertion remains until that lands.
- **Transport-name structural assertion** — `solo/diagnostics.spec.ts` asserts "exactly 2, one matches `/websockets/i`, one matches `/circuit[- ]?relay/i`, none matches `/tcp/i`". This is intentional and the original "no TCP leaked into browser bundle" invariant is preserved.
- **`bootstrap-persistence.spec.ts` documents current behaviour** (reload re-hydrates the textarea but the node reverts to solo — no auto-reconnect). Treat any future auto-reconnect change as breaking that spec on purpose.
- **`disconnect-mid-session` errCount tolerance of 2** — libp2p close-event noise after A disconnects may land in the ring buffer; the buffer is capped at 10, so ≤ 2 is a meaningful regression canary without being flaky.
- **`reference-peer.ts` 250 ms `chooseTimer` race** — when stdout flushes both 0.0.0.0 and 127.0.0.1 listen-addr lines in a single chunk, the scan accumulates both candidates before the timer fires; loopback is then preferred. Behaviour verified in the Tier 1 test runs (`reference-peer ready: /ip4/127.0.0.1/…` in every run).
- **`page.on('dialog', d => void d.accept())` registered inside `gotoMessages`** in three Tier 2 specs and the Tier 1 CRUD spec — `gotoMessages` is called once per page per test, so no double-registration. Kept.
- **`globalThis.__referencePeer` teardown** — `global-teardown.ts` clears the slot on every path; the SIGTERM → 5 s grace → SIGKILL escalation inside `reference-peer.ts#stop` is the canonical pattern. The post-resolve stderr listener removal in `cleanup()` is intentional (we only care about startup-window stderr).
- **`yarn.lock` churn** is contained to `@playwright/test` + its transitive deps. No unrelated package bumps.
- **Tier 1 (10/10) re-validated after the inline edits.** typecheck (both `tsc` and the e2e tsconfig) clean.

## Out of scope (re-affirmed)

- Firefox / Safari coverage.
- Real-time push / gossip / sync assertions — convergence is poll-based by current contract.
- Concurrent-edit conflict UI — LWW per Tree.
- Performance, load, soak, Lighthouse, a11y.
- CI wiring.
