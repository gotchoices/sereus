description: An app embedding our library reported that a brand-new node with no peers froze forever when reading or writing its own settings database. The freeze never happened in our own repo because we test against a newer copy of the underlying database engine than the one apps install; we now declare the version we actually test, and added a test that fails with a clear message instead of hanging.
prereq:
files: packages/cadre-core/test/control-database-solo.spec.ts, packages/cadre-core/test/control-database-genesis.spec.ts, packages/cadre-core/package.json, packages/cadre-cli/package.json, packages/quereus-plugin-sereus/package.json, packages/integration-tests/package.json, packages/reference-app-rn/package.json, packages/reference-app-web/package.json, packages/reference-app-ns/package.json, packages/reference-app-rn/src/cadre-phone.ts, packages/reference-app-web/src/lib/cadre-web.ts, packages/reference-app-web/src/lib/diagnostics.svelte.ts, docs/STATUS.md
difficulty: medium
----

# Review: solo control DB — ship the substrate version we test, and cover the solo shape

## What landed

**1. Declared dependency ranges now match the linked workspace.** Every `@optimystic/*`
range moved `^0.14.1` → `^0.16.3` across the seven consuming packages
(`cadre-core`, `cadre-cli`, `quereus-plugin-sereus`, `integration-tests`,
`reference-app-{rn,web,ns}`). Root `resolutions` unchanged (still `link:../optimystic/...`).
The ticket said 0.16.2; the linked workspace is actually at **0.16.3**, which is also the
newest npm release, so the floor went to 0.16.3.

Only one resolved version actually changed: `@optimystic/db-p2p-storage-fs` has **no**
`resolutions` entry, so it always came from the registry — it was genuinely running 0.14.1
while every sibling package ran linked 0.16.3. It now resolves 0.16.3.
**No API drift surfaced** (build, typecheck, lint, and all package suites are as green as
they were before — see Validation).

**2. New permanent regression spec: `packages/cadre-core/test/control-database-solo.spec.ts`.**
Three tests, all passing (13.7s):
- `transaction profile` — genesis → read-back → solo write → read-back
- `storage profile` — same
- restart-and-read

Config is the mobile/browser shape the reporter runs: `transports: [webSockets()]`,
`listenAddrs: []`, `bootstrapNodes: []`. Every control operation is wrapped in a `within()`
helper that imposes a per-operation deadline and **fails the test naming the operation**
(15s for control ops, 30s for `start`/`stop`) — a hang shows up as
`solo control operation did not complete within 15000ms: ensureOwnerKey() (genesis)`,
not as a bare vitest timeout with nothing to read.

**3. `control-database-genesis.spec.ts` annotated** as the *listening* solo shape (default
TCP `listenAddrs`, default transports) and the solo spec as the *non-listening* one, so the
two read as a matched pair. No behavioral change to that spec.

**4. Reference-app solo boot checked; no guards added, three `NOTE:` tripwires instead.**
See "Tripwires parked" below.

**5. `docs/STATUS.md`** gained two subsections under `## Testing / CI`:
`### Declared dependency range vs linked workspace` (states the lockstep rule and why the
gap is invisible here) and `### Solo (cadre-of-one) control DB — supported and covered`.

## What to test / validate as a reviewer

**The regression spec is the deliverable — attack it.** It is a floor, not a ceiling:

```
cd packages/cadre-core && yarn vitest run test/control-database-solo.spec.ts
```

Specific things worth probing:

- **Does the deadline guard actually fire?** I verified the tests pass but never forced a
  hang to watch `within()` fail. Worth injecting an artificial stall (e.g. patch
  `ControlDatabase.ensureOwnerKey` to `await new Promise(() => {})`) and confirming the
  failure message names the operation. If `within()` is broken, the spec silently
  degrades to "vitest timeout" — exactly what it exists to prevent.
- **Is `MemoryRawStorage` a fair stand-in for the restart case?** The restart test shares one
  `MemoryRawStorage` instance and one `InMemoryKeyStore` across two `CadreNode` instances.
  That does exercise `ControlDatabase.initialize`'s hydrate-before-apply path (the second
  node's `hasOwnerKey()` is `true` and `registerSelf()` returns `'refreshed'`, so the rows
  really did survive). But a real embedder restarts on IndexedDB / RN / filesystem storage.
  A reviewer with an appetite could add a `FileRawStorage` variant.
- **Coverage the spec does NOT have** (deliberate, flag if you disagree):
  - No `circuitRelayTransport()` / `webRTC()` in the transport list. Web and NS both add
    those; RN adds circuit-relay + WebRTC. The differentiator in the report was the *absence
    of a listen address*, which is covered — but a transport-specific hang would be missed.
  - No strand path, only the control DB.
  - No genuine-partition case (multi-node cadre, peers offline). The ticket's narrower
    requirement for that shape — "fail fast or serve a clearly local read, but never hang" —
    is **not** asserted anywhere. This is the biggest honest gap in the handoff.
- **Idempotence of the whole spec under repeat runs.** Party ids are randomized per test, so
  runs should not interfere; worth a `--repeat 3` to be sure.

**The version bump.** `yarn install && yarn build && yarn lint && yarn typecheck` from the
root. Then confirm no package still declares an `@optimystic/*` range below the linked
workspace version:

```
grep -rn "@optimystic/" packages/*/package.json
node -e "console.log(require('../optimystic/package.json').version)"
```

**Reference apps solo.** `packages/reference-app-web`: `yarn playwright test e2e/solo/` —
`boot.spec.ts` reaches `running` and `diagnostics.spec.ts` asserts `diag-owner` is
`genesis|existing`, which is the app-level proof that solo owner genesis completes. I ran
`boot.spec.ts` + `diagnostics.spec.ts` (4 passed, 38.4s). The other six solo specs were not
run in this ticket.

## Findings from the investigation (for the reviewer's judgement)

**The reported hang still does not reproduce here, at either floor.** The ticket already
recorded that it does not reproduce at HEAD; it also does not reproduce in the new solo spec,
which is a closer match to the reporter's config than anything that existed before (no listen
address). So this ticket does **not** prove the reporter's hang was caused by the 0.14.1
floor — it closes the *coverage gap* that made the question unanswerable, and ships the
version we test. If the reporter still hangs after upgrading, the next step is their stack,
not another range bump. Say so plainly if you touch the report-back.

**The reporter's secondary claim about the reference apps is factually right but not
currently harmful.** All three call sites `await` a control operation with no deadline, and
their `try`/`catch` catches rejections, not a call that never settles:
- `reference-app-rn/src/cadre-phone.ts` — `startPhoneNode` awaits `runOwnerGenesis(node)`
- `reference-app-web/src/lib/cadre-web.ts` — `runOwnerGenesis`
- `reference-app-web/src/lib/diagnostics.svelte.ts` — `collectCadre`'s `queryCadrePeers`

I did **not** add per-app deadlines. Rationale: nothing hangs today (web boots solo in e2e;
RN's exact network shape is now covered by the cadre-core spec), and wrapping each call site
is the same time-boxing workaround we are about to ask the reporter to *remove*. If a control
operation can hang, the bound belongs in cadre-core so every embedder gets it — which is a
design question (which operations, what default, configurable?) well outside this ticket.
Parked as tripwires; escalate to a real ticket if you disagree.

## Tripwires parked (per tess rules — knowledge, not queued tickets)

- `packages/reference-app-rn/src/cadre-phone.ts` (`startPhoneNode`, at the
  `await runOwnerGenesis(node)` line) — `NOTE:` the await is unbounded; fail-soft catches
  errors, not a never-settling call. Points at the solo spec and says to bound it in
  cadre-core, not per-app, if it ever resurfaces.
- `packages/reference-app-web/src/lib/cadre-web.ts` (`runOwnerGenesis` doc comment) — same
  `NOTE:`, plus that `ownerState` would stay stuck at its initial value on a hang.
- `packages/reference-app-web/src/lib/diagnostics.svelte.ts` (`collectCadre` doc comment) —
  `NOTE:` a hung `queryCadrePeers` stalls the whole diagnostics tick, not just the peer count.

## Validation actually run

| command | result |
|---|---|
| `yarn install` | clean; only `@optimystic/db-p2p-storage-fs` 0.14.1 → 0.16.3 |
| `yarn build` (root) | pass, 41s |
| `yarn lint` (root) | pass, 0 errors / 0 warnings |
| `yarn typecheck` (root) | pass, 17s |
| `yarn check:svelte` (root) | pass, 0 errors / 0 warnings |
| `cadre-core` `yarn test` | **53 files / 725 passed, 1 skipped** |
| `cadre-cli` `yarn test` | 8 files / 94 passed |
| `cadre-host` `yarn test` | 54 files / 448 passed, 3 skipped |
| `cadre-provider` `yarn test` | 15 files / 97 passed |
| `strand-proto` `yarn test` | 3 files / 25 passed |
| `reference-app-rn` `yarn test` | 8 files / 133 passed |
| `quereus-plugin-sereus` `yarn test` | 6 files passed, **1 file / 4 tests failed — pre-existing** |
| `integration-tests` `yarn test` | 17 passed files / 90 passed tests, **9 files / 17 tests failed — all pre-existing** |
| `reference-app-web` `yarn playwright test e2e/solo/boot.spec.ts e2e/solo/diagnostics.spec.ts` | 4 passed, 38.4s |

### Pre-existing failures — already tracked, not re-reported

Every failure above is listed in `tickets/.pre-existing-known.md` against
`control-db-convergence-optimystic-p2p` (blocked): the `quereus-plugin-sereus`
`test/e2e/networked.e2e.spec.ts > connectToStrand (networked e2e)` entry (4 test cases), and
all 17 integration-test failures. The counts match the known list exactly — **no new failures
were introduced by the bump.** No `.pre-existing-error.md` was written.

### One pre-existing gate failure worth someone's attention (not a test)

`yarn dep-check` (knip) **exits 1**, and did before this ticket: `knip.ts` has no
`packages/reference-app-ns` workspace entry (that package landed in the `v0.9.0` release
commit; `knip.ts` was last touched by `build-health-dep-check`, before it), so all 13 of
ns's real dependencies are reported "unused", plus pre-existing root `svelte-eslint-parser`
and `cadre-core`'s `@libp2p/peer-id-factory`. `docs/STATUS.md` still claims dep-check "exits 0
on a clean checkout", which is now false. My diff adds **no** new knip issue — the new
`@libp2p/websockets` devDependency in `cadre-core` is correctly seen as used, and version-only
edits cannot affect knip's analysis. Not a test, so it is outside the `.pre-existing-error.md`
mechanism; file it if you think it deserves a ticket.

## Not done — the report-back to the reporting app

The ticket's last TODO ("report back … state which published `@serfab/cadre-core` version
carries the bumped floor") **cannot be completed as written, and I have no channel to the
reporting app.** `@serfab/cadre-core` is at 0.9.0 both locally and on npm, so *no published
version carries the bumped floor* — it ships with the next release (`yarn release` → 0.9.1+),
which this ticket deliberately did not cut. Draft for whoever sends it:

> The `^0.14.1` `@optimystic/*` floor in `@serfab/cadre-core` 0.9.0 was two minor versions
> behind the substrate we develop and test against. Every consuming package now declares
> `^0.16.3`, which matches both our test environment and the newest release. **This ships in
> the next `@serfab/cadre-core` release (0.9.1 or later) — 0.9.0 on npm still carries the old
> floor**, so please pin to the new release rather than re-installing 0.9.0.
>
> Please then drop the 20s time-boxes around `ensureOwnerKey` and the control reads and
> confirm whether a cadre-of-one still hangs. We have added permanent coverage for your exact
> configuration — WebSockets-only transport, no listen address, empty bootstrap list, both
> node profiles, plus a restart — and it completes in milliseconds here at the new floor. If
> you still hang after upgrading, please send a stack or a `DEBUG=cadre*,optimystic*` log
> from the hung call: we do not yet have a reproduction, so the floor bump may not be the
> whole story.
