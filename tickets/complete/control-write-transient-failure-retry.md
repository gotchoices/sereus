description: Shared-settings control writes now retry automatically after a hiccup in which the other machines never answered, instead of failing the whole operation on the first try. Reviewed and landed.
prereq:
files: packages/cadre-core/src/control-write-retry.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/control-write-retry.spec.ts, packages/cadre-core/test/control-write-lock.spec.ts, docs/architecture.md, docs/cadre-consistency.md, docs/STATUS.md, packages/quereus-plugin-sereus/src/cluster-size.ts, packages/integration-tests/src/scenarios/happy-path.integration.ts, packages/integration-tests/src/scenarios/harness-party-control-cohort.integration.ts
----

# Bounded retry for transient control-write failures

## What shipped

Control-database writes replicate to every machine in the party, so at three machines a
write commits only if all three approve. Two failure shapes there are *hiccups* rather than
disagreements: the transactor's "some peers did not complete" aggregate (a straggler or a
reset stream), and an approval shortfall in which nobody actually voted against the write.
Both now retry instead of failing the caller.

- `packages/cadre-core/src/control-write-retry.ts` (new) — a classifier
  (`isRetriableControlWriteFailure`, message-based, walking `cause` chains via Quereus'
  `unwrapError`) plus the loop (`retryControlWrite`): 3 attempts, backoff 250 ms → 1 s
  jittered ±50 % and capped at 1 s, all inside a 10 s elapsed budget checked after a failed
  attempt *before* sleeping. The last error is rethrown by identity, never wrapped.
  Injectable `sleep` / `now` / `delaysMs` so specs never wait out a real backoff.
- `control-database.ts` — one private funnel, `lockedWithRetry`, wraps
  `retryControlWrite(() => this.withWriteLock(fn), …)`. All six former direct
  `withWriteLock` callers go through it. Retry wraps the lock from *outside*, so the backoff
  sleeps with no lock held and a queued writer runs during it.
- `index.ts` — exports the constants, classifier, loop and options type so the integration
  package can drive the classifier against real engine errors.
- Docs — `architecture.md` "Replication cluster size" gained the retry rationale and the
  arithmetic showing no approval threshold can relax three-node unanimity;
  `cadre-consistency.md` and `cluster-size.ts` point at it.

## Review findings

### Verified correct (the two things the handoff flagged as most load-bearing)

- **The zero-vs-non-zero-rejection split is right, and for a better reason than the handoff
  gave.** Checked against the real source, not just against itself:
  `../optimystic/packages/db-p2p/src/repo/cluster-coordinator.ts:374` raises
  `Failed to get super-majority: …` while collecting *promises* — before any commit — so
  re-presenting it cannot double-apply anything. A decisive rejection never reaches that
  line at all; it throws a different error class (`ValidatorRejectionError`, message
  `Transaction rejected by validators`), which the classifier also never matches. So the
  classifier is conservative in both directions. Noted in the source comment.
- **`lockedWithRetry` placement.** Swept every `withWriteLock` reference across `packages/`:
  outside `control-database.ts` itself the only callers are two specs that deliberately
  exercise the bare lock. No production path skips the retry.
- **Classifier disjointness with `isLostUseNumberRace`** holds — the lost-use-number
  messages are constraint failures, which the retriable patterns cannot match — and the
  composed-loop spec pins total attempts at 3, not 9.

### Fixed in this pass (minor)

- **The classifier's comment named one origin for the transactor aggregate; there are
  three.** `network-transactor.ts` raises `Some peers did not complete:` from the block
  `get` path (~:243), from `pend` (~:528) and from `commitBlocks` (~:718). Comment corrected
  in `control-write-retry.ts`, including the commit-phase caveat below.
- **Four references to a ticket slug that no longer exists.**
  `debt-control-write-unanimity-at-three-nodes` was consumed by the plan stage that produced
  this ticket, but `docs/STATUS.md:810` and the header comments of
  `happy-path.integration.ts` and `harness-party-control-cohort.integration.ts` (two sites)
  still cited it as open work. All four now point at `architecture.md` → "Replication
  cluster size", which is the canonical explanation and will not move.

### Filed as work (one, appended to an existing ticket rather than a new one)

- **Is a commit-phase aggregate reachable, and is retrying it safe?** The `commitBlocks`
  origin above is phase 2, not phase 1: `TransactorSource.transact` cancels the pend and
  rethrows, but peers that already committed stay committed. A retried body could then
  re-issue its SQL over a write that partly landed and surface a constraint failure for a
  write that actually succeeded. This is read off the transactor, not observed, and needs a
  commit-phase partial failure to survive the transactor's own budget — it may not be
  reachable at all. Root cause is one line (the first entry of
  `RETRIABLE_CONTROL_WRITE_PATTERNS`), and `tickets/implement/21-control-write-retry-real-error-coverage.md`
  already claims that file, so it was appended there as section 4 plus a TODO rather than
  filed as a duplicate ticket. A `NOTE:` at the pattern points at it.

### Parked as tripwires (conditional — deliberately not tickets)

- **Jitter collapses on the last backoff.** The cap equals the largest base delay, so ~half
  of the second backoffs land exactly on 1 s instead of spreading. Harmless while retriers
  are a few party nodes whose attempts already start seconds apart. `NOTE:` at
  `jitteredDelay` in `control-write-retry.ts`, with the fix if a synchronized herd ever
  appears (raise the cap above the largest base).
- **No cancellation at the retry seam.** A `stop()` racing a backoff waits out at most ~1 s;
  the implementer documented this on `CONTROL_WRITE_RETRY_DELAYS_MS` and chose the cap over
  plumbing an `AbortSignal` through every write path. Re-checked and agreed — left as is.

### Checked and clean, so nothing filed

- **Re-runnability of every retried body.** `deleteGuardedRow` re-reads the row's stamp and
  re-signs per attempt, and Ed25519 is deterministic, so a retry re-presents a byte-identical
  signature — the handoff's "signatures are not re-minted" claim holds in substance.
  `mutateCadrePeer` notifies inside the retried body after a successful write, so a retried
  mutation notifies exactly once and an exhausted one never.
- **`withUseNumberRetry` composition.** Its `assertSeatRemains` guard keys off the *outer*
  attempt number, so an inner transient retry skips it — the fallback is the engine's own
  `CHECK constraint failed: Authorized`, the same non-retryable refusal the code already
  documents as safe. Not a defect.
- **Test coverage.** No spec drives the `execWrite` or `deleteGuardedRow` arms of
  `lockedWithRetry` specifically. Judged sufficient rather than filed: all six call sites
  funnel through one three-line method, the sweep above confirms the wiring, and the
  `mutateCadrePeer` arm is covered end-to-end including the notification count.
- **Source hygiene.** The new file is 195 lines, one exported classifier and one exported
  loop plus two small private helpers — no split warranted. `control-database.ts` is 2062
  lines (`wc -l`) and this change added 40 of them; its size is a standing condition, not
  something this ticket moved meaningfully.

### Known gap carried forward, unchanged

The classifier still matches literal engine error text rather than typed codes, and every
spec constructs those strings by hand. It fails closed (a rewording disables the retry, it
does not cause a false one). `tickets/implement/21-control-write-retry-real-error-coverage.md`
exists and owns closing it — the handoff asked whether it needed filing; it does not.

## Validation

From `packages/cadre-core`, before this pass's comment edits:

- `yarn vitest run` — **84 files, 1342 passed, 1 skipped**, 121 s.
- `yarn typecheck` — clean (re-run after the edits, still clean).

Repo root: `yarn lint` — clean (run three times across the pass).
`packages/integration-tests`: `yarn typecheck` — clean after the header-comment edits.

**Not re-run after the comment edits:** the cadre-core suite. The linked `../quereus`
workspace has uncommitted in-flight edits from concurrent work, so cadre-core's stale-build
guard now refuses to start (`@quereus/quereus: dist is stale`). Rebuilding that workspace
would bake someone else's partial changes into its `dist`, so it was left alone. The edits
made after the green run are comments only, in one source file plus two test-scenario
headers, and both typechecks pass over them.

**Not run:** the `integration-tests` package — out of scope per the original ticket and owned
by `control-write-retry-real-error-coverage`.
