description: Turned on the live two-party browser end-to-end test that proves an invitation forms a shared chat and a message crosses between the two parties, retired the obsolete tests it replaces, and fixed a libp2p setting that was blocking the browser from connecting to a local peer.
prereq:
files: packages/reference-app-web/e2e/distributed/formation-convergence.spec.ts, packages/reference-app-web/e2e/global-setup.ts, packages/reference-app-web/e2e/global-teardown.ts, packages/reference-app-web/e2e/fixtures/state.ts, packages/reference-app-web/e2e/fixtures/formation-responder.ts, packages/reference-app-web/src/lib/cadre-web.ts, packages/reference-app-web/README.md, packages/cadre-core/src/types.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/strand-instance-manager.ts
----

# Review: wire the responder + convergence spec + retire the legacy suite

The live formation→convergence e2e tier is now on and **green** (full suite: 27 passed,
41.5s). This handoff is honest about two deliberate divergences from the original ticket
— one forced by Playwright's process model, one a necessary scope expansion into
cadre-core. Both are tested; both deserve reviewer scrutiny.

## What shipped

- **`e2e/distributed/formation-convergence.spec.ts`** (new) — the two-party tier. Two tests:
  - *happy path* — redeem a valid invitation through the Home UI → assert a **closed**
    strand forms (`type:'c'` + member key, `strandId === responder.strandId`) → wire the
    cohort link by hand (`__cadre.dialStrandPeer`) → poll connection ≥ 1 → responder
    `seedMessage()` → poll the browser until that message replicates in (cross-cohort
    convergence) → assert the responder recorded a `FormationUsage` row bound to the strand
    → bidirectional tail (browser write → responder reads).
  - *expired token* — redeem a deliberately-expired invitation → assert `formation-join-error`
    is shown, no formed strand, no new `FormationUsage` row.
- **`global-setup.ts`** — removed the `TIER2_CONVERGENCE_DEFERRED` short-circuit and the whole
  spawned-bootstrap-mesh path (`spawnReferenceMesh`/`detectOptimysticCli`/`ENV_OVERRIDE`).
  Now writes the availability gate (`available:true`, or `available:false` when
  `FORMATION_E2E_DISABLED` is set).
- **`global-teardown.ts`** — reduced to `clearFixtureState()`.
- **`fixtures/state.ts`** — `FixtureStateAvailable` reduced to `{ available: true }` (gate only).
- **Deleted** the obsolete suite: `distributed/{two-tab-convergence,cross-tab-activity,
  disconnect-mid-session,mode-flip,bootstrap-persistence,connection-path,webrtc-upgrade}.spec.ts`,
  `distributed/_helpers.ts`, `fixtures/reference-peer.ts`, `fixtures/optimystic-detect.ts`.
  Grepped first: no solo spec imported any of them (solo specs define their own
  `gotoMessages`/`sendOne`), so nothing dangling. `_helpers.ts` had no still-needed exports
  to rehome.
- **`README.md`** + **`fixtures/formation-responder.ts`** doc comments — rewrote the Tier-2
  description, dropped the deferral language, corrected the responder's now-stale "boots in
  global-setup / `globalThis.__referencePeer`" comments.

## DIVERGENCE 1 — responder boots in the worker, NOT global-setup (forced; review the rationale)

The ticket prescribed: boot the responder in `global-setup`, stash it on
`globalThis.__formationResponder`, and read it from "the spec's Node context". **This cannot
work.** Playwright runs `global-setup`/`global-teardown` in the main runner process and spec
files in separate worker **child processes** that do not share `globalThis`/memory (the prior
agent's probe proved it: distinct PIDs, `globalThis.__probe === null` in the worker). The
responder's assertion methods (`readFormationUsage`, `readStrandMessages`, `seedMessage`) read
**in-memory** node state, so they are only reachable in the process that booted the node.

Resolution: the responder boots in the spec's `beforeAll` (the worker), tears down in
`afterAll`. The fail-soft moved there too (a boot failure → `test.skip`, not a run error).
`global-setup` keeps only the coarse availability gate. This faithfully implements the
ticket's **intent** via the only mechanism that works; `state.ts` no longer needs to carry
`encoded`/`strandId`/`strandMultiaddrs`/`seededMessage` (the spec reads them off the live
handle). Rationale is documented in `state.ts` and the spec header.

## DIVERGENCE 2 — connection-gater fix in cadre-core + cadre-web (scope expansion; SCRUTINIZE)

The happy path was initially **blocked**: the browser's join surfaced *"The connection gater
denied all addresses in the dial request."* libp2p's browser-default connection gater denies
dialing private/loopback addresses, so the browser could not dial the responder's
`/ip4/127.0.0.1/tcp/<port>/ws` control (formation) or strand (cohort) address. `cadre-core`
did not thread a `connectionGater` through its `NetworkConfig`, even though `@optimystic/db-p2p`
fully supports the option and its `libp2p-node-base.ts:201` comment explicitly anticipates "web
reference dev, Playwright e2e, RN simulators supply a permissive gater here."

Fix (canonical libp2p pattern, per `@libp2p/webrtc` docs):
- `cadre-core/src/types.ts` — added `connectionGater?: ConnectionGater` to `NetworkConfig`.
- `cadre-core/src/cadre-node.ts` + `strand-instance-manager.ts` — threaded it to **both** the
  control node and every strand cohort node's `createLibp2pNode` options.
- `reference-app-web/src/lib/cadre-web.ts` — supplied `{ denyDialMultiaddr: () => false }` in
  the browser's network config (covers both control + strand nodes).
- Rebuilt `cadre-core` (the web app consumes its `dist/`).

**Reviewer, please weigh:** this is a production change. The new cadre-core config field is
benign (opt-in passthrough). The browser change makes the reference app dial private/loopback
addresses **unconditionally**. I chose unconditional because the reference app is a
dev/validation surface (README frames it as such), and it is strictly additive to normal
relay/WebRTC operation. If you want it gated (dev-only / behind a flag), that is a reasonable
alternative — flag it.

**Side effect worth noting:** before this fix, the *expired-token* test passed for the WRONG
reason — it hit the gater denial before ever reaching the responder's expiry check. After the
fix the dial succeeds and the test genuinely exercises the expiry branch. So the gater fix also
made the negative test meaningful (verify this when reviewing the negative test).

## Validation (all green)

- `tsc -p tsconfig.e2e.json --noEmit` (e2e typecheck) — **note:** `tsconfig.e2e.json` is NOT
  wired into any script; `yarn build` only typechecks `src/` (tsconfig.json). I ran the e2e
  typecheck manually. Consider wiring it into build/CI so e2e type regressions are caught.
- `tsc --noEmit` (src typecheck) ✓
- `yarn lint` (root, after every change) ✓
- `yarn workspace @serfab/cadre-core build` ✓
- `yarn workspace @serfab/reference-app-web build` ✓
- `yarn workspace @serfab/reference-app-web test:e2e` → **27 passed (41.5s)**: 2 convergence +
  25 solo. Happy path completes in ~3s — the ticket's feared "exceeds the agent window" did not
  materialize (convergence over loopback is fast).

## Key tests / expected outcomes (for the reviewer to re-run or extend)

- `formation-convergence.spec.ts › happy path` → formed `type:'c'` strand whose id equals the
  responder's host strand; browser reads the responder's seeded message through the cohort;
  responder has a `FormationUsage` row for `strandId`; browser→responder reverse write also
  converges.
- `› expired token` → `formation-join-error` shown, no formed strand, no new `FormationUsage`.
- Solo tier (`boot`, `formation-rbac`, `messages-roundtrip`, `schema-signature-gate`, …) → still
  green (no regression from the gater / state / global-setup changes).

## Known gaps / things to scrutinize

- **Bidirectional is inline in the happy path, not isolated.** It is the most likely flaky
  point. It passed reliably here over loopback, but it CANNOT be a separate test (the valid
  invite is single-use), so it rides the happy path's connection. If it flakes under CI/load,
  downgrade it to `test.fixme` (noted inline in the spec). Consider whether the responder should
  expose a *second* valid invitation so bidirectional can be its own test.
- **Closed-strand membership is asserted at metadata level only** (`type:'c'` + member key
  present). The deeper "a read is unauthorized WITHOUT the minted member key" assertion depends
  on the schema's "member key only if closed" CHECK — still a TODO (`control-schema.ts:56`,
  backlog ticket `control-strand-closed-member-key-constraint`). Noted inline; not blocked on it.
- **Permissive gater scope** (Divergence 2) — unconditional in the browser; decide if that is
  acceptable for production.
- **Connection step uses a manual `dialStrandPeer`** because control-network strand discovery is
  still TODO. When that lands, step 3 should become automatic and this hand-wiring can drop.
- **No relay on the browser** — confirmed correct: the initiator only dials out. If a future
  regression makes formation require a browser reservation, that is a real bug, not something to
  paper over with a relay.
