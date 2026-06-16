description: Turn on the two-party convergence test tier for the browser reference — wire in the test second-party, write the test that proves an invitation forms a shared chat and a message crosses between the two parties, and remove the old obsolete tests it replaces.
prereq: formation-convergence-e2e-app-hooks, formation-convergence-e2e-responder-fixture
files: packages/reference-app-web/e2e/global-setup.ts, packages/reference-app-web/e2e/global-teardown.ts, packages/reference-app-web/e2e/fixtures/state.ts, packages/reference-app-web/e2e/distributed, packages/reference-app-web/e2e/fixtures/reference-peer.ts, packages/reference-app-web/e2e/fixtures/optimystic-detect.ts, packages/reference-app-web/README.md
difficulty: hard
----

# Wire the responder + write the convergence spec + retire the legacy suite

The capstone of the live formation→convergence tier. With the app hooks
(`formation-convergence-e2e-app-hooks`) and the in-process responder
(`formation-convergence-e2e-responder-fixture`) landed, this ticket flips the
deferral, wires the responder into `global-setup`, writes the convergence spec,
and removes the now-obsolete `e2e/distributed/*` suite (which asserts the dead
membership-free Optimystic model and is hard-coupled to the bootstrap-mesh
fixture this tier replaces).

## global-setup / state / teardown

- In `global-setup.ts`: delete the `TIER2_CONVERGENCE_DEFERRED` short-circuit and
  the whole spawned-bootstrap-mesh path (`spawnReferenceMesh` / `detectOptimysticCli`
  / `ENV_OVERRIDE`). Replace with: `const responder = await startFormationResponder()`,
  stash it on `globalThis.__formationResponder`, and `writeFixtureState(...)` with the
  new formation shape below. Keep the existing fail-soft behaviour: if
  `startFormationResponder` throws, write `{ available: false, reason }` so the spec
  skips cleanly rather than erroring the whole run.
- In `state.ts`: replace the bootstrap-mesh `FixtureStateAvailable` with a formation
  shape:

  ```ts
  export interface FixtureStateAvailable {
    available: true;
    encoded: string;
    expiredEncoded: string;
    strandId: string;
    strandMultiaddrs: string[];
    seededMessage: { id: string; content: string };
  }
  ```
  (Drop `multiaddr` / `serviceMultiaddrs` / `source` / `pid`.) The responder's
  control DB lives in the Node process, so anything the spec must assert about the
  responder side — the `FormationUsage` row, a browser→responder write — is read
  through `globalThis.__formationResponder` from within `global-setup`/the spec's
  Node context, or surfaced via the handle; do not try to reach the responder's DB
  from the browser.
- In `global-teardown.ts`: `await globalThis.__formationResponder?.stop()` (replace
  the `__referencePeer` teardown).

## The convergence spec

New `e2e/distributed/formation-convergence.spec.ts` (reusing the `distributed/`
dir after the old specs are removed, or a fresh `e2e/formation/` dir — implementer's
call). `beforeAll` reads fixture state and skips if unavailable. The browser runs
with **no relay** (it is the initiator). Drive formation through the UI where it
exists, and use `__cadre` hooks for the formed-strand assertions the UI does not
surface.

**Happy path (responder → browser convergence):**
1. `goto('/')`, wait `home-status` = `running`.
2. Fill `invitation-in` with `state.encoded`, click `btn-join`; wait for the formed
   strand to appear via `__cadre.getFormedStrands()` (capture its `strandId`).
   Assert the formed entry is `type:'c'` and carries a `memberKey`.
3. Wire the strand cohort link: `__cadre.dialStrandPeer(strandId, state.strandMultiaddrs[0])`;
   poll `__cadre.getStrandConnectionCount(strandId)` ≥ 1.
4. Poll `__cadre.readChatMessages(strandId)` until it contains `state.seededMessage`
   (the responder seeds it on connect). This is the cross-cohort convergence
   assertion: a message written by the responder replicated to the browser through
   the strand cohort.
5. Assert the responder recorded consent: read `globalThis.__formationResponder
   .readFormationUsage()` and assert ≥ 1 row bound to `strandId`.

**Bidirectional (best-effort, mark `test.fixme`/skip if flaky in the window):**
`__cadre.writeChatMessage(strandId, {...})` on the browser, then poll
`__formationResponder.readStrandMessages()` until it contains it.

**Invalid/expired token:** fill `invitation-in` with `state.expiredEncoded`, click
`btn-join`, assert `formation-join-error` is visible and that
`__cadre.getFormedStrands()` gained no entry — and (via the handle) that no new
`FormationUsage` row was recorded. (The malformed-paste decode case is already
covered by the solo `formation-rbac` spec; this exercises the live expiry branch.)

**Closed-strand membership (light / documented):** assert the browser's formed
strand is `type:'c'` with a member key present (from `getFormedStrands()` and/or the
diagnostics control-strand surface). The deeper "read is unauthorized without the
minted member key" assertion depends on the schema's "member key only if closed"
CHECK, which is still a TODO (`control-schema.ts:56`, parked in the backlog ticket
`control-strand-closed-member-key-constraint`). Do **not** block this tier on it;
assert at the membership-metadata level and note the deferral inline.

## Retire the legacy distributed suite

Delete (they assert membership-free Optimystic convergence over a shared bootstrap
mesh — obsolete now that chat lives in a strand cohort, and all are hard-coupled to
the removed fixture shape via `requireFixture`/`collectBootstrapMultiaddrs`):
`e2e/distributed/{two-tab-convergence,cross-tab-activity,disconnect-mid-session,mode-flip,bootstrap-persistence,connection-path,webrtc-upgrade}.spec.ts`,
`e2e/distributed/_helpers.ts`, `e2e/fixtures/reference-peer.ts`,
`e2e/fixtures/optimystic-detect.ts`.

**Before deleting helpers, grep for remaining references.** If `_helpers.ts`
exports (`gotoMessages`, `sendOne`, `maybeEnableBrowserDebug`, …) are still used by
a *solo* spec or wanted by the new convergence spec, lift the still-needed ones into
the new spec / a trimmed helper rather than deleting them. The deletion must leave
`yarn workspace @serfab/reference-app-web build` (which typechecks `e2e/`) green —
no dangling imports.

Update `packages/reference-app-web/README.md` (and any e2e tier description) to
describe the new formation→convergence tier and drop the bootstrap-mesh / deferral
language.

## Edge cases & interactions

- **Flipping the flag runs the legacy specs.** Until they are deleted, making the fixture `available:true` un-skips them and they fail (their fixture shape is gone). The deletion and the flip must land together in this ticket for a green run.
- **No relay on the browser.** The initiator needs none; do not configure `VITE_RELAY_ADDR`. If a regression makes formation require a browser reservation, that is a real bug to surface, not to paper over with a relay.
- **Connect-before-converge ordering.** Step 3 (dial + connection) must complete before step 4's seeded message can land (super-majority of 2). Poll the connection count, not a fixed sleep.
- **Two responder addrs.** The invitation (`encoded`) carries the responder *control* addr for formation; `strandMultiaddrs` is the *strand* addr for the cohort dial. Use the right one in each step.
- **Timeouts.** Formation + cohort connect + a quorum commit over loopback WS can take several seconds; use generous `expect.poll` timeouts (the legacy specs used 60s for distributed steps) but keep the spec under the Playwright 60s per-test budget, or raise it locally for this spec.
- **Teardown leak.** A responder left running between specs holds the WS port and can clash on re-run; ensure `global-teardown` stops it and `stop()` fully releases.
- **Single worker.** `playwright.config.ts` is `workers:1`, so one shared responder is fine; do not assume parallel isolation.

## Key tests (expected outcomes)

- `formation-convergence.spec.ts` › happy path → formed `type:'c'` strand, browser reads the responder's seeded message, responder has a `FormationUsage` row for `strandId`.
- › invalid/expired token → `formation-join-error` shown, no formed strand, no new `FormationUsage`.
- Solo tier (`formation-rbac`, `messages-roundtrip`, `boot`, …) → still green (no regression from the fixture/state changes).

## TODO

- [ ] Rewrite `global-setup.ts`: remove deferral + bootstrap-mesh path; start the responder; write the formation fixture state; keep fail-soft skip.
- [ ] Reshape `state.ts` `FixtureStateAvailable` to the formation shape; update readers/writers.
- [ ] Update `global-teardown.ts` to stop `__formationResponder`.
- [ ] Write `formation-convergence.spec.ts` (happy path + invalid/expired + light closed-membership; bidirectional best-effort).
- [ ] Delete the obsolete distributed specs + dead fixtures; grep first and rehome any still-referenced helper. Leave `build` green.
- [ ] Update `README.md` / e2e tier docs.
- [ ] Run `yarn workspace @serfab/reference-app-web build` + `yarn lint` (green), then the e2e suite streaming output (`... 2>&1 | tee /tmp/e2e.log`). The browser↔node convergence path may exceed the agent idle/wall window; if so, validate the solo tier + typecheck + lint in-band, run the convergence spec as far as the window allows, and document precisely what was and wasn't observed green for the reviewer.
