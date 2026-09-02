----
description: Reads from the shared party database now get the same bounded second chance writes already had when the network blips, with a shorter deadline and a narrower idea of which failures are worth repeating; reviewed, with one missed case fixed (the membership refresh was retrying while holding the write lock) and the docs brought up to date.
files: packages/cadre-core/src/control-retry.ts, packages/cadre-core/src/control-read-retry.ts, packages/cadre-core/src/control-write-retry.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/control-read-retry.spec.ts, packages/integration-tests/src/scenarios/control-write-degraded-cohort-member.integration.ts, docs/architecture.md
----

# Transient-failure retry for control-database reads

## What shipped

Control **writes** have absorbed transient cluster failures since `control-write-retry.ts`
landed; a control **read** had none — one stream reset during a scan ended the read
outright. Reads now get the same bounded re-presentation, through a shorter deadline and a
narrower classifier.

- **`control-retry.ts` (new)** — the retry loop, extracted from `retryControlWrite` and
  parameterised by policy (attempts, delays, elapsed budget, classifier, log prefix). Also
  hosts the shared `chainMessages` cause-chain walker. The write funnel's log lines are
  byte-identical to before the extraction (asserted by the degraded-cohort scenario and
  confirmed live in this pass's run).
- **`control-read-retry.ts` (new)** — the read policy: 3 attempts, 100 ms then 400 ms of
  jittered backoff, **1.5 s** elapsed budget. The budget is sized to fit inside the inbound
  admission gate's 2 s *fail-open* decision timeout (`ADMISSION_DECISION_TIMEOUT_MS`) — a
  read that outlives that gate spends its retries after the gate has already admitted an
  unplaced peer. Retriable: the transactor's read-phase "some peers did not complete"
  aggregate (the write classifier's discriminator, reused verbatim) and
  `BlockUnavailableError` for `peers-unreachable` / `cohort-unreachable`. Excluded with
  cited measurements: `claimed-elsewhere`, `unmaterializable`, possibly-stale, and anything
  unmatched. No commit-phase veto — a read commits nothing.
- **`control-database.ts`** — `readEval` became `readRowsOnce` (one unretried, collecting
  drain; still the one place the committed-read opt-in is spelled) plus `readRows` (the
  retried, labelled funnel). All 15 read call sites converted with labels. Reads issued
  from inside a locked write body opt out per call, because their backoff would sleep
  holding the write lock and the write funnel already re-runs the body's reads.
- **`index.ts`** — read constants, classifier and `retryControlRead` exported alongside the
  write ones.

## Review findings

The implement diff was read first, with the handoff summary read afterwards.

### Checked, nothing found

- **Classifier regex against upstream's real template.** Verified against
  `../optimystic/packages/db-core/src/network/struct.ts:275` (`Block <id> is unavailable
  (<reason>): …`) and `:290` (`Block <id> may be stale: …`), and the `reason` union at
  `:207-223`. The spec's transcription is exact, the two included reasons and three
  excluded ones are the real names, and every matcher fails closed.
- **Materialization safety.** `readRows` returns an array where `readEval` returned a lazy
  iterator. Every caller either drains fully or takes the first row of a statement that
  yields at most one (a primary-key lookup or a `count(1)`); `hasOutstandingFormationInvite`
  already scanned every row before the change. No caller lost an early exit.
- **Locked-body sweep.** Every `withWriteLock` / `lockedWithRetry` / `mutateCadrePeer` body
  was walked: `insertCadrePeer`'s stamp guard, `deleteGuardedRow`, both `assertSeatRemains`
  reads, `reissueRevocations` (signatures and the `queryRevocations` enumeration both
  happen before the lock), `reapRevokedRow` and `reauthorizeCadrePeer` (stamp reads
  confirmed *pre*-lock, so the handoff's deviation #1 is right, and retrying them is a win).
  `SeedBootstrapService` reaches the lock through `execWrite` with no read inside. One miss,
  below.
- **Labels.** 15 literals plus the dynamic `stamp-<Table>`; no two collide.
- **Write-funnel log fidelity.** The degraded-cohort run emitted
  `Control write [self-record-update] failed transiently (attempt 2/3), retrying in … ms`
  and `… committed on attempt 3/3` in the pre-change format.

### Found and fixed in this pass (minor)

- **The membership-gate refresh was retrying while holding the write lock.**
  `notifyMembershipChanged` invokes its listener with the lock held — stated as a design
  property on `mutateCadrePeer` — and that listener is
  `CadreNode.refreshAuthorizedControlPeers` → `listAuthorizedMembers` →
  `ControlDatabase.queryCadrePeers`, which is two `readRows` calls. After the implement pass
  both retried, so a transient blip slept up to ~550 ms per read *with the write lock held*,
  stalling every other local writer — the exact contract the pass wrote three NOTEs to
  protect. It was missed because the read is reached through a **callback**, not written
  inside the locked body. Fixed: `queryCadrePeers` / `queryRevokedStamps` /
  `listAuthorizedMembers` take an optional `retry`, and `refreshAuthorizedControlPeers`
  passes `false`. Nothing is lost — that refresh is best-effort, keeps the previous snapshot
  on failure, and is re-driven by the next membership write and by the timed reconcile. New
  spec case: *"does not retry the membership-gate refresh read the write lock is holding"*.
- **Three copies of the same `retry ? readRows(…) : readRowsOnce(…)` ternary** (in
  `queryStampId`, `queryFormationInvite`, `countFormationUsage`) collapsed into
  `readRows(sql, params, label, retry = true)`. `readRowsOnce` now has exactly one caller,
  and `label` became a required positional — all 15 sites already passed one, so the
  "keep new call sites labelled" plea is now type-enforced rather than hoped for.
- **A wrong number in a doc comment.** `CONTROL_READ_RETRY_DELAYS_MS` claimed "worst case
  ~750 ms of total sleep". The loop caps each sleep at the largest base, which clips the
  second delay's upside jitter, so the real worst case is 150 + 400 = **550 ms** — which is
  what the spec's own `worstSleep` bound already computed. Comment corrected.
- **`docs/architecture.md` was stale and the implement pass touched no docs at all.** Its
  read bullet still said a stalled control write "currently also blocks control *reads*" and
  pointed at `tickets/fix/control-reads-blocked-by-stalled-write` — that fix landed
  2026-08-25 and the ticket is in `complete/`. Rewritten to state the committed-read fix as
  landed *and* to document the new read policy: attempts, backoff, budget, the fail-open
  sizing argument, the retriable set with the measured exclusions, and the locked-body
  opt-out including the membership-listener case.
- **Dangling identifiers after the rename.** `control-write-degraded-cohort-member.integration.ts`
  still named `readEval` in two comments, one of which also described the committed-read
  case as a standing `it.fails` (it has been a plain `it` since 2026-08-25). Both corrected,
  along with three `fix/…` stage paths for a ticket now in `complete/`.

### Tripwires — recorded at the code site, deliberately not ticketed

- **`hasOutstandingFormationInvite` stacks read budgets on the fail-open gate path.** It
  issues one retried `countFormationUsage` read per unexpired metered invite, each carrying
  its own 1.5 s budget, on a path the admission gate awaits under a 2 s fail-open deadline —
  so with N such invites the worst case is (1 + N) budgets, not one, and the module's
  "fits under the deadline" argument is per-read. Fine while a cadre holds a couple of live
  invites and transient failures are rare. `NOTE:` at the loop, naming the fix if it ever
  trips (one shared deadline for the method, not a bigger per-read budget).
- **Nothing structural keeps a future under-lock callback from smuggling in a retried
  read.** The opt-out has to be per-call: an unlocked read runs concurrently with a locked
  body, so `this`-state cannot tell them apart, and there is no async-context primitive
  available on every target platform (browser, React Native) to carry the answer. `NOTE:` at
  `readRows` naming the membership listener as the one instance and telling the next reader
  to audit the read graph of any new under-lock callback seam.

### Major findings

**None.** The one contract violation found (the membership listener) resolved at a single
site with an existing per-call mechanism, so it was fixed here rather than filed. No new
tickets were opened by this review.

### Accepted tradeoffs encountered

None — no `NOTE: accepted tradeoff` marker sits at any site this review touched.

## Validation

- `yarn typecheck`, `yarn lint`, `yarn build` (root, whole repo): green, before and after
  the doc edits.
- `yarn workspace @serfab/cadre-core test`: **1683 passed, 1 skipped** (105 files) — the
  implement pass's 1682 plus the new membership-listener case. Required rebuilding the
  linked `../quereus` workspace first (the stale-build guard refused to run against its
  stale `dist`); no change to this repo's tree.
- `relay-only-control-addr.integration.ts`: **5/5 passed.** This was one of the two runs the
  implement pass could not finish — gap closed.
- `control-write-degraded-cohort-member.integration.ts`, the other gap: run 1 tripped the
  boot gate (`Timeout waiting for B resolves C's signed address record after 45000ms`),
  which is the documented intermittent recorded in `tickets/.pre-existing-known.md`
  (tracked by `fix/control-peer-row-refresh-invisible-to-third-node`, whose note names this
  exact address-resolution timeout) — not re-reported, and no `.pre-existing-error.md`
  written. Run 2: **7/7 passed**, including all three cases that failed in the implement
  pass and the injected-transient case. That settles the implement pass's open question —
  the failures it saw were the known intermittents composing, not a classifier or loop
  defect, and `registerSelf` survives the read half of the injected failure.
