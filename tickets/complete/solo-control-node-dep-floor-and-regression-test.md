----
description: An app embedding our library reported that a brand-new node with no peers froze forever when reading or writing its own settings. We now declare the version of the underlying database engine we actually test against, and added a test that fails with a clear named message instead of hanging.
prereq:
files: packages/cadre-core/test/control-database-solo.spec.ts, packages/cadre-core/test/control-stream-timeout.spec.ts, packages/cadre-core/test/control-database-genesis.spec.ts, packages/cadre-core/src/control-stream.ts, packages/cadre-core/package.json, packages/cadre-cli/package.json, packages/quereus-plugin-sereus/package.json, packages/integration-tests/package.json, packages/reference-app-rn/package.json, packages/reference-app-web/package.json, packages/reference-app-ns/package.json, packages/reference-app-rn/src/cadre-phone.ts, packages/reference-app-web/src/lib/cadre-web.ts, packages/reference-app-web/src/lib/diagnostics.svelte.ts, docs/STATUS.md
difficulty: medium
----

# Complete: solo control DB — ship the substrate version we test, and cover the solo shape

## What shipped

**Declared dependency ranges now match the linked workspace.** Every `@optimystic/*` range
moved `^0.14.1` → `^0.16.3` across the seven consuming packages (`cadre-core`, `cadre-cli`,
`quereus-plugin-sereus`, `integration-tests`, `reference-app-{rn,web,ns}`). 0.16.3 is both the
linked sibling workspace version and the newest npm release. Root `resolutions` unchanged.
Only one *resolved* version actually moved: `@optimystic/db-p2p-storage-fs` has no
`resolutions` entry, so it genuinely ran 0.14.1 while every sibling ran linked 0.16.3. No API
drift surfaced.

**New regression spec `packages/cadre-core/test/control-database-solo.spec.ts`** — the
cadre-of-one shape mobile and browser embedders actually configure: WebSockets-only transport,
no listen address, empty bootstrap list. Genesis → read-back (typed API and raw `select`) →
post-genesis local write → read-back, for both node profiles, plus a warm restart on the same
identity and block storage. Every control operation runs under a per-operation deadline that
fails the test *naming the operation*.

**`control-database-genesis.spec.ts` annotated** as the *listening* solo shape, so the two read
as a matched pair rather than duplicates. No behavioural change.

**`docs/STATUS.md`** gained a "Declared dependency range vs linked workspace" rule and a
"Solo (cadre-of-one) control DB" coverage subsection.

**Three `NOTE:` tripwires** in the reference apps where a control operation is awaited without
a deadline (React Native `startPhoneNode`, web `runOwnerGenesis`, web diagnostics
`collectCadre`). No per-app deadlines added — see the reasoning under review findings.

## Review findings

### Checked

Read the implement diff (`87b8d75`) before the handoff summary. Scrutinised: the new spec's
correctness and honesty as a regression floor; whether its configuration actually produces the
shape it claims; duplication against existing production helpers; the completeness of the
version bump across every workspace; whether the three tripwire sites are the full set;
accuracy of every documentation claim in the files touched; and the four build-health gates.

Validation run after my changes: `yarn lint` (root, clean), `yarn typecheck` (root, pass),
`yarn build` (root, pass), `cadre-core yarn test` (**54 files / 732 passed, 1 skipped** — up
from 53/725, the delta being the seven new tests below), the solo spec three times in
succession (stable, no cross-run interference from the randomised party ids), and `yarn
dep-check` (pre-existing failure, see below).

### Found and fixed in this pass (minor)

- **The spec reimplemented production code.** Its local `within()` helper was a hand-rolled
  `Promise.race` deadline, while `packages/cadre-core/src/control-stream.ts` already exports
  `withTimeout(ms, label, op)` — the same primitive, used by the formation, wake, and
  strand-addr protocols. `within()` is now a two-line delegation to `withTimeout`, so the
  spec's diagnostics rest on shared, exercised code. Failure message is now
  `solo control op <operation> timed out after <ms>ms`.
- **`withTimeout` had zero direct test coverage** — production code three protocols hang their
  liveness on, and now the thing this ticket's whole diagnostic value depends on. Added
  `packages/cadre-core/test/control-stream-timeout.spec.ts` (7 fake-timer tests): resolution
  and rejection pass-through, fires with the exact labelled message, does *not* fire one tick
  early, invokes `onTimeout` before rejecting, swallows a throwing `onTimeout` rather than
  masking the timeout, and clears its timer once settled.
- **The deadline guard was never observed firing** — the handoff flagged this explicitly as
  unverified. Forced it with a throwaway spec containing a never-settling operation; confirmed
  the real failure output is `Error: solo control op ensureOwnerKey() (genesis) timed out after
  300ms`. Throwaway file removed. Documented ordering detail found while testing: `withTimeout`
  clears its timer in a trailing `.finally`, one microtask behind the caller resuming. Harmless
  (a 1000ms macrotask cannot fire in a microtask gap), but the test asserts the guarantee that
  holds rather than a stricter same-tick one, with a comment saying why.
- **The spec never asserted it got the shape it configures.** `soloConfig` asks for
  `listenAddrs: []`, and `CadreNode` forwards it through a truthiness spread
  (`...(network?.listenAddrs && { listenAddrs })`) — an empty array is truthy, so it does reach
  libp2p today. But a refactor to a `.length` check would silently drop it and the spec would
  quietly revert to testing the *listening* shape its companion already covers, with every test
  still green. Added `expectNotListening()` (asserts `node.getMultiaddrs()` is empty) after all
  three node starts, with a comment naming the spread it guards.
- **Two false claims in `docs/STATUS.md`.** "covering all nine workspaces" for `dep-check` —
  there are ten packages, and the tenth is the cause of the red gate below; corrected and the
  red gate recorded honestly with a pointer to its ticket. And a stale section heading
  "Optimystic blocker (root cause — sibling repo `../optimystic`, HEAD past v0.14.1)", where
  0.14.1 no longer refers to anything in the repo; reworded. Also documented the new
  `control-stream-timeout.spec.ts` and the offline-peer gap in the solo subsection.

### Found and filed as tickets (major)

- **`fix/knip-missing-reference-app-ns-workspace`** — `yarn dep-check` **exits 1**, and did
  before this ticket. `knip.ts` lists nine workspaces and `packages/reference-app-ns` is not
  one of them (that package landed in the `v0.9.0` release commit, after `knip.ts` was last
  touched), so all 13 of its real dependencies report as unused and most of its source reports
  as unused files; dependency-class issues are `error` in `knip.ts`, so the gate fails. Two
  smaller pre-existing hits ride along (root `svelte-eslint-parser`, `cadre-core`
  `@libp2p/peer-id-factory`) plus eight stale configuration hints. Filed to `fix/` rather than
  `backlog/` because a permanently-red gate is one nobody reads — it means no future work can
  use `dep-check` to prove it introduced no dependency issue, which is exactly the position
  this review was in. Confirmed independently that this diff adds no new knip issue: the new
  `@libp2p/websockets` devDependency in `cadre-core` is correctly seen as used, and version-only
  range edits cannot affect knip's analysis. Not a test failure, so outside the
  `.pre-existing-error.md` mechanism.
- **`backlog/debt-control-db-offline-peer-no-hang-coverage`** — the largest honest gap, and the
  handoff said so itself. The ticket's requirement for a group of *more than one* whose peers
  are offline ("fail fast or serve a clearly local read, but never hang") is asserted nowhere.
  That is the ordinary state of a multi-device setup and the remaining place the reported freeze
  could live. Folded the transport-coverage gap into it as a secondary bullet (the solo spec uses
  WebSockets only; the reference apps add circuit-relay and WebRTC, so a transport-triggered hang
  would slip past everything we have) — one harness can plausibly cover both, and two tickets
  would fragment it. Kept deliberately separate from the blocked
  `control-db-convergence-optimystic-p2p`, which is about data not replicating *between* nodes
  rather than one node's liveness when peers are absent.
- **`blocked/report-dependency-floor-bump-to-embedding-app`** — the ticket's last TODO (report
  back, naming the published version that carries the bumped floor) cannot be done from here and
  is not an agent's call. `@serfab/cadre-core` is 0.9.0 locally and on npm, so *no published
  version carries the fix* — it ships with the next release, which this work deliberately did not
  cut. Publishing is a human decision and there is no recorded contact channel for the reporter.
  Filed with the reply drafted, including the part that matters most: **we still cannot reproduce
  their freeze at either version**, so the reply must not promise a fix.

### Recorded as tripwires, not tickets

- The three unbounded-`await` sites in the reference apps already carry `NOTE:` comments from
  the implement pass (React Native `cadre-phone.ts` `startPhoneNode`, web `cadre-web.ts`
  `runOwnerGenesis`, web `diagnostics.svelte.ts` `collectCadre`). I reviewed and **agreed with
  not adding per-app deadlines**: nothing hangs today, and wrapping each call site is the same
  time-boxing workaround we are about to ask the reporter to remove. If a control operation can
  hang, the bound belongs in cadre-core so every embedder inherits it — a design question
  (which operations, what default, configurable?) outside this ticket. Verified the set is
  *complete*: `reference-app-ns` has no control-operation call sites at all, so there is no
  fourth site, which also confirms the STATUS.md claim that it needs no owner genesis.
- New `NOTE:` at the restart test in the solo spec: `MemoryRawStorage` proves the
  hydrate-before-apply path but not the backends embedders actually restart on (IndexedDB,
  React Native, filesystem). Conditional — if a hydrate bug ever proves backend-specific, add a
  `FileRawStorage` variant. Not filed, because there is no evidence the path differs by backend.

### Categories with nothing found

- **Resource cleanup** — nothing. Every node in the spec is stopped in a `finally`, and the
  timer in the deadline helper is cleared on both settle paths (verified by test, including
  that no late rejection surfaces after the budget elapses).
- **Type safety** — nothing. No `any`, no unchecked casts; the `db!` non-null assertions are
  each immediately preceded by an `expect(db).not.toBeNull()`.
- **Source hygiene** — nothing to act on. The spec is 230 lines, one concern per test, helpers
  are short and named for what they assert. Its comments explain *why* a shape matters rather
  than restating the code, which is the reason the truthiness-spread and `MemoryRawStorage`
  caveats had somewhere natural to live.
- **The version bump's completeness** — nothing. Verified every `@optimystic/*` range in every
  `packages/*/package.json` reads `^0.16.3` against linked 0.16.3, and that `cadre-host` and
  `cadre-provider` declare no `@optimystic/*` dependency at all (so "seven packages" is the
  right count, not an oversight). `@quereus/quereus ^4.4.0` against linked 4.4.1 is in range.
- **Pre-existing test failures** — none re-reported, and no `.pre-existing-error.md` written.
  My changes touch only `cadre-core` tests and documentation, and the full `cadre-core` suite is
  green. The `quereus-plugin-sereus` and `integration-tests` failures the implement pass recorded
  are all listed in `tickets/.pre-existing-known.md` against the blocked
  `control-db-convergence-optimystic-p2p`, with counts matching exactly.

### The finding worth carrying forward

**This work does not prove the reported freeze was caused by the old dependency floor.** The
freeze does not reproduce at either version, including in the new spec, which is a closer match
to the reporter's configuration than anything that existed before. What shipped is the version
we actually test, plus the coverage that made the question unanswerable. If the reporter still
freezes after upgrading, the next step is their stack trace, not another range bump — the
blocked ticket's draft reply says so explicitly.
