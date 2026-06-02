description: Review the authority self-registration wiring — CLI `cadre start --authority` now does `await node.registerSelf()` right after seed-bootstrap init (writing the authority's own signed CadrePeer row before any seed is minted), `registerSelf()` returns an insert/refresh/skipped outcome and is now single-flight-guarded against a concurrent INSERT, and the in-process tests/docs were inverted to expect the authority IN CadrePeer.
files: packages/cadre-cli/src/commands/start.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/types.ts, packages/cadre-core/test/seed-bootstrap.spec.ts, packages/cadre-host/src/auth/__tests__/trust-circle-integration.test.ts, packages/integration-tests/src/scenarios/cadre-host-trust-circle.integration.ts, docs/architecture.md, docs/cadre-host.md

## What shipped

The implement ticket's remaining wiring/test/doc work is done. `CadreNode.registerSelf()`
(public/awaitable/idempotent INSERT-or-UPDATE of the node's own signed `CadrePeer`
address record) already existed from `peer-record-resolution-layer`; this ticket
connected it to the real entry point and corrected the surrounding tests/docs.

### Production changes
- **`packages/cadre-cli/src/commands/start.ts`** — in the `--authority` branch, after
  `node.initializeSeedBootstrap(privateKeyB64)`, added `const selfReg = await
  node.registerSelf()` and a `console.log` keyed off the outcome
  (`inserted` / `refreshed` / `skipped`). This writes the authority's own
  `CadrePeer` row **before** any invite/seed can be minted, closing the window
  where `createSeed()` omitted the authority peer until the ~7.5 min heartbeat.
- **`packages/cadre-core/src/cadre-node.ts`** — two coupled changes:
  1. `registerSelf()` now returns `SelfRegistrationOutcome`
     (`'inserted' | 'refreshed' | 'skipped'`) instead of `void`; the body moved to a
     private `publishSelfRecord()`.
  2. **`registerSelf()` is now single-flight** (`registerSelfInFlight` promise).
     Concurrent callers join the in-flight publish instead of starting a second one.
     **This is a real correctness fix, not cosmetic:** the CLI's explicit
     `await node.registerSelf()` and the 1s `scheduleSelfRegistration` background
     timer both call `registerSelf`. Without the guard they could both observe
     "no row yet" and both attempt the authority-signed INSERT — the loser hits a
     `CadrePeer` PK conflict, which (for the awaited CLI call) would propagate out of
     `start()` and `process.exit(1)` the authority node. Sequential awaited calls
     still produce distinct outcomes (first `inserted`, then `refreshed`) because the
     in-flight slot is cleared in `finally`.
- **`packages/cadre-core/src/types.ts`** — new exported `SelfRegistrationOutcome` union.

### Test changes
- **`packages/cadre-core/test/seed-bootstrap.spec.ts`** — new `describe('registerSelf
  — authority self-registration into CadrePeer')`: boots an own-authority node
  (libp2p identity key == authority key via `authorityKeyFromLibp2p`), asserts the
  authority is **absent** from `createSeed().peers` before `registerSelf()` and
  **present** after (`isAuthority === true`, `publicKey === seed.signerKey`), and that
  a signer-trusting receiver's `applySeed` accepts the resulting seed. Also asserts
  the outcome enum (`inserted` then `refreshed`).
- **`packages/cadre-host/.../trust-circle-integration.test.ts`** and
  **`packages/integration-tests/.../cadre-host-trust-circle.integration.ts`** — the
  host `CadreNode` is now created own-authority (with a real `privateKey`) and calls
  `await registerSelf()` in `beforeEach`. Member-count assertions were inverted: the
  host's own peerId now appears in `CadrePeer` as an unlabeled member, so the trust-
  circle listing carries `host-self + redeemed-phone`, and after removing the phone
  the host-self row remains. (This inverts the old "does NOT appear" expectation noted
  in `tickets/complete/cadre-host-trust-circle-e2e-verification.md`.)
- **`docs/architecture.md` / `docs/cadre-host.md`** — note the authority self-registers
  at startup so seeds include the authority peer, and that the trust-circle listing
  includes the authority as an unlabeled member.

## Validation performed (all green)
- `tsc --noEmit`: cadre-cli, cadre-host, integration-tests → exit 0; cadre-core
  `yarn build` (same `tsconfig.build.json`) → exit 0.
- `yarn test`: cadre-cli **40 passed**, cadre-core **277 passed** (20 files),
  cadre-host **359 passed / 3 skipped** (46 files). The edited integration scenario
  `cadre-host-trust-circle.integration.ts` → **3 passed** (it is in-process here, no
  real cross-network).
- `eslint` on all changed files → **0 errors** (only pre-existing `no-explicit-any` /
  unused-import warnings, which the touched test file already emits pervasively).
- No pre-existing failures surfaced; no `tickets/.pre-existing-error.md` written.

## Reviewer: focus here / known gaps (treat tests as a floor)

1. **The ticket's described `applySeed` gate does not exist in current code.** The
   implement ticket framed the receiver check as a literal
   `seed.peers.some(p => p.isAuthority && p.publicKey === seed.signerKey)` "signer-is-
   authority gate" that throws `Signer key does not match any authority peer`. That
   inline gate is gone — `applySeed` now uses the pluggable trust-policy design
   (`dbAnchoredTrustPolicy` default; signature + signer-trust, not "signer present in
   seed.peers"). My new test therefore asserts the **still-true** contract (authority
   present in the seed + a signer-trusting receiver accepts it), and I called this
   discrepancy out in a code comment. **Verify** this is the right interpretation and
   that there is no other call site still expecting that string/gate.

2. **No subprocess-level CLI test.** The CLI wiring (`start.ts`) is covered by
   inspection plus the cadre-core-level `registerSelf` semantics test and the
   cadre-host node-level path; nothing spawns `cadre start --authority` and asserts
   the row + the printed `✓ Authority self-registered…` line end-to-end. If a
   process-level assertion is wanted, it belongs in cadre-cli or integration-tests.

3. **Single-flight reasoning is the load-bearing new logic — please adversarially
   check it.** Concerns worth probing: (a) does joining an in-flight publish ever
   return a *stale* result to a caller that needed a fresh `UpdatedAt` bump? (the
   heartbeat tolerates this — one refresh covers a coincident trigger — but confirm
   that's acceptable); (b) is the `finally`-clear correct under a thrown
   `publishSelfRecord` (a failed INSERT when the authority key isn't yet present —
   the background timer swallows it, but a joined caller would see the rejection).

4. **New test reaches into a private field.** The cadre-core test clears the 1s
   background timer via `(node as any).selfRegistrationTimer` so the insert/refresh
   outcome assertions are deterministic (otherwise the timer races the explicit
   call). It's a test-only cast consistent with the file's existing `(x as any)`
   injection style, but it couples the test to an internal name.

5. **Receiver in the new test is a mock libp2p, not a second real `CadreNode`.** It
   validates signature + trust-policy acceptance, not real dialing. Intentional for
   speed; flag if deeper coverage is wanted.

6. **Verified-unaffected, but double-check:** the pre-existing `seed-bootstrap.spec.ts`
   peer-count assertions (`authorizePeer`/`removePeer` round-trip, `applySeed`
   DB-anchored) still hold because those nodes are created **without** `privateKey`,
   so `getSelfSigningKey()` returns null and the background `registerSelf` timer
   skips (no self-row is written). Confirmed by the full-suite pass.
