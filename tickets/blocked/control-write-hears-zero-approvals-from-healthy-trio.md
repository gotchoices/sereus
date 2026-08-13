description: On a three-machine party where nothing is broken, a control write sometimes gets no votes at all from the other machines and fails, and retrying it right away fails the same way. The cause is in the networking library this project depends on but does not edit, so someone needs to decide how to proceed.
prereq:
files: packages/integration-tests/src/scenarios/control-write-degraded-cohort-member.integration.ts, packages/cadre-core/src/control-write-retry.ts, docs/architecture.md, tickets/.pre-existing-known.md
repro: verified
difficulty: hard
----

# A healthy trio's control write hears zero approvals

**Blocked on `../optimystic`.** The cause is found, measured, and filed upstream as
`../optimystic/tickets/fix/lost-conflict-race-abstains-and-orphans-the-block.md`.
Nothing in this repo can fix it; what a human has to decide is whether to ship an
interim mitigation here while that lands (options at the bottom).

## What happens

A control write on a three-node party must be approved by all three machines
(`ceil(3 × 0.75) = 3`). In this failure the write is refused with

```
Failed to get super-majority: 0/3 approvals (needed 3, 0 rejections)
```

— **zero** approvals and **zero** rejections. Nobody voted either way, including the
two healthy machines and the writer's own coordinator. The control-write retry
re-presents the write twice more inside its 10 s budget and gets the identical
`0/3` each time, so the write is lost and the caller sees the failure.

It strikes the cases in `control-write-degraded-cohort-member.integration.ts` where
**nothing is degraded** (the healthy trio) or where the third machine only answers
2 s late — cases that otherwise commit in ~1 s and ~55 s.

## The cause (measured 2026-08-12, no longer a hypothesis)

Reproduced at sereus HEAD `378a1f9` against optimystic HEAD `12f4fe4` by running the
healthy-trio case alone under `DEBUG='optimystic:db-p2p:cluster*,sereus:cadre:control-db'`
— 1 red in 3 runs. The full trace and line-level analysis are in the upstream
ticket; the short version, in four steps:

1. Three writers hit the same block within milliseconds — the owner's row insert
   plus **both** members' ordinary self-registration refreshes, which fire on
   libp2p address-change events and are nothing the scenario stages. One of the
   three loses the optimistic-concurrency check and is rejected `stale-revision`.

2. Its coordinator gives up and tells the members nothing. All three members are
   still holding that transaction, and the only thing that clears it is a fixed
   **2 s** staleness sweep. Measured ages when it finally cleared: 2101 / 2102 /
   2110 ms.

3. For those 2 s the abandoned transaction wins the conflict race against every
   new write to that block (the race prefers whichever transaction has more votes,
   and the abandoned one has some while a fresh arrival has none) — and a member
   that loses that race **returns no vote at all**, neither approve nor reject.
   That is why the coordinator counts `0 approvals, 0 rejections`: it cannot tell
   "three members declined in favour of another write" from "nobody answered".

4. It sustains itself. Each blocked attempt is itself a transaction that some
   member voted on before another blocked it, so every failed attempt leaves a
   *fresh* 2 s blocker. The measured run piled up six in a chain, each blocking the
   next; our three retry attempts spanned 00.936 s → 02.385 s, entirely inside that
   window.

The earlier "progressive starvation" reading (approvals declining 2/3 → 1/3 → 0/3)
and the later "concurrent writers knock each other out" reading were **both** partly
right and are now one mechanism: concurrent writers are the trigger, an abandoned
pend is what does the blocking.

## Why it matters beyond the test

Nothing here is a test artifact. The colliding writes are the self-registration
refresh every node runs, and a real party does exactly this. Any party with write
concurrency on a hot block loses writes, with an error that blames the network.

## What this repo pays for it today

- Every attempt fails, so the write is lost.
- Because this failure is *fast*, all three retry attempts and their backoffs fit
  inside the 10 s retry budget, so the retry runs to exhaustion and adds a measured
  ~11 s to a write that was never going to commit. That is the retry working as
  specified, not a second defect.

## Decisions for a human

**Option A — wait for upstream.** Nothing to do here; the scenario stays
intermittently red and is already recorded in `tickets/.pre-existing-known.md`.

**Option B — widen the retry backoff past the blocking window.**
`CONTROL_WRITE_RETRY_DELAYS_MS` is `[250, 1_000]` in
`packages/cadre-core/src/control-write-retry.ts`, sized against sub-second stream
resets; every attempt therefore lands inside the upstream 2 s window. Delays above
2 s would let attempt 2 or 3 find the block free, and three attempts still fit the
10 s budget. Cheap, but it is a guess against another repo's constant, it slows
every genuine transient absorption, and it does not help the self-sustaining
pile-up (a rival's own retry can re-block the window).

**Option C — reduce the collision rate.** The self-record refresh republishes on
every libp2p address-change event, which is bursty during boot. Debouncing it would
cut how often three writers meet on one block. This is worth doing on its own
merits but is a probability reduction, not a fix.

**One thing to watch when upstream lands.** The likely upstream fix has a losing
member emit a *reject* vote instead of silence. `isRetriableControlWriteFailure`
matches the shortfall message **only with a zero rejection count**
(`SUPER_MAJORITY_SHORTFALL_UNANSWERED` in `control-write-retry.ts`) — precisely so a
real "no" is never re-presented. A conflict rejection would then read as a real
"no" and the retry would stop engaging on a class that is genuinely retryable. The
upstream ticket's TODO says to settle the message shape with this repo; whoever
picks that up owns the matching classifier change here.

**Update 2026-08-12 — upstream fix has landed** (optimystic tickets
`abandoned-pend-holds-the-block` and `2-member-must-answer-a-lost-conflict-race`).
The shape this repo needs to know:

- The reject-vote concern above did **not** materialize. A losing member now signs a
  new third vote kind, `conflict`, which is *never* counted as a rejection. The
  super-majority shortfall message this repo's classifier matches was left
  **byte-identical** (there is a NOTE at the throw site in optimystic's
  `cluster-coordinator.ts` naming this repo's matcher as the reason), so
  `SUPER_MAJORITY_SHORTFALL_UNANSWERED` keeps working for the genuinely-silent
  cohort and its rejection count stays uninflated. **No classifier change is
  required here.**
- The ordinary lost-race path no longer produces an error at all: optimystic's
  `CoordinatorRepo.pend` converts the loss into a retryable
  `StaleFailure { conflict: true }`, which its own sync/pend layers retry natively
  before anything reaches this repo's control-write retry.
- A new typed error `ConflictRaceLostError` (exported from `@optimystic/db-p2p`,
  name `'ConflictRaceLostError'`) exists for paths other than pend. It is
  retryable by definition — if it ever shows up in this repo's failure logs, it
  should be classified as retryable, but no matcher is needed pre-emptively.
- The self-sustaining 2 s pile-up is addressed at both ends: an abandoned dead
  transaction is broadcast so members clear it immediately, and a losing write is
  answered instead of silently blocked.

The healthy-trio scenario (≥ 5 runs of
`control-write-degraded-cohort-member.integration.ts`) is the end-to-end gate for
unblocking this ticket — the upstream repo could not run it from there.

Do not "fix" this by loosening the scenario's assertions.
