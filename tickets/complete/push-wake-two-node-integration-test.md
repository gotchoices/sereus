description: Real-libp2p push-wake integration scenario (direct dial, NAT-via-relay delivery, non-member rejection) plus the `runOnLimitedConnection` wake-protocol fix it forced. Implemented green; reviewed adversarially — fix confirmed correct, findings verified honest, one new backlog ticket filed.
files: packages/integration-tests/src/scenarios/push-wake-e2e.integration.ts (new), packages/cadre-core/src/strand-wake-protocol.ts (fix)
----

## What landed

A new scenario file `packages/integration-tests/src/scenarios/push-wake-e2e.integration.ts`
(3 `it()`s) exercising the **real wire path** of control-network push-wake: real
`node.handle(WAKE_PROTOCOL,…)` dispatch, a real `dialProtocol` stream over a real WebSocket
transport, libp2p 3.x half-close, multi-chunk length-prefixed JSON framing, the circuit-relay
(signaling-first) dial, and `pushWake`'s composition with `resolvePeerAddrs` — none of which
the mock-based `strand-wake-protocol.spec.ts` unit tests touch.

Plus a real product fix the NAT scenario forced: `StrandWakeService` now registers the WAKE
handler with `runOnLimitedConnection: true`, and `sendWake` dials with
`runOnLimitedConnection: true`. Without both, the wake protocol could not open a stream over a
circuit-relay connection (libp2p marks relayed connections "limited"), directly contradicting
its documented purpose of reaching a NAT'd peer via its circuit-relay address.

Scenarios:
1. **Direct dial, hibernating member** — proves the full hibernating→active resume over the
   real direct wire.
2. **NAT'd receiver via circuit relay** — proves signaling-first resolve ordering and relayed
   wake delivery to an already-active strand (the "already live → accepted" branch).
3. **Non-member rejected** — outsider dials a hibernating receiver; rejected on the membership
   gate with no side effect (strand stays `hibernating`).

## Review findings

### Process
Read the implement diff (`1e445be`) with fresh eyes first — the two `runOnLimitedConnection`
additions in `strand-wake-protocol.ts` and the full new 386-line scenario file — then the
handoff. Traced the runtime path the test depends on: `pushWake` → `resolvePeerAddrs` →
`dialWake`/`sendWake` (`cadre-node.ts:1818`, `strand-wake-protocol.ts:239`), the receiver
`processWakeRequest` → `isMember`/`getStrand`/`wake` gate, and the strand status mutation path
(`StrandInstanceManager.resumeStrand` mutates `instance.status` in place on the same map
object — so `processWakeRequest`'s post-wake `instance.status` read returns the *updated*
status, which is why scenario 1's `status:'active'` assertion is correct). Cross-checked the
two open findings against existing tickets and docs.

### Validation — all green (cadre-core rebuilt first; integration tests import `dist/`)
- `yarn workspace @serfab/cadre-core build` → exit 0 (REQUIRED before the integration test —
  `@serfab/cadre-core` resolves via `dist/index.js`, and the fix lives in `src`).
- `yarn workspace @serfab/integration-tests test src/scenarios/push-wake-e2e.integration.ts`
  → **3 passed** (~10s; direct 606ms, NAT 426ms, reject 169ms).
- `npx vitest run test/strand-wake-protocol.spec.ts` (cadre-core) → **13 passed**.
- `yarn workspace @serfab/cadre-core typecheck` → exit 0.
- `yarn workspace @serfab/integration-tests typecheck` → exit 0.
- `eslint` on both changed files → 0 errors.
- No `.pre-existing-error.md` written — no unrelated failures surfaced.

### Checked — what was verified
- **The `runOnLimitedConnection` fix is correct and the headline value.** Verified
  end-to-end: the NAT scenario genuinely traverses relay `L` (distinct from sender `S`) and
  only passes with the fix. Reviewed for downside: the change is scoped to `WAKE_PROTOCOL`
  only; the handler remains membership-gated (`isMember`) and frame-size-capped
  (`MAX_WAKE_SIZE = 64 KB`), and the exchange is a single request→ack well inside the relay's
  data/duration cap. Accepting a stream on a limited connection is the protocol's whole point.
  Approved.
- **Scenario honesty.** All three deviations documented in the file header are accurate and
  match the established harness reality (see Findings below). The local-seeding workaround
  keeps every byte of the dial/handle/framing/resolve path under test; the header is explicit
  that it does NOT prove control-DB replication.
- **No-side-effect property (scenario 3).** Confirmed the receiver rejects before `wake()`
  (`processWakeRequest` checks `isMember` first), so the hibernating strand is untouched.
- **Resource cleanup.** Every scenario stops all booted nodes in `finally` (Rx/S, plus L for
  the NAT case). No leaks.
- **Docs.** Read the source comments the change relies on; the new inline comments accurately
  describe the limited-connection semantics. No separate doc file describes the wake transport
  in a way the fix invalidates (grepped `docs/` for wake/`runOnLimitedConnection`).

### Found — disposition
- **Finding 1 (fix) — RESOLVED.** `runOnLimitedConnection` is the right fix (above). No
  further action.
- **Finding 2 (cross-node control-DB does not converge) — MAJOR, NEW TICKET FILED:**
  `tickets/backlog/control-db-cross-node-replication-convergence.md`. The receiver never
  observes a sibling-written `CadrePeer` row, so the three scenarios stub authorization with
  local seeding. This is load-bearing for production push-wake authorization (the receiver is
  supposed to read the shared control DB to know the sender is a member) and is **not** tracked
  by any existing ticket — the completed `integration-tests-real-control-sync` pass only made
  assertions *honest* about the "authority-only convergence" caveat; it did not resolve it.
  Filed to backlog because it needs a product/architecture decision (is the control DB meant
  to replicate P2P, and through what mechanism?) before implementation.
- **Finding 3 (woken NAT'd member's strand resume recruits non-strand relay-mesh peers) —
  MAJOR, ALREADY TRACKED, no duplicate filed.** Same root cause as the existing backlog ticket
  `strand-cohort-seed-uses-control-network-addresses`: the cohort seed is built from
  control-network peers/addresses, so a resumed `networked` strand cannot form its
  strand-repo cluster. The push-wake test correctly sidesteps this by waking an already-active
  strand in scenario 2; scenario 1 proves the resume on the direct path. Referenced, not
  re-filed.
- **Finding 4 (NAT receiver listens on explicit `…/p2p-circuit`, not `[]`) — accepted.**
  Honest deviation: the receiver still has no direct dialable address (genuinely NAT'd); the
  explicit circuit listen only makes the reservation deterministic rather than discovery-timing
  dependent (a circuit-relay-v2 `HadEnoughRelaysError` guard quirk). No action.
- **Finding 5 (`addStrand` mode) — informational.** Confirmed: `mode:'bootstrap'` stands a
  strand up solo to `active`; resume recomputes mode from cohort (→ `networked`). No action.

### Observations (no change made)
- **`processWakeRequest` status re-read comment** (`strand-wake-protocol.ts:218`,
  pre-existing, outside this diff) says "re-read its current status" but actually reuses the
  `instance` reference captured before `wake()`. It is correct *today* only because
  `resumeStrand` mutates `instance.status` in place rather than replacing the map entry. If a
  future change swaps the instance object on resume, this would silently return a stale status.
  Left as-is (unit-tested, not in scope, no current defect); noted for whoever next touches the
  resume path.
- **CI build ordering.** Integration tests import the built `@serfab/cadre-core`; CI/review
  must build cadre-core before running this scenario or the NAT case fails with the original
  `LimitedConnectionError`. Operational note, not a code defect.

### Not changed
No inline code edits were warranted — the implementation and test are correct and green. The
empty-category statement: there were **no correctness, type-safety, resource-cleanup, or
error-handling defects** in the diff (verified above), so nothing was fixed inline; the two
major findings are product/design gaps dispositioned to tickets, not inline fixes.
