description: Authority self-registration into CadrePeer — `cadre start --authority` now calls `await node.registerSelf()` after seed-bootstrap init so the authority's own signed `CadrePeer` row exists before any seed is minted; `registerSelf()` returns an insert/refresh/skipped outcome and is single-flight-guarded against a concurrent duplicate INSERT; tests/docs were inverted to expect the authority IN CadrePeer.
files: packages/cadre-cli/src/commands/start.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/types.ts, packages/cadre-core/test/seed-bootstrap.spec.ts, packages/cadre-host/src/auth/__tests__/trust-circle-integration.test.ts, packages/integration-tests/src/scenarios/cadre-host-trust-circle.integration.ts, docs/architecture.md, docs/cadre-host.md, packages/cadre-core/src/seed-trust-policy.ts, packages/cadre-core/src/seed-bootstrap.ts

## What shipped

The authority node now writes its own signed `CadrePeer` address record at startup
so every seed it mints carries the authority's dialable address as an `isAuthority`
peer. `CadreNode.registerSelf()` (pre-existing from `peer-record-resolution-layer`)
was connected to the real `cadre start --authority` entry point, given a return
outcome, and made single-flight-safe; surrounding tests/docs were corrected.

### Production changes
- **`packages/cadre-cli/src/commands/start.ts`** — `--authority` branch now does
  `const selfReg = await node.registerSelf()` after `initializeSeedBootstrap`, with an
  outcome-keyed `console.log` (`inserted`/`refreshed`/`skipped`).
- **`packages/cadre-core/src/cadre-node.ts`** — `registerSelf()` returns
  `SelfRegistrationOutcome` (body moved to private `publishSelfRecord()`), and is
  single-flight-guarded via `registerSelfInFlight` so the explicit CLI publish and the
  background timers (1s startup, TTL heartbeat, `self:peer:update` listener) collapse
  into one in-flight publish instead of racing a duplicate authority-signed INSERT.
- **`packages/cadre-core/src/types.ts`** — new `SelfRegistrationOutcome` union.

### Test / doc changes
- `seed-bootstrap.spec.ts` — new `describe` asserting the authority is absent from
  `createSeed().peers` before `registerSelf()` and present after (`isAuthority`,
  `publicKey === signerKey`), a signer-trusting receiver `applySeed` accepts it, and
  the outcome enum (`inserted` then `refreshed`). **Review added** a concurrency
  regression test for the single-flight guard.
- Host node-level test + integration scenario — host created own-authority, calls
  `registerSelf()` in `beforeEach`; member-count assertions inverted (host-self now a
  member). Docs (`architecture.md`, `cadre-host.md`) note the self-registration.

## Review findings

### Checked
- **Implement diff read first** (commit `9fad756`) before the handoff summary.
- **Stated motivation verified against real code** — read `applySeed`
  (`seed-bootstrap.ts:391`), `createSeed` (`:334`), and all of `seed-trust-policy.ts`.
- **Single-flight logic adversarially traced** — interleavings of the CLI call, the 1s
  timer, the heartbeat, and the address-change listener; the `finally`-clear under a
  thrown `publishSelfRecord`; the CLI throw-and-exit path.
- **Full suites + lint run** on every touched package.
- **Cross-repo grep** for stale references to the corrected mechanism.

### Found & fixed inline (minor)
- **Factual error in the stated motivation (doc + code comment).** The implement
  ticket, the `start.ts` comment, and `docs/architecture.md` all justified
  self-registration as preventing a *"receiving node's signer-is-authority gate"* from
  *rejecting* the seed. **That gate does not exist.** `applySeed` makes its trust
  decision purely on `signerKey ∈ knownAuthorityKeys` (DB-anchored / pinned / TOFU via
  `SeedTrustPolicy`) — it never checks that the signer appears among `seed.peers`. The
  *real* benefit is that the seed otherwise omits the authority's **dialable address**,
  leaving a freshly-seeded node with no authority multiaddr to dial (the `applySeed`
  `isAuthority` dial loop). Corrected the comment in `start.ts` and the paragraph in
  `docs/architecture.md` to describe the dial-target mechanism and explicitly state
  trust does not depend on the peer being present. (The new cadre-core test already
  asserted the still-true contract and called the discrepancy out; that comment was
  accurate and left as-is. `docs/cadre-host.md` made no gate claim — left as-is.)
- **Single-flight guard — the load-bearing new logic — had zero direct coverage.** The
  implementer's test deliberately clears the 1s timer to keep insert/refresh outcomes
  deterministic, so the concurrency guard itself was never exercised. Added
  `collapses concurrent registerSelf calls into a single INSERT (no PK-conflict race)`:
  fires two `registerSelf()` calls via `Promise.all`, asserts both resolve `'inserted'`
  (the second joins the first's in-flight publish) and exactly one `CadrePeer` self-row
  results. Without the guard this rejects on a PK conflict — a precise regression guard.

### Found, accepted (not fixed — rationale given)
- **Address-change coalescing tradeoff** (handoff 3a). The `self:peer:update` listener
  joins an in-flight publish that may have already snapshotted the *old* addrs via
  `collectSelfAddrs`, so a coincident relay/NAT address change waits for the next TTL
  heartbeat to publish. Low-probability (publish completes in ms; the collision window
  is tiny), self-healing (the heartbeat republishes with current addrs, and the stale
  record is still valid/resolvable in the interim), and clearly outweighed by the guard
  it enables. A trailing-edge re-run would be gold-plating for a rare event; not added.
- **No subprocess-level CLI test** (handoff 2). The 3-line `start.ts` wiring is covered
  by inspection plus the node-level `registerSelf` semantics and the host node path;
  nothing spawns `cadre start --authority` end-to-end. Minor coverage gap, not worth a
  major ticket — process-level assertions belong in cadre-cli/integration-tests if
  ever wanted.
- **Test reaches a private field** (`(node as any).selfRegistrationTimer`, handoff 4).
  Consistent with the file's pervasive `(x as any)` injection style; couples the test
  to an internal name but keeps the outcome assertions deterministic. Acceptable.

### Verified clean (explicitly — not silently)
- **Single-flight correctness.** Sound. `registerSelf`'s prologue (check + set
  `registerSelfInFlight`) has no `await` between read and write, so re-entry can't slip
  through; `publishSelfRecord` is `async` so it always returns a promise and `finally`
  always clears the slot. The CLI's awaited call can only `process.exit(1)` on a thrown
  INSERT, but in the `--authority` path the authority key is inserted (and seed-bootstrap
  set) before `registerSelf`, so `insertSelfPeerRecord` has no throw window there; the
  timer-side path that *can* see "no seed-bootstrap yet" returns `'skipped'` without
  throwing.
- **Pre-existing `seed-bootstrap.spec.ts` peer-count assertions** unaffected — those
  nodes are created without `privateKey`, so `getSelfSigningKey()` returns null and no
  self-row is written. Confirmed by the full pass.
- **No stale references** to the corrected "signer-is-authority gate" remain in code or
  docs (grep clean apart from this archived ticket).
- **Major findings: none.** No new fix/plan/backlog tickets filed.

## Validation performed (all green)
- `yarn workspace @serfab/cadre-core test` → **278 passed** (20 files; +1 review test).
- `yarn workspace @serfab/cadre-host test` → **359 passed / 3 skipped** (46 files).
- `yarn workspace @serfab/cadre-cli test` → **40 passed** (4 files).
- `eslint` on all changed files → **0 errors** (only pre-existing `no-explicit-any` /
  unused-import warnings; the review's added `(node as any)` casts match the file's
  existing pattern).
- No `tickets/.pre-existing-error.md` written — no unrelated failures surfaced.
