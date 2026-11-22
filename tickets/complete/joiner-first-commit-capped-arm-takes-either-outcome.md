description: One slow-link test used to be marked "expected to fail", which turned the build red whenever it happened to succeed. It now accepts either result — the write reaching the other machine, or a refusal that names exactly why — so the build stops flapping while the underlying slowness stays tracked elsewhere.
architecture: docs/network/deadlines.md#limits-and-accepted-tradeoffs
files: packages/integration-tests/src/scenarios/joiner-first-commit-over-slow-relay.integration.ts, docs/contributing/topology-coverage.md, tickets/blocked/decide-link-deadlines-from-measured-response-time.md
----

## What landed

The frame-capped arm of `joiner-first-commit-over-slow-relay.integration.ts` (every outbound WebSocket frame held 20 ms behind the one before it, event loop 70% busy) was `it.fails`. On Optimystic 1.29.0 the commit it expected to fail lands in some runs and not others, so the arm turned the build red at random. It is now a plain `it` that takes either end of the race and pins each one:

- **The commit returns.** Unchanged from before: the joiner stops the moment its commit returns, and within `CONVERGE` every row of its three-table transaction must be readable on the founder, whose `Seat` must hold exactly both sides. This is the promise the scenario exists for — a commit that reported success must not live only on the machine that made it — and the `it.fails` arm asserted nothing about it, because it required the body to fail.
- **The commit is refused.** The failure chain must carry a `PromiseShortfallError` with 1 of 2 approvals, 2 needed, 0 rejections, `silentPeers` exactly the founder's strand node, and `soloRefused` unset. Any other shape fails the arm: a different error class, a cohort that is not both members, a shortfall naming the joiner itself, a member that actually rejected the write, or a lone coordinator refusing to write alone.

Three small functions carry it. `execOrShortfall` runs the joiner's seat batch and returns the shortfall when the cohort refused it and the new `RunOptions.refusalAccepted` is on, re-throwing every other failure and every failure at all when the option is off. `describeShortfall` renders the refusal's facts for the run log and the assertion message. `expectFounderSilentShortfall` owns the fingerprint. Only the frame-capped arm sets `refusalAccepted`; the loopback and 100 ms arms still require the commit, so a refusal there is a failure as before.

The typed error is claimed by class over the whole `cause` chain through the existing `errorChainLinks` harness helper, which is what upstream's own comment on `PromiseShortfallError` asks for and what the production classifier `reportsUnansweredShortfall` does. It works through both rewraps in practice — four refused runs across the fix, implement and review stages caught the instance — so the ticket's `name ===` fallback was never needed.

Comments and docs were brought in line: the scenario header's third-arm paragraph, the comment above the arm, the `NOTE:` beside `FIRST_SYNC_MS`, and the "Not covered" column of this scenario's row in `docs/contributing/topology-coverage.md` (what is not covered is now a first commit that must land on the capped link). A dated section in `tickets/blocked/decide-link-deadlines-from-measured-response-time.md` records the measurement as evidence on 1.29.0.

No test was added, deliberately. The change rewrites one existing arm, which now asserts strictly more than `it.fails` did (which asserted only that the body threw something) at the gate time it already cost.

## Review findings

### Fixed in this pass

All four were source-hygiene findings against AGENTS.md → "One home per fact"; none changed behaviour, so the runs below cover the code as it stands.

- **The refusal fingerprint was written out three times** — in the scenario header, in the comment above the arm, and in `expectFounderSilentShortfall`'s doc, which is the one that actually enforces it. Three copies of a six-field assertion will drift. The header and the arm comment now point at the function instead of restating it.
- **The measured first-sync range was written out three times** — the header, the `NOTE:` beside `FIRST_SYNC_MS`, and a second `NOTE:` above the arm that said the same thing as the first. The duplicate arm `NOTE:` is gone; the header owns the range, and the constant's `NOTE:` owns the margin and what to do about a timeout.
- **Two comments retold the change's own history** rather than describing the code as it is: `FIRST_SYNC_MS`'s "not the order of magnitude the 45 s figure this NOTE used to carry implied", and the arm's "The arm was `it.fails` while the refusal was the usual outcome; it stopped being that". Both cut; what survives is the measured rate, which is the reason the arm is shaped this way.
- **`execOrShortfall`'s doc re-explained why a `cause`-chain walk is needed**, which `errorChainLinks`' own doc already owns, and credited the chain walk to `reportsUnansweredShortfall`, which consumes links rather than walking them (`causeChain` walks). Now cites both correctly and in a sentence instead of four.

### Checked and sound

- **The refused path's early `return` sits inside the `try`,** so the `finally` still stops both nodes and the relay and undoes the latency shim and the busy loop; `onTestFinished` still backstops a timeout. No leak.
- **`refusalAccepted` cannot leak into the other arms.** It defaults to false and `execOrShortfall` then re-throws exactly what `exec` threw, so the loopback, 100 ms, two restart and durability arms are byte-identical in behaviour. Confirmed by running the loopback arm.
- **The assertion matches the error class as built.** `PromiseShortfallError` assigns `soloRefused` only when defined, so the property is absent rather than `undefined`; `toEqual` ignores an `undefined` expected property, so the `soloRefused: undefined` arm of the assertion is correct and not accidentally vacuous. `silentPeers` is compared as an exact one-element array, which is right for a two-member cohort in which the joiner approved its own pend.
- **`founded.instance.libp2pNode!.peerId` is the founder's strand node, not its control node** — the same expression the arm already logs as `founder strand`. The comments' claim about which peer must be silent is accurate.
- **A `PromiseShortfallError` raised in the commit phase can mean the write landed** (`reportsUnansweredShortfall`'s doc says so, and the control-write funnel vetoes that case). It does not weaken this arm: rows reaching the founder is the outcome the scenario wants, so a commit-phase shortfall that the arm records as a refusal hides no defect.
- **Every number in the handoff and in the comments reconciles.** 4 of 6 prior runs + 2 of 3 fix-stage runs + 1 of 2 implement-stage runs = the 7 of 11 the implement stage claimed; the five first-sync figures and the three commit durations all trace to a named run. The rates are now 7 of 13 and the range 147 s to 239 s, with this pass's two runs folded in.
- **Documentation is current.** `docs/contributing/topology-coverage.md`'s row is the only place a scenario file is listed and it was updated. `docs/network/deadlines.md` → "Limits and accepted tradeoffs" (the ticket's anchor) describes the deadline rule and names only the owning ticket slug, so it needed no change. `docs/contributing/gates.md` keeps no registry of expected-failure arms, there is no entry for this arm in `tickets/.pre-existing-known.md`, and `.release-notes.pending.md` carries user-facing behaviour, which a test-only change is not. The one stale "about 45 s" left in the tree is in a historical measurement paragraph of `blocked/report-libp2p-websockets-buffered-amount`, which records what was true when that measurement was taken; left alone.

### Tickets filed

None. Nothing found reached the filing bar: the three findings about duplicated prose were cheap to fix inline, and the one latent concern below is conditional.

### Tripwires parked

- **`NOTE:` on `expectFounderSilentShortfall`:** that nothing was saved is Optimystic's documented contract for this refusal, not something the arm checks — it ends at the fingerprint rather than reading the founder back. A negative read is only as good as how long it waits, and a hold-down would re-introduce the flapping this ticket removed, so the note says to build a scenario for it if a refusal whose rows landed anyway is ever suspected.
- **The duplicate-strand-node-connection lead, strengthened, stays evidence in `blocked/decide-link-deadlines-from-measured-response-time`.** It now holds in 4 of 4 refused runs and 0 of 3 committed ones — seven for seven. Still not filed, because no code site in this repository can be named for it: the strand member redial (`strand-peer-redial.ts`) runs a round only when `memberConnected` finds no member connected, so it never dials a member it already holds, and a second connection is more likely the two strand nodes dialling each other at the same moment, which is below cadre. That reasoning is now in the blocked ticket so the next person does not repeat it.
- The two tripwires the implement stage parked (the `FIRST_SYNC_MS` margin, and the stale 45 s figure beside it) stand, consolidated into one `NOTE:` at the constant.

### Tests

No test added or removed. The arm is the test, and adding a case for the refused branch at any other layer would mock the link rather than exercise it. The only candidate for a new assertion — reading the founder back on the refused path — is parked as the tripwire above, because it would re-introduce the timing dependence this ticket existed to remove.

## What was run

- `yarn lint` (ESLint plus `yarn check:docs`) — clean, before and after the review edits.
- `yarn workspace @serfab/integration-tests typecheck` — clean, before and after.
- `-t loopback` — passed in 3.5 s (committed in 0.3 s, rows on the founder 0.0 s after the joiner stopped). This is the cheapest confirmation that the shared `runJoinerFirstCommit` body did not move for the arms that still require the commit.
- `-t "20 ms frame cap"` twice, one run per command, both **refused and both passed**, the fingerprint matching `expectFounderSilentShortfall` with nothing adjusted: first sync 146.8 s then refused after 87.3 s (arm 256 s); first sync 238.2 s then refused after 91.5 s (arm 351 s). Logs in `tickets/.logs/joiner-first-commit-review.{loopback,capped1,capped2}.log` until the pruner ages them out.

Both branches of the arm are therefore confirmed passing across the ticket's stages: refused in the fix stage's run 2, the implement stage's run 1 and both review runs; committed in the fix stage's runs 1 and 3 and the implement stage's run 2.

## Known gaps

- **Neither review run drew the committed branch,** so that branch was last exercised end to end in the implement stage. Its code is unchanged by this pass (every review edit is a comment), so the implement stage's run stands for it.
- **Only the loopback and frame-capped arms were run.** The 100 ms, two restart and durability arms were not: the file's full run is hours, and the ticket said not to run the suite for this. They share `runJoinerFirstCommit` and `refusalAccepted` defaults to false for them, so their behaviour is unchanged by construction.
- **The arm is a weaker claim than "always commits".** A run in which the commit is refused is recorded rather than failing, so this arm is no longer a signal for whether the deadline defect is fixed. The signal for that is the phone arm under "How to confirm" in `blocked/decide-link-deadlines-from-measured-response-time`, and the arm's comment now says so.
- **The slower first sync is an observation, not an attribution.** Seven runs on one loaded Windows machine measured 147 s to 239 s where the header had said "about 45 s". Nothing was traced; the figures are in the file and a `NOTE:` says what to do if a run ever hits the 600 s gate.
