description: Real cohort check-in on exponential backoff (resume → bounded window → re-hibernate), replacing the no-op fixed-interval timer. Reviewed + one correctness fix applied inline.
files: packages/cadre-core/src/types.ts, packages/cadre-core/src/hibernation-manager.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/test/hibernation-manager.spec.ts, packages/cadre-core/test/cadre-node.spec.ts, docs/architecture.md, docs/STATUS.md, tickets/backlog/hibernation-control-network-pending-precheck.md
----

## What landed

The hibernating-strand check-in is now **real** and **exponentially backed off**, replacing the old fixed `setInterval` whose body only advanced `nextCheckIn`.

- **Backoff schedule** (`types.ts`, `hibernation-manager.ts`): `HibernationTimeouts` gains `checkInBackoffFactor` (default 2) and `checkInMaxInterval` (per-hint cap); `checkInInterval` is now the base/first delay. Caps: interactive 30s→~1h, background 5m→~6h, archive 1h→~3d; realtime N/A. `scheduleCheckIn` is a self-rescheduling single-shot `setTimeout` chain carrying the current delay as a parameter (so backoff auto-resets to base on the next hibernation, no per-strand counter). `runCheckIn` awaits `onCheckIn` before arming the next tick — a slow check-in never overlaps.
- **Real check-in** (`cadre-node.ts`): `handleStrandCheckIn` resumes the strand (re-resolving cohort seed/mode like a wake), holds it live for `checkInWindowMs` (default 15s), then stays `active` if app-driven activity landed during the window, else `quiesceStrand`s back to `hibernating` (manager escalates + reschedules).
- **Wake re-arms the lifecycle**: `recordActivity`'s wake branch now re-arms idle→hibernate once the wake settles, so a strand that wakes then goes quiet eventually re-hibernates (making backoff-reset reachable via the activity-wake path).
- **Docs/backlog**: `architecture.md` + `STATUS.md` flipped to implemented with backoff/resume-as-reachability semantics and the pull-on-read caveat; filed `backlog/hibernation-control-network-pending-precheck.md` for the lighter control-network pre-check.

## Review findings

Reviewed the full implement diff (`a1e29c7`) with fresh eyes against SPP/DRY/modularity/scalability/maintainability/perf/resource-cleanup/error-handling/type-safety, then read every touched file plus the real `StrandInstanceManager.resumeStrand`/`buildStrandRuntime`/`releaseRuntime` and the `recordActivity`→`recordStrandActivity` wiring.

### Major (found + fixed inline)

- **Resume failure during a check-in stranded the strand and killed its check-in chain.** The real `StrandInstanceManager.resumeStrand` sets `instance.status = 'error'` (after rolling back via `releaseRuntime`) and rethrows on failure. The manager's `runCheckIn` catches the throw but then decides wake-vs-escalate purely from `instance.status`: `'error' !== 'hibernating'` read as **"woke"**, so it deleted the check-in timer and **stopped the chain**, leaving the strand in `'error'` with no runtime and no future check-in — and `recordActivity` only acts on `idle`/`hibernating`/`active`, so the strand couldn't auto-recover. This is precisely the flaky-network-during-resume case hibernation targets. The implementer's "throwing onCheckIn doesn't break the chain" test masked it because its mock left status `'hibernating'`.
  - **Fix** (`cadre-node.ts` `handleStrandCheckIn`): wrapped the resume→window→decide body in `try/catch`; on any failure it does a best-effort `quiesceStrand` (releasing any partial runtime) and forces `instance.status = 'hibernating'`, so the manager escalates the backoff and retries on the next tick rather than treating `'error'` as a wake. Does not rethrow (manager reads status; it already logs).
  - **Regression test** (`cadre-node.spec.ts`): "check-in that fails to resume leaves the strand hibernating so the manager retries on backoff" — fake `resumeStrand` mirrors the real failure (rollback + `status='error'` + throw); asserts `handleStrandCheckIn` resolves (does not throw out), ends `hibernating`, and ran a cleanup quiesce.

### Minor (found + fixed inline)

- **Stale `nextCheckIn` after a check-in wakes the strand.** When `runCheckIn` stops the chain on wake it deleted the timer but left `instance.nextCheckIn` pointing at a phantom future check-in (observable via `getStrand`). Now cleared to `undefined` on that path (`hibernation-manager.ts`). Self-healed on the next hibernation previously, but cosmetically wrong for a strand that stays awake.

### Checked and found correct (no change)

- **Activity-during-window double-emit — NOT a bug.** I initially suspected `recordActivity` during the window (status `hibernating`) would take the wake branch and double-emit `strand:waking`. Confirmed false: the real `resumeStrand`→`buildStrandRuntime` sets status to `'active'` before the window, so a concurrent `recordActivity` takes the **active** branch (reschedules idle, no wake, no second emit). The handoff's design note #7 and the "observer briefly sees active" claim are accurate.
- **Manager↔CadreNode status coupling.** `runCheckIn` deciding wake-vs-escalate from `instance.status` is sound now that `handleStrandCheckIn` guarantees a terminal `active`/`hibernating` (the major fix closed the one path — `'error'` — that violated it).
- **Backoff math, cap plateau, base reset, await-before-reschedule, throwing-chain resilience** — verified by the implementer's 5 manager tests (escalation 100→200→400→800→800 with `nextCheckIn`; `maxConcurrent===1`; reset-to-base on next hibernation; idle re-arm after activity wake; throwing tick reschedules). `clearInterval`→`clearTimeout` migration complete (no stray `clearInterval`/`setInterval` remain in the manager).
- **Timer/resource cleanup** — `stop()`/`clearTimers()` clear both maps via `clearTimeout`; resume-failure rollback (`releaseRuntime`) leaves neither handle; the major fix adds a cleanup quiesce on the failure path. No leaked libp2p nodes on the paths exercised.
- **Type safety** — no new `any` in `src`; specs use `as unknown` casts to reach privates, consistent with the existing suite (cadre-core test files aren't typechecked in CI per `STATUS.md`).
- **Docs** — read `architecture.md` (wake-mechanism #2 + latency-hint base→cap table) and `STATUS.md`; both reflect the new reality including the pull-on-read honesty caveat. Accurate.

### Not addressed here (deferred by design — carried forward as known gaps)

These are honest limitations of the resume-as-reachability approach, documented in the handoff and the filed backlog ticket; none are regressions and all need design/cross-cutting work beyond an inline review fix:

- **Check-in does not itself pull pending cohort transactions** (relies on app-driven reads during the window; Optimystic is pull-on-read with no repo-level "pull pending" hook). A `StrandDatabase.sync()`-style hook is the real missing piece — needs the sApp table set. **Reviewer recommendation: worth a follow-up** distinct from the parked control-network pre-check, but it is a feature, not a review fix.
- **Activity detection is app-driven only** (`connectedPeers` not yet wired to live libp2p connection count); **window is a fixed bounded sleep** with no early-exit (a cold cohort whose connect exceeds 15s re-hibernates, retrying on backoff); **force `wakeStrand` re-arm gap** (idle re-arm lives in `recordActivity`, which has the instance; force wake has only the id). All minor/by-design and tracked in the handoff.
- **No real-node integration test** of resume→connect→read→re-hibernate against live optimystic (`integration-tests/`). Unit coverage uses injected fakes + stubbed window. Out of scope for this pass.

## Validation

- `yarn workspace @serfab/cadre-core test` — **234 passed (17 files)** (+1 over the implement baseline of 233: the resume-failure regression test).
- `yarn workspace @serfab/cadre-core typecheck` — exit 0.
- `yarn workspace @serfab/cadre-core build` — exit 0.
- No `lint` script in cadre-core; typecheck is the gate. No pre-existing failures surfaced.

## Design decisions (confirmed during review)

- Explicit launch mode does NOT survive wake/check-in (both re-infer via `selectStrandMode(undefined, hasOtherPeers)`) — intended bootstrap→networked correction as the cohort grows.
- Backoff state is the `setTimeout`-chain parameter, not a per-strand map — reset is automatic on the next hibernation.
- Silent re-hibernate emits no `strand:hibernating` (net-no-observable-change); only the activity path emits `strand:waking`. During the window the strand is genuinely live (`status==='active'`, `libp2pNode` present).
