description: Added a control-network request/response protocol that lets one of a party's own nodes ask a sibling "what's your current network address for strand X?", so nodes can find each other on a strand's separate network.
prereq:
files: packages/cadre-core/src/strand-addr-protocol.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/strand-addr-protocol.spec.ts, packages/cadre-core/test/wake-stream-helpers.ts
----

## Summary

Reviewed and accepted the new control-network **strand-address RPC** primitive
(`/sereus/strand-addr/1.0.0`), a faithful mirror of `strand-wake-protocol.ts`:

- Wire types `StrandAddrRequest` / `StrandAddrResponse` (`types.ts`).
- `StrandAddrService` receiver — membership-gated, with the same three hardening
  layers as wake (concurrency cap, abort-on-timeout read, malformed/oversized
  frame guard), each reported as an empty response rather than a hung stream;
  `shutdown()` unhandles the protocol.
- `collectStrandAddrs(node, peers, strandId, options?)` client — dials siblings
  concurrently (peerId-first, addr fallback), returns the deduplicated,
  signaling-first union, excludes self, folds per-peer failure to `[]`.
- Exported from `index.ts`.

The implementation matches the implement-stage spec exactly and is **primitive-
only** (not yet wired into seed derivation — that is the follow-up
`strand-seed-from-strand-addr-rpc`, already queued in `implement/` with this as a
`prereq:`).

## Review findings

### Verification performed

- **Read the implement diff first** (commit `30f906a`) with fresh eyes, then
  cross-checked against the model module `strand-wake-protocol.ts`, the shared
  `control-stream.ts` (frame writer, `withTimeout`, `readStreamToEnd`),
  `seed-bootstrap.ts` (`decodeLengthPrefixedFrame`), and `peer-record.ts`
  (`orderSignalingFirst`), plus the original implement-stage spec.
- **Build:** `yarn workspace @serfab/cadre-core build` → clean.
- **Tests:** full cadre-core suite `yarn vitest run` → **45 files, 611 passed, 1
  skipped** (the 1 skip is pre-existing, unrelated). Targeted spec → 18 passed.
- **Lint:** `yarn eslint` on the changed src + test files → exit 0.
- **Wiring/leak search:** grepped the whole repo for `strand-addr` / `StrandAddr`
  / `collectStrandAddrs` / `STRAND_ADDR` — confirmed no production call site
  (only `dist/` build artifacts and unrelated `…StrandAddrs` local variable names
  in integration tests). Confirms the "not wired" claim.
- **Docs:** confirmed `strand-wake` is documented in `docs/architecture.md` §575
  but `strand-addr` is not yet — see "Docs" below.

### Correctness / architecture (SPP, DRY, type safety, cleanup, error handling)

**No bugs found.** The module reproduces wake's hardened single-request/single-
response pattern correctly end to end: synchronous `activeStreams++` before the
first await (so the concurrency cap is race-free), `finally`-block stream close,
per-attempt `AbortController` whose `onTimeout` aborts both the in-flight
`dialProtocol` (via the dial `signal`) and the live stream, the `signal.aborted`
early-abort branch after connect, `removeEventListener` cleanup, and `unhandle`
on shutdown. Type safety is clean (no `any`; the `as ControlStream` /
`as Connection` casts are at the libp2p boundary, identical to wake).

Behaviors confirmed correct (not bugs):
- `dialOneSibling` returns the **first** target's response even when its
  `multiaddrs` is empty — correct, because the targets are alternate routes to
  the *same* sibling, so one successful answer (even "I don't run that strand")
  is that sibling's answer; it must not re-ask via the addr fallback.
- Reject/error paths reply `{ strandId: '', multiaddrs: [] }` — harmless; the
  client reads only `multiaddrs`. Flagged in the handoff; confirmed no caller
  trusts `response.strandId`.

### Findings fixed inline (minor)

**Test-coverage gaps** — two code paths exercised by the wake spec but missing
from the strand-addr spec. Both fixed by adding tests (now 18 in the spec, suite
611):

1. **Client-side per-dial timeout/abort was entirely untested.** The
   `withTimeout` + `AbortController` + `onAbort` + `signal.aborted` machinery in
   `dialOneSibling`/`sendStrandAddr` had no coverage. Added a test: a sibling
   whose receiver never replies is skipped within `timeoutMs` (result `[]`) and
   its stream is aborted (parity with wake's "rejects on timeout and aborts the
   client stream").
2. **Parseable-peerId-dial-fails → addr fallback was untested.** The existing
   "unparsable peer id" test never enters the peerId branch, so the per-target
   fallback loop (peerId fails → try explicit addrs) was uncovered. Added a test
   asserting both targets are dialed in order and the addr answer is returned
   (parity with wake's "falls through to the next address").

### Findings noted, not changed (trivial / by design)

- `describeTarget` is a one-line `toString()` wrapper used at a single log call.
  Wake inlines `addr.toString()`. Left as-is: it names intent at the call site
  and is not worth the churn. Stylistic only.
- **Self-exclusion is by `peerId` only** — an addr-listed self in `peer.addrs`
  is not filtered. Negligible: the wiring passes connected siblings, and the
  worst case is one wasted self-dial. Documented in the handoff as acceptable.
- **No global client concurrency cap** (`Promise.all` over all candidates) — by
  design for a single-party cadre's small peer count; documented.
- **Membership-only authorization** (no per-request signature) — by design, v1
  parity with wake; the control network is already single-party.

### Major findings → new tickets

**None.** No correctness, security, performance, or design defects warranting a
fix/plan/backlog ticket. The two test gaps were minor and fixed in this pass.

### Docs (deferred to the wiring ticket — deliberately, not silently)

`strand-addr` is **not** documented in `docs/architecture.md` (where the wake
protocol lives at §575) or `docs/strands.md`. This is the correct deferral: the
module is primitive-only with no reachable production behavior, so describing it
now would document a protocol no code path uses. The follow-up
`strand-seed-from-strand-addr-rpc` (in `implement/`) already lists
`docs/architecture.md` in its `files:` and its TODO explicitly updates both
`docs/architecture.md` and `docs/strands.md` to describe the strand-addr seed
behavior — i.e. the docs land with the real call site. No separate ticket needed;
flagged here so the wiring agent adds the protocol entry alongside wake's.

### Known gaps from the handoff — verified as acceptable floors

- **Not wired anywhere** — confirmed; follow-up ticket exists with correct
  `prereq:` chain.
- **No real-network/integration test for `runOnLimitedConnection` + relay** —
  correct to defer: there is no production call site to integration-test against
  yet. The option is set identically to wake on both `handle` and `dialProtocol`;
  verified by parity. The integration test belongs with the wiring ticket.
