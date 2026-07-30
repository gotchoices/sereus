----
description: When a node knows about other members that are switched off or unreachable, reading or writing its own settings answers from local data and never freezes. Test coverage now proves this, including the app-relaunch case where the offline members are already on record at startup.
prereq:
files: packages/cadre-core/test/control-database-offline-peers.spec.ts, packages/cadre-core/test/control-database-solo.spec.ts, packages/cadre-core/test/control-db-node-helpers.ts, docs/STATUS.md
difficulty: medium
----

# Complete: control-DB reads/writes with known-but-offline peers must not hang

Pure test coverage — no production code changed in either the implement or the review pass.

## What exists now

- **`packages/cadre-core/test/control-db-node-helpers.ts`** — shared harness for the two
  control-DB liveness suites: `withinOp` (labelled per-operation deadline built on cadre-core's
  own `withTimeout`, failing as `<scope> control op <label> timed out after <ms>ms`),
  `expectNotListening`, `readColumn`, `freshPartyId`, and `controlNodeConfig` (the mobile/browser
  posture: WebSockets-only, `listenAddrs: []`, empty bootstrap list; transports and listen
  addresses injectable). Not a `*.spec.ts`, so vitest never collects it as a suite.
- **`control-database-solo.spec.ts`** — the cadre-of-one shape, refactored onto the harness. Every
  assertion, budget, and timeout label preserved.
- **`control-database-offline-peers.spec.ts`** — the cadre-of-more-than-one shape, 9 tests.
- **`docs/STATUS.md`** — the "Gap: a cadre of more than one …" bullet is replaced by the coverage
  entry; the section heading now covers both shapes.

Two flavours of unreachable sibling, each run against both the `transaction` and `storage`
profiles:

- **departed** — a real second `CadreNode` started on a loopback WebSocket, its genuinely
  published address captured, then stopped, so the OS refuses the connection immediately.
- **blackhole** — an RFC 5737 TEST-NET-1 address, which never answers; this is where a freeze
  would live.

Each runs the full control operation table under 15 s per-operation deadlines with contents
asserted, not merely settlement (an empty read where local rows exist is the same failure class as
a hang): `hasOwnerKey`, `getOwnerKeys`, `queryCadrePeers`, `queryPeerRecord`, `resolvePeerAddrs`,
`isMember`, `listMembers`, `listAuthorizedMembers` (including self-exclusion), `registerSelf`
(genesis then refresh), then **both write directions** — `authorizePeer` (owner-vouched INSERT)
and `removePeer` (stamp-retiring DELETE, plus an already-absent re-run) — each with a separate
read-back and a check of the write-while-alone queue. Then an awaited `reconcileControlCohort()`
that must resolve, post-pass rows intact, queue undrained, and a bounded `stop()`.

Beyond the four profile × flavour cases:

- **warm restart** — the sibling row is on disk *before* `start()`, so the eager reconcile pass
  that `start()` schedules dials a dead address while the first control reads run.
- **three blackhole siblings** — the sequential dial loop accumulates roughly one js-libp2p
  default dial timeout each; 60 s pass budget.
- **an in-flight pass grinding through dead dials** — kicked unawaited, with the full operation
  set completing under its normal deadlines, then the pass awaited within budget.
- **`stop()` with a blackhole dial in flight** — polls libp2p's dial queue until the dial is armed,
  then asserts `stop()` is bounded and the abandoned pass still resolves.
- **circuit-relay in the transport set** — the single-blackhole matrix again with
  `[webSockets(), circuitRelayTransport()]`.

Anti-vacuity guard: every offline sibling is minted with a valid self-signed fresh peer record and
`resolvePeerAddrs` is asserted to return exactly its addresses *before* anything else runs, so the
dial path is provably armed rather than silently skipped. The `authorizePeer`/`removePeer` targets
deliberately get no addresses and no self-signature, so no reconcile pass ever dials them and each
case's dial-budget arithmetic stays exact.

## Review findings

### Read first, from the diff

Read the implement diff (`e1bfba1`…`cc0c6a6`) before the handoff summary, then read every
production file it leans on — `cadre-node.ts` (`reconcileControlCohort`, `dialControlSibling`,
`resolvePeerAddrs`, `noteControlWrite`, `stop`, `initializeSeedBootstrap`,
`scheduleSelfRegistration`, `listAuthorizedMembers`), `control-cohort.ts`,
`seed-bootstrap.ts` (`insertSelfPeerRecord`, `authorizePeer`, `removePeer`), `control-stream.ts`
(`withTimeout`), `peer-record.ts`.

### Claims verified, not taken on trust

- The dial path really is armed: `selectControlCohortDials` caps *non-owner* siblings at
  `DEFAULT_CONTROL_COHORT_TARGET_DEGREE` = 6, so all three blackholes in the multi-sibling case are
  selected; measured ~30 s for three matches three sequential ~10 s dials.
- `insertSelfPeerRecord` used for a *sibling's* record is not a misuse: it is the only route that
  produces a row that both satisfies `AuthorizedInsert` (owner voucher) and carries a self-`Sig`,
  which is what makes `resolvePeerAddrs` return addresses. `authorizePeer` writes `Sig: null` and
  would resolve to `[]`, which is exactly why the spec cannot use it for the dial targets.
- `listAuthorizedMembers` consults the node-local trusted-owner anchor, which is `MemoryTrustedOwnerStore`
  by default and therefore does **not** survive a restart — but `initializeSeedBootstrap` re-anchors
  the owner key synchronously, so the new warm-restart case is sound rather than accidentally green.
- Peer-record freshness (`DEFAULT_PEER_RECORD_MAX_AGE_MS` = 15 min) comfortably covers a restart.
- Test files really are typechecked in this package (`tsconfig.typecheck.json` includes `test`), so
  "typecheck clean" is not a vacuous claim.

### Found and fixed in this pass (minor)

- **The DELETE write path was untested.** The spec covered `authorizePeer` but not `removePeer` —
  a genuinely different SQL path (stamp retirement under `CadrePeer.AuthorizedDelete`, not an
  owner-vouched INSERT), and one `CadreNode.noteControlWrite` flags as a security-relevant
  durability gap when it commits alone. Added `runRemoveWrite` to the shared operation set:
  authorize, `isMember` true, remove, read-back, `isMember` false, queue entry is `'remove'`, plus a
  second remove of the now-absent peer. It runs in all seven operation-set cases.
- **The app-relaunch shape was uncovered.** Every case booted a node with an *empty* membership
  table and only then added siblings, so `start()` never ran with dead addresses already on
  record — which is precisely what a phone relaunch does, and the point at which the eager
  reconcile pass begins dialing them while the app issues its first reads. Added
  `re-boots on stored rows and still serves every control read/write with a BLACKHOLE sibling`
  (10.4 s), reusing the solo spec's shared-`keyStore`/shared-`storage` warm-restart pattern. To
  support it, `bootOwnerNode` was split into `startControlNode` + `genesisOwner`, with a
  `rejoinOwner` counterpart for the warm path.
- **`stop()`-with-dial-in-flight leaked the node on any failure path.** It was the one test with no
  `try`/`finally`, so a failed dial-queue poll or a rejected pass would have left a live libp2p node
  behind. Added a `finally` guard; `CadreNode.stop()` early-returns when not running, so the double
  call is safe.
- **A test name overstated what it exercised.** "a concurrent dial storm" implied simultaneous
  dials, but `reconcileControlCohort` dials sequentially — the concurrency is between the pass and
  the local operations. Renamed to say so, with a comment, and `docs/STATUS.md` corrected to match.

### Tripwires (recorded, deliberately not ticketed)

- Blackhole timings rest on js-libp2p's ~10 s default outbound dial timeout, which db-p2p does not
  override. Parked as the existing comment on `MULTI_RECONCILE_TIMEOUT_MS` in the spec: if a libp2p
  bump changes that default, the three-blackhole 60 s budget is the first thing to re-check.
- Only `MemoryRawStorage` is exercised, as in the solo spec, whose existing `NOTE:` about
  backend-specific hydrate bugs (add a `FileRawStorage` variant rather than widening the memory
  one) now covers the warm-restart case here too.

### Checked, found clean, no action

- Awaited `reconcileControlCohort()` calls can *join* an in-flight background pass via the
  single-flight guard, so the specs assert liveness and row integrity and never dial counts. That is
  the correct call and should not be "strengthened" into counting dials.
- Resource cleanup: every other case already had `try`/`finally` around `stop()`, and the departed
  sibling is stopped in a `finally` inside its own minting helper.
- DRY: `within`/`delay` are duplicated per spec, but each `within` carries a different scope label
  and a local `delay` is the established convention in this test directory
  (`device-token.spec.ts`, `peer-record-resolution.spec.ts`). Left alone.
- Source hygiene: the spec is ~440 lines of small named helpers with comments that explain *why* a
  budget or an assertion exists rather than restating the code. No action.
- Docs: `docs/STATUS.md` was the only file describing this coverage; it was already updated by the
  implement pass and is now extended for the delete path, the warm restart, and the renamed test.
  No other doc names these specs.

### Filed as new tickets

None. The two known gaps both already have homes: WebRTC in the transport set is
`backlog/debt-webrtc-transport-control-liveness-coverage`, and connected-but-slow members (a
different question — they *do* enter the write cohort) are
`plan/11-debt-control-write-availability-degraded-cohort-member`.

## Validation

- `yarn workspace @serfab/cadre-core typecheck` — clean.
- `yarn lint` — clean.
- `yarn workspace @serfab/cadre-core vitest run test/control-database-offline-peers.spec.ts test/control-database-solo.spec.ts --reporter=verbose` — **12 passed**, 113 s. Per-test:
  departed 0.5–0.8 s; single blackhole 10.3 s; warm restart 10.5 s; three blackhole 30.5 s;
  in-flight-pass 30.3 s; stop-mid-dial 193 ms; circuit-relay 10.3 s.
- `yarn workspace @serfab/cadre-core test` — 78 files, **1214 passed**, 1 skipped (the known win32
  `skipIf` in `key-store.spec.ts:231`).

Validated on win32 only. Budgets are generous multiples of measured cost, so CI/Linux has ample
headroom.
