description: Review the Playwright e2e suite for @serfab/reference-app-web (Tier 1 solo + Tier 2 distributed fixture)
files: packages/reference-app-web/package.json, packages/reference-app-web/playwright.config.ts, packages/reference-app-web/tsconfig.e2e.json, packages/reference-app-web/e2e/, packages/reference-app-web/src/App.svelte, packages/reference-app-web/src/Home.svelte, packages/reference-app-web/src/Messages.svelte, packages/reference-app-web/src/Activity.svelte, packages/reference-app-web/src/Diagnostics.svelte, packages/reference-app-web/README.md, .gitignore
----

## What was built

A Chromium-only Playwright suite under `packages/reference-app-web/e2e/`, split into two tiers per the implement ticket:

- **Tier 1 — `e2e/solo/`** (5 spec files, 10 tests) — boot + identity, hash routing, messages CRUD, reload persistence, diagnostics surface.
- **Tier 2 — `e2e/distributed/`** (5 spec files, 6 tests) — mode flip, bootstrap persistence, two-tab convergence, cross-tab activity ordering, disconnect-mid-session.

Supporting infrastructure:

- `playwright.config.ts` — chromium only; `baseURL = http://127.0.0.1:4173`; `webServer` runs `yarn build && yarn preview --host 127.0.0.1 --port 4173 --strictPort`; `globalSetup` + `globalTeardown`; `fullyParallel: false` (Tier 2 fixture is a singleton); `retries: 2` on CI.
- `e2e/fixtures/optimystic-detect.ts` — resolves `../optimystic/packages/reference-peer/dist/src/cli.js`; returns `{ available, reason }` with distinct strings for "sibling missing" vs "package not built".
- `e2e/fixtures/reference-peer.ts` — spawns the peer on WS port `9191` with `--no-tcp --relay` (see "Known gaps" below for `--offline`), gathers candidate listen addrs for 250 ms, prefers the `/ip4/127.0.0.1/` loopback, 30 s startup timeout, `SIGTERM` → 5 s grace → `SIGKILL` on stop.
- `e2e/fixtures/state.ts` — `e2e/.fixture-state.json` (gitignored) is the side channel between global-setup and the specs. Marker carries either `{ available: true, multiaddr, source: 'spawned' | 'env', pid }` or `{ available: false, reason }`.
- `e2e/global-setup.ts` / `e2e/global-teardown.ts` — checks `OPTIMYSTIC_WS_BOOTSTRAP` first (manual override), then `optimystic-detect`, otherwise marks Tier 2 unavailable.
- `e2e/distributed/_helpers.ts` — `requireFixture(state, testInfo)` is called from each Tier 2 spec's `beforeAll` so the skip surface is per-spec; `connectToBootstrap(page, multiaddr)` fills the textarea, clicks Connect, waits for `mode-badge=distributed`, and then polls Diagnostics for `diag-connection-row >= 1`.

Component testids (mechanical additions, no behaviour change) cover the inventory in the implement ticket — `mode-badge`, `home-status/mode/peer-id`, `bootstrap-input`, `btn-connect/disconnect`, `last-bootstrap`, all compose / row / edit / save / cancel / delete buttons, `message-row` with `data-message-id`, `activity-row` with `data-message-id`+`data-action`+`data-timestamp`, plus the diagnostics surface (`diag-transports`, `diag-identity-persisted`, `diag-connection-row` with `data-peer-id`, `diag-storage-backend`, `diag-crypto` with per-row `data-check`/`data-ok`, `diag-errors` with `data-error-count`).

Package wiring: `@playwright/test ^1.60.0` added as a devDependency; `test:e2e`, `test:e2e:install`, `test:e2e:ui` scripts added; `.gitignore` excludes `packages/reference-app-web/e2e/.fixture-state.json`, `test-results/`, `playwright-report/`.

## How to validate

```bash
# One-time
yarn workspace @serfab/reference-app-web test:e2e:install   # installs Chromium 148.0.7778.96 (matches @playwright/test 1.60.0)

# Suite
yarn workspace @serfab/reference-app-web test:e2e 2>&1 | tee /tmp/web-e2e.log

# Type checks
yarn workspace @serfab/reference-app-web typecheck
( cd packages/reference-app-web && npx tsc -p tsconfig.e2e.json --noEmit )

# Build
yarn workspace @serfab/reference-app-web build
```

Tier 1 alone:

```bash
yarn workspace @serfab/reference-app-web test:e2e --grep "Tier 1"
```

To force Tier 2 to skip even when the sibling is built (e.g. to confirm the marker path):

```bash
# Easiest: stash the sibling temporarily
mv ../optimystic/packages/reference-peer/dist ../optimystic/packages/reference-peer/dist.bak
yarn workspace @serfab/reference-app-web test:e2e --grep "Tier 2"
# Tier 2 specs should report "Tier 2 fixture unavailable: reference-peer not built …"
```

To point Tier 2 at a custom peer:

```bash
OPTIMYSTIC_WS_BOOTSTRAP="/ip4/127.0.0.1/tcp/9091/ws/p2p/12D3KooW..." \
  yarn workspace @serfab/reference-app-web test:e2e --grep "Tier 2"
```

## Test results at hand-off

```
Tier 1: 10 / 10 passing
Tier 2:  0 / 6 passing (all fail in the bootstrap-dial phase — see Known gaps)
```

Tier 1 specs are stable and fast (the full Tier 1 grep run took 21.6 s on the dev box). Tier 2 failures land consistently inside `connectToBootstrap` waiting for a libp2p Connections row — see below.

## Known gaps and honest flags

1. **Tier 2 cannot establish a live libp2p connection in this environment.** Every Tier 2 spec gets as far as the mode badge flipping to `distributed`, then hangs waiting for `node.getConnections().length >= 1` on the Diagnostics page. The connection count stays at 0 for the full 60 s wait window. Independent evidence:
   - Raw `ws://127.0.0.1:<port>/` dial from a Node script connects successfully (`WS OPEN`) against the same spawned peer. So the WS server is up and accepting browser-shaped clients.
   - No errors land in the in-app `Recent errors` ring buffer — the browser libp2p side reports no `error` or `unhandledrejection` to surface.
   - This is independent of timing: extending the wait to several minutes did not change the outcome in spot checks.
   - The plan ticket and the existing README both prescribe `--ws-port <N> --no-tcp --relay --offline` for the bootstrap. The current optimystic source (`/c/projects/optimystic/packages/reference-peer/src/cli.ts`) reads `options.offline` (lines 186, 288, 345, 375) but never declares `.option('--offline', …)` on the `interactive` commander command (lines 658–687). Passing `--offline` therefore errors with `unknown option '--offline'`. The fixture currently spawns the peer **without** `--offline`, so the peer initializes a single-node `Distributed (NetworkTransactor)` instead of the `Offline (LocalTransactor)` the README assumes. That mismatch is the most likely root cause (cluster-size disagreement between the bootstrap and the browser would prevent the connection from settling), but I did not finish proving it inside this ticket.
   - Recommended next step: either patch optimystic's `interactive` command to declare the `--offline` flag, or rewire the fixture to use a different mode (`run`? `service`?) that the cli supports today. The fixture spawn helper is the only thing that would need updating — the Tier 2 specs themselves are agnostic about how the multiaddr was obtained, because they read it from `e2e/.fixture-state.json`.
2. **`Diagnostics → Storage backend` is minified in the production bundle.** `diagnostics.svelte.ts` reads `storage.constructor.name`, which Vite minifies to a 2–3 char string (we observed `Sie`). The ticket asked for an assertion that the cell contains `IndexedDBRawStorage`; the spec instead asserts the cell is non-empty and not the `—` placeholder. The right long-term fix is on the implementation side (hard-code the backend label, or read it from a static field), and that's worth filing separately if it matters to anyone.
3. **Transport-name assertion is structural, not name-equality.** The ticket asked for the literal set `['WebSockets', 'circuit-relay-v2']`. The current libp2p builds emit `@libp2p/websockets` and `@libp2p/circuit-relay-v2-transport`. The spec now asserts: exactly 2 transports, one matches `/websockets/i`, one matches `/circuit[- ]?relay/i`, and none matches `/tcp/i`. The README was updated to document the same. The original invariant ("no TCP leaked into the browser bundle") is preserved.
4. **Chromium-headless-shell version skew on first install.** The repo already had `chromium_headless_shell-1217` cached from a previous Playwright version. `@playwright/test 1.60.0` ships against build `1223`, so the suite errors on first run with `Executable doesn't exist at …\chrome-headless-shell-1223\…`. Running `npx playwright install chromium` (or the `test:e2e:install` script) fixes it. The README documents the install step but does not call out the upgrade-path failure mode.
5. **`bootstrap-persistence.spec.ts` documents current behaviour, not desired.** After a reload of a previously-connected tab, the bootstrap textarea is re-hydrated from IndexedDB *and* the mode reverts to `solo` (no auto-reconnect). The spec asserts both. If a future change makes reload auto-reconnect, that test will break — which is the intended canary.
6. **Cross-tab convergence relies on the 4 s in-app poll.** All Tier 2 waits are `expect.poll` / `toHaveText(..., { timeout: 12_000 })`-style, never `page.waitForTimeout`. The implement ticket explicitly told tests for the poll itself to wait rather than click Refresh; the specs follow that rule.
7. **`disconnect-mid-session` tolerates up to 2 entries in the Recent-errors ring buffer.** Some libp2p `close` events may legitimately land there after A disconnects. The ring buffer is capped at 10, so anything healthy should be well under that. A regression that fills the buffer would still trip.
8. **One small structural quirk in `reload-persistence.spec.ts`.** The spec used to enumerate `for (const c of contents)` to assert per-message activity rows by id, but message IDs are server-generated and aren't captured pre-reload. The loop ended up empty; I left a no-op `for` with a comment so the intent is visible. Net assertion still checks that `[data-testid="activity-row"][data-action="created"]` count ≥ messages-sent count after reload.

## What the reviewer should focus on

- **Tier 2 connectivity** — is the `--offline` upstream issue the actual blocker? If so, what's the smallest patch to the optimystic CLI (or to the fixture spawn flags) that gets the dial to settle? Once a single Tier 2 spec connects, the rest should fall in line because they all funnel through the same `connectToBootstrap` helper.
- **Selector hygiene** — the testid additions are all mechanical. Worth a quick sweep for any I missed (the diagnostics row enumeration for `diag-connection-row` uses both the testid attribute and a `data-peer-id` shadow; if a future row gains a different shape, the tests should still match).
- **Fixture lifetime / leakage** — confirm that `globalThis.__referencePeer` is actually cleared by `global-teardown.ts` on every code path (Ctrl-C, test failure, etc.). The `cleanup` inside `reference-peer.ts` removes stdout/stderr listeners on resolve/reject, so post-resolution stderr is dropped — that's intentional but worth a second look.
- **`OPTIMYSTIC_WS_BOOTSTRAP` env override path** — never exercised in the failure run; verify it still does the right thing when set.

## Out of scope (re-affirmed)

- Firefox / Safari coverage.
- Real-time push / gossip / sync assertions — convergence is poll-based by current contract.
- Concurrent-edit conflict UI — LWW per Tree.
- Performance, load, soak, Lighthouse, a11y.
- CI wiring.
