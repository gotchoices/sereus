---
description: 3-node mesh fixture (one --offline bootstrap + two headless service peers) plus per-spec wiring to dial all mesh members up front; connectivity Tier 2 specs pass, data-convergence specs deferred to follow-up
files: packages/reference-app-web/e2e/fixtures/reference-peer.ts, packages/reference-app-web/e2e/fixtures/state.ts, packages/reference-app-web/e2e/global-setup.ts, packages/reference-app-web/e2e/distributed/_helpers.ts, packages/reference-app-web/e2e/distributed/two-tab-convergence.spec.ts, packages/reference-app-web/e2e/distributed/cross-tab-activity.spec.ts, packages/reference-app-web/e2e/distributed/disconnect-mid-session.spec.ts, packages/reference-app-web/e2e/distributed/mode-flip.spec.ts, packages/reference-app-web/e2e/distributed/bootstrap-persistence.spec.ts, packages/reference-app-web/README.md
---

## Summary

Replaced the single `interactive --offline` reference-peer fixture with a
3-node mesh (`spawnReferenceMesh`): one bootstrap peer plus two headless
`service` peers bootstrapped to it. The fixture state now carries the
service multiaddrs alongside the primary, and `collectBootstrapMultiaddrs`
hands every Tier 2 spec a complete list to paste into the Network panel.
A `OPTIMYSTIC_E2E_DEBUG=1` gate injects `localStorage.debug` and pipes
matching browser console traces to Playwright stdout.

The implement-stage commit honestly reported that the connectivity-side
Tier 2 specs (mode-flip × 2, bootstrap-persistence) now pass against the
mesh, while the three data-convergence specs (two-tab-convergence,
cross-tab-activity, disconnect-mid-session) still fail because browsers
aren't dialable as cluster members. Follow-up was filed as
`web-e2e-tier2-data-convergence-relay` (originally drafted as
`...-thin-client`).

## Review findings

### Diff vs. handoff: scope is what was claimed

Read e9e5599 cold before opening the handoff. The diff is exactly what
the handoff describes: a `spawnReferenceMesh` that shells out to one
`interactive --offline` bootstrap plus two `service` peers; a
`SingleNodeHandle` abstraction; reverse-order teardown; `state.ts`
gains optional `serviceMultiaddrs`; global-setup wires the new ports;
all five specs switch from `multiaddr: string` to
`bootstrapList: string[]` via `collectBootstrapMultiaddrs`; README
documents the new mesh; backlog ticket filed. No surprise diffs, no
sneaky `src/` edits.

### Fixture lifecycle: clean

Ran the full Tier 2 sweep (2.5m, 1 worker) and checked the fixture
ports immediately after:

```
Get-NetTCPConnection -LocalPort 9191,9192,9193
  9191 / 9192 / 9193 -> all TimeWait, OwningProcess=0
```

No live children on any of the three fixture ports after teardown.
The `[...children].reverse()` snapshot in `stopAll` and the per-child
`SIGTERM → 5s grace → SIGKILL` ladder in `spawnSingleNode` both
behave as advertised. Sequential (not parallel) reverse teardown is
the right choice because service peers should leave before the
bootstrap they're FRET-joined to.

### Spec wiring: no stale `multiaddr: string` paths

Grep confirms every Tier 2 spec now passes
`bootstrapList: string[]` to `connectToBootstrap`. Mode-flip's
`extractPeerIdFromMultiaddr(fixture.multiaddr)` correctly continues to
pull the *bootstrap* peer ID specifically (it's the one a "connected
to the bootstrap" assertion is about), and the optional
`serviceMultiaddrs` field on `FixtureStateAvailable` keeps the
env-override path well-typed.

### Inline fix: dead union on `connectToBootstrap`

`connectToBootstrap(page, multiaddrs: string | string[])` had a
`string` branch with no remaining callers — all 5 specs route
through `collectBootstrapMultiaddrs`, which always returns an array
(env-override path returns `[fixture.multiaddr]`). Per
AGENTS.md ("Don't worry about backwards compatibility yet", "Don't be
type lazy"), tightened to `multiaddrs: string[]` and dropped the
JSDoc "legacy callers (string)" mention. Re-ran `tsc -p
tsconfig.e2e.json` — clean.

### Tests

- `yarn workspace @serfab/reference-app-web test:e2e --grep "Tier 1"`
  → **10 passed** (21s). No regression on the solo tier, as expected
  given the diff doesn't touch `src/` or `e2e/solo/`.
- `yarn workspace @serfab/reference-app-web test:e2e --grep "Tier 2"`
  → **3 passed, 3 failed** (2.5m): bootstrap-persistence ✓,
  mode-flip × 2 ✓, two-tab-convergence ✘ (rowOnB never visible),
  cross-tab-activity ✘ (6-message union never observed),
  disconnect-mid-session ✘ (rowOnB never visible after A's first
  send). Matches the implementer's reported numbers byte-for-byte.

  Note that this run is against HEAD (e9e5599 + the downstream
  `web-e2e-tier2-data-convergence-relay` work). The relay ticket
  attempted to make browser peers dialable via circuit-relay-v2
  reservations and added the matching `--network` plumbing, but the
  three data-convergence specs are still failing in the current
  environment. That is **not a finding against this ticket** — the
  implementer was transparent that 6/6 was out of scope and filed a
  follow-up — but it does mean the original "all six Tier 2 specs
  pass" outcome is still open. Surfacing it here so the next pass on
  the relay branch (or its own follow-up) doesn't miss the regression.

### Code quality / SPP / DRY / type safety

- `spawnSingleNode` shares stdout-scan / cleanup / teardown logic
  across bootstrap and service spawns — no copy-paste duplication.
- `chooseTimer` collects multiaddr candidates for 250 ms before
  picking the loopback (or first), so the lib2p2 listener race
  doesn't fall through to a `::1` IPv6 address the headless browser
  can't dial. Reasonable; matches the original single-peer logic.
- Stdout/stderr ring buffers cap at 64 KB then truncate to 32 KB.
  Good guard against runaway logs.
- No new `any`, no untyped globals beyond the existing
  `globalThis.__referencePeer` (necessary because Playwright's
  global-setup can't return a handle to global-teardown).
- Optional `serviceMultiaddrs?: string[]` on `FixtureStateAvailable`
  preserves the env-override shape; `collectBootstrapMultiaddrs`
  handles `undefined` defensively.

### Resource cleanup / error handling

- `try { spawnBootstrap; spawnServices } catch { await stopAll() }`
  in `spawnReferenceMesh` correctly tears down whatever children
  were already spawned if a later spawn fails. Reviewed.
- The per-child `stop()` is idempotent (no-ops when the child already
  exited) and SIGKILL-clamped. The combined `stopAll` swallows
  per-child errors and keeps tearing down — best-effort is right
  here.
- `maybeEnableBrowserDebug` is a no-op when `OPTIMYSTIC_E2E_DEBUG`
  isn't set; when set, it adds a `console` listener per page. Slight
  concern that the listener isn't removed on teardown, but page
  closure (in `finally { ctx.close() }`) tears it down for free.

### Docs

README's "Tier 2 fixture resolution" section was updated by this
ticket *and again* by the relay ticket (the network-name argument).
The current text is consistent with the spawned args in
`spawnReferenceMesh` and accurately describes the mesh shape, the
manual override path, and the residual gap on the README-style
single-`--offline` manual demo. No docs drift to fix here.

### Not found / no concerns

- No security findings: spawned children inherit env (with
  `FORCE_COLOR=0`); no shell interpolation; multiaddr regex is
  read-only.
- No async/await bugs: all promises awaited; `void` not needed
  anywhere new because every fire-and-forget already had one.
- No `case` blocks added; no inline `import()`; no SQL changed.

### Disposition

- One minor inline fix landed in this review (`connectToBootstrap`
  signature tightened to `string[]`).
- The "data-convergence still failing" outcome belongs to the
  downstream `web-e2e-tier2-data-convergence-relay` ticket and its
  own review chain; no new ticket filed from this review.

## Files changed (post-implement + review fix)

- `packages/reference-app-web/e2e/fixtures/reference-peer.ts` —
  `spawnReferenceMesh` replaces `spawnReferencePeer`; bootstrap +
  N service peers; shared `spawnSingleNode`; reverse-order teardown.
- `packages/reference-app-web/e2e/fixtures/state.ts` — optional
  `serviceMultiaddrs?: string[]` on `FixtureStateAvailable`.
- `packages/reference-app-web/e2e/global-setup.ts` — mesh on
  9191/9192/9193; env-override sets `serviceMultiaddrs: []`.
- `packages/reference-app-web/e2e/distributed/_helpers.ts` — adds
  `collectBootstrapMultiaddrs`, `maybeEnableBrowserDebug`, and
  `connectToBootstrap(page, multiaddrs: string[])` (signature
  tightened during review — no remaining `string`-arg callers).
- All five Tier 2 specs — switched to `bootstrapList: string[]` via
  `collectBootstrapMultiaddrs`.
- `packages/reference-app-web/README.md` — Tier 2 fixture resolution
  describes the 3-node mesh and the manual-demo gap.
