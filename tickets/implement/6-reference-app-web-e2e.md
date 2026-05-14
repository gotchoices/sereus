description: Playwright e2e tests for @serfab/reference-app-web — solo CRUD + distributed two-tab convergence
files: packages/reference-app-web/package.json, packages/reference-app-web/playwright.config.ts, packages/reference-app-web/e2e/, packages/reference-app-web/e2e/fixtures/, packages/reference-app-web/e2e/solo/, packages/reference-app-web/e2e/distributed/, packages/reference-app-web/src/App.svelte, packages/reference-app-web/src/Home.svelte, packages/reference-app-web/src/Messages.svelte, packages/reference-app-web/src/Activity.svelte, packages/reference-app-web/src/Diagnostics.svelte, packages/reference-app-web/README.md
----

## Goal

Stand up an automated end-to-end suite for the browser reference app, covering the two acceptance tiers spelled out in `tickets/plan/6-reference-app-web-e2e.md` (now retired by this ticket):

- **Tier 1 — solo:** boot, identity persistence, hash routing, messages CRUD round-trip, persistence across reload, and diagnostics-surface invariants (notably the `WebSockets, circuit-relay-v2` Transports list — the canary that nothing pulled TCP into the browser bundle).
- **Tier 2 — distributed:** an Optimystic `reference-peer` global-setup fixture, mode-flip (`solo → distributed`), bootstrap persistence on reload, two-tab message convergence with bounded polling waits, cross-tab activity ordering, and disconnect-mid-session behaviour.

The suite must run cleanly from `yarn workspace @serfab/reference-app-web test:e2e`, must skip Tier 2 (not fail) when the sibling `../optimystic` checkout is missing or unbuilt, and must use **Chromium only** for this pass (Firefox/Safari are explicit non-goals per the plan).

## Architecture

```
packages/reference-app-web/
  playwright.config.ts          # webServer = vite preview; chromium only; tier 1 always, tier 2 gated by fixture availability
  e2e/
    fixtures/
      reference-peer.ts         # spawn/teardown helper, parses listen-addr from stdout, exposes WS multiaddr
      optimystic-detect.ts      # locate ../optimystic/packages/reference-peer/dist/src/cli.js; if absent or unbuilt → return { available: false, reason }
    global-setup.ts             # if optimystic-detect.available → spawn fixture once; store multiaddr in env/JSON file; otherwise no-op
    global-teardown.ts          # tear fixture down
    solo/
      boot.spec.ts              # boot, identity, mode badge, peer-id persistence within ctx, fresh ctx → fresh peer id
      routing.spec.ts           # nav across #/, #/messages, #/log, #/diag + cold-load deep-link
      messages-crud.spec.ts     # compose / edit / delete / activity ordering
      reload-persistence.spec.ts# messages survive reload
      diagnostics.spec.ts       # Transports list == [WebSockets, circuit-relay-v2], persisted ✓, crypto-sanity 7-true, IndexedDBRawStorage, no recent errors after clean boot
    distributed/
      mode-flip.spec.ts         # paste fixture multiaddr → connect → distributed; disconnect → solo; Connections row shows bootstrap peer
      bootstrap-persistence.spec.ts # reload pre-fills bootstrap input; reconnect succeeds
      two-tab-convergence.spec.ts   # the README acceptance check, bounded waits not fixed sleeps
      cross-tab-activity.spec.ts    # concurrent writes from both tabs, set-equality + newest-first invariant per side
      disconnect-mid-session.spec.ts# A disconnects → A solo + reads local; B unaffected
```

### Detection / skip semantics

`e2e/fixtures/optimystic-detect.ts` resolves `../../../optimystic/packages/reference-peer/dist/src/cli.js` relative to the package root (one `..` more than the workspace because the package is at `packages/reference-app-web/`; resolve via `path.resolve(packageRoot, '../../../optimystic/...')`). Returns:

```ts
type DetectResult =
  | { available: true; cliPath: string }
  | { available: false; reason: string };
```

`global-setup.ts` reads the detect result; if unavailable, writes a marker JSON (`e2e/.fixture-state.json`) with `{ available: false, reason }`. Every Tier 2 spec opens the marker via a small helper and calls `test.skip(!available, reason)` in a `beforeAll` so the skip surfaces clearly per spec.

### Fixture lifetime

Spawn once in global-setup, kill in global-teardown. Command:

```
node <cliPath> interactive --ws-port <port> --no-tcp --relay --offline
```

Port: pick a fixed free port (start at `9191` — outside the README's documented `9091` so a developer can have a manual peer up at the same time without collision). Parse stdout line-by-line for the first `/ip4/...tcp/<port>/ws/p2p/<peerId>` line; capture it as the canonical bootstrap multiaddr. Timeout after 30 s with a clear error if the line never appears (suite fails fast rather than hanging).

### Test-data-target hooks

The Svelte components don't currently expose stable selectors. Add `data-testid` attributes (mirror the RN-side inventory pattern from `tickets/backlog/6-maestro-e2e-flows.md`):

| Element                                | testid                          | File                       |
|----------------------------------------|---------------------------------|----------------------------|
| Mode badge (header)                    | `mode-badge`                    | `App.svelte`               |
| Nav link Home                          | `nav-home`                      | `App.svelte`               |
| Nav link Messages                      | `nav-messages`                  | `App.svelte`               |
| Nav link Activity                      | `nav-activity`                  | `App.svelte`               |
| Nav link Diagnostics                   | `nav-diagnostics`               | `App.svelte`               |
| Home status value                      | `home-status`                   | `Home.svelte`              |
| Home mode value                        | `home-mode`                     | `Home.svelte`              |
| Home peer-id value                     | `home-peer-id`                  | `Home.svelte`              |
| Bootstrap textarea                     | `bootstrap-input`               | `Home.svelte`              |
| Connect button                         | `btn-connect`                   | `Home.svelte`              |
| Disconnect button                      | `btn-disconnect`                | `Home.svelte`              |
| Last-used bootstrap chip               | `last-bootstrap`                | `Home.svelte`              |
| Compose author input                   | `compose-author`                | `Messages.svelte`          |
| Compose content input                  | `compose-content`               | `Messages.svelte`          |
| Compose Send button                    | `btn-send`                      | `Messages.svelte`          |
| Refresh button                         | `btn-refresh`                   | `Messages.svelte`          |
| Message row (per item)                 | `message-row` + `data-message-id="<id>"` | `Messages.svelte` |
| Message row body                       | `message-body`                  | `Messages.svelte`          |
| Edit / Save / Cancel / Delete buttons  | `btn-edit` / `btn-save` / `btn-cancel` / `btn-delete` (scoped per row) | `Messages.svelte` |
| Edit input                             | `edit-input`                    | `Messages.svelte`          |
| Activity row (per item)                | `activity-row`                  | `Activity.svelte`          |
| Diagnostics Transports list           | `diag-transports`               | `Diagnostics.svelte`       |
| Diagnostics Identity persisted badge   | `diag-identity-persisted`       | `Diagnostics.svelte`       |
| Diagnostics Connections rows           | `diag-connection-row`           | `Diagnostics.svelte`       |
| Diagnostics Storage backend            | `diag-storage-backend`          | `Diagnostics.svelte`       |
| Diagnostics Crypto-sanity table        | `diag-crypto`                   | `Diagnostics.svelte`       |
| Diagnostics Recent errors list        | `diag-errors`                   | `Diagnostics.svelte`       |

The `confirm()` for delete blocks tests — wire `page.on('dialog', d => d.accept())` per spec rather than ripping the confirmation out of the app.

### Convergence waits

Polling interval is 4 s (`startPolling()` in `messages.svelte.ts`). Tests should use `expect.poll(...).toPass({ timeout: 12_000 })` or `expect(locator).toHaveText(..., { timeout: 12_000 })` — three poll windows of slack is generous enough to be reliable in CI without masking real regressions. Tests may also click the in-app Refresh button to force an immediate read when the contract under test is "the data eventually converges" rather than "the poll wakes up on its own"; tests for the poll itself must wait, not click Refresh.

### Concurrent-write ordering invariant

Tree semantics are LWW; activity ordering is per-write timestamp. The cross-tab activity test asserts:

1. The set of activity entries on tab A equals the set on tab B (after a bounded wait).
2. Each side's list is monotonically non-increasing by timestamp (newest-first invariant).

It does **not** assert strict total order across the two sides — that would be wrong per the underlying contract.

## TODO

### Phase 1 — Playwright scaffolding

- Add devDependencies to `packages/reference-app-web/package.json`: `@playwright/test`. Add scripts: `test:e2e` (runs `playwright test`), `test:e2e:install` (`playwright install --with-deps chromium`), `test:e2e:ui` (`playwright test --ui`).
- Create `playwright.config.ts`: chromium only, `use.baseURL = 'http://localhost:4173'` (vite preview default), `webServer` runs `yarn build && yarn preview --host 127.0.0.1 --port 4173 --strictPort` with `reuseExistingServer: !process.env.CI`, `globalSetup` + `globalTeardown` paths, `testDir: './e2e'`, `fullyParallel: false` (Tier 2 fixture is a singleton), `retries: process.env.CI ? 2 : 0`, `reporter: [['list'], ['html', { open: 'never' }]]`.
- `e2e/global-setup.ts` and `e2e/global-teardown.ts` per architecture above. Write fixture state to `e2e/.fixture-state.json` (gitignored).
- `e2e/fixtures/optimystic-detect.ts`: existence + executability check on `../optimystic/packages/reference-peer/dist/src/cli.js`. Distinct skip reasons for "sibling repo missing" vs "package not built".
- `e2e/fixtures/reference-peer.ts`: spawn helper with stdout multiaddr extraction and 30-s startup timeout. Kill with `SIGTERM` then `SIGKILL` after 5 s.
- Update `.gitignore` (workspace and/or package) to exclude `packages/reference-app-web/e2e/.fixture-state.json`, `packages/reference-app-web/test-results/`, `packages/reference-app-web/playwright-report/`.

### Phase 2 — testid plumbing in Svelte components

- Add the `data-testid` attributes catalogued in the table above. Keep changes mechanical — no behaviour/layout changes. Run `yarn workspace @serfab/reference-app-web typecheck` after.
- For message rows, also add `data-message-id={msg.id}` so tests can target a specific row deterministically without coupling to ordering.

### Phase 3 — Tier 1 solo specs

- `solo/boot.spec.ts`: mode badge `solo`, status reaches `running` (poll with timeout), peer-id non-empty; reload preserves peer id (capture before reload, assert equal after); fresh context → different peer id.
- `solo/routing.spec.ts`: each of `#/`, `#/messages`, `#/log`, `#/diag` reachable both by clicking nav and by cold `page.goto('/#/diag')` etc.
- `solo/messages-crud.spec.ts`: compose → row visible by `data-message-id`; edit → body updates; delete → row gone (with dialog auto-accept); activity diary lists corresponding entries newest-first.
- `solo/reload-persistence.spec.ts`: compose 2 messages, reload, assert both still present and activity rehydrated.
- `solo/diagnostics.spec.ts`: Transports list exactly `['WebSockets', 'circuit-relay-v2']` (order-tolerant set match), `diag-identity-persisted` reads `persisted ✓`, the seven crypto-sanity rows are all `true`, Recent errors list is empty after a clean boot, Storage backend cell contains `IndexedDBRawStorage`.

### Phase 4 — Tier 2 distributed specs

- Common helper `e2e/distributed/_helpers.ts`: `loadFixtureState()`, `skipUnlessFixture(test)`, `connectToBootstrap(page, multiaddr)`.
- `distributed/mode-flip.spec.ts`: paste multiaddr → click Connect → mode badge transitions through `connecting` → `distributed`; Diagnostics → Connections shows ≥ 1 row with the bootstrap peer id (parse from multiaddr). Click Disconnect → mode badge `solo`, connections list empty.
- `distributed/bootstrap-persistence.spec.ts`: connect once; reload; assert bootstrap textarea pre-filled with the multiaddr and `last-bootstrap` chip is gone (mode reverted to solo on reload — verify against current behaviour; if reload auto-reconnects, assert that instead; document whichever the code does today).
- `distributed/two-tab-convergence.spec.ts`: two browser contexts A and B, both connect to fixture, both `distributed`. A sends "Hello from A" → B sees it (`expect.poll` ≤ 12 s). B edits → A sees edit. A deletes → B sees deletion. Both activity diaries show entries.
- `distributed/cross-tab-activity.spec.ts`: A and B each send 3 messages concurrently (`Promise.all` on cross-context fills + sends). Assert set-equality on visible message ids in both tabs and newest-first invariant on each tab's activity list timestamps.
- `distributed/disconnect-mid-session.spec.ts`: both connected; A sends "from A" and B sees it; A disconnects → A mode `solo`; A's existing message list still shows the prior message (locally cached); B remains `distributed` and sees no error rows.

### Phase 5 — README + verification

- Update `packages/reference-app-web/README.md`:
  - New section **"Automated end-to-end tests"** referencing `yarn workspace @serfab/reference-app-web test:e2e` and the install step `playwright install --with-deps chromium`.
  - Document Tier 1 always runs; Tier 2 skips when `../optimystic/packages/reference-peer/dist/` is missing.
  - Document the env override `OPTIMYSTIC_WS_BOOTSTRAP=<multiaddr>` if a developer wants to point Tier 2 at a manually-started peer (implement this env-var fallback in `global-setup.ts`: if set, skip spawning and use the provided multiaddr; if both unset and auto-detect fails, mark Tier 2 unavailable).
- Run `yarn workspace @serfab/reference-app-web typecheck` and confirm it passes.
- Stream `yarn workspace @serfab/reference-app-web test:e2e 2>&1 | tee /tmp/web-e2e.log` (never silent redirect — idle-timeout discipline). Expect Tier 1 green; Tier 2 green if the sibling repo is present in this environment, otherwise cleanly skipped with reason.

## Out of scope (deferred / non-goals reaffirmed from plan)

- Firefox / Safari coverage.
- Real-time push / gossip / sync subscription assertions — convergence is poll-based by current contract.
- Conflict UI under concurrent edits (LWW per Tree).
- Performance, load, soak, Lighthouse, a11y.
- Wiring this suite into CI — separate ticket if/when desired; this one stops at "runs cleanly locally".
