description: One slow-link test used to be marked "expected to fail", which turned the build red whenever it happened to succeed. It now accepts either result — the write reaching the other machine, or a refusal that names exactly why — so the build stops flapping while the underlying slowness stays tracked elsewhere.
architecture: docs/network/deadlines.md#limits-and-accepted-tradeoffs
files: packages/integration-tests/src/scenarios/joiner-first-commit-over-slow-relay.integration.ts, docs/contributing/topology-coverage.md, tickets/blocked/decide-link-deadlines-from-measured-response-time.md
----

## What changed

The frame-capped arm of `joiner-first-commit-over-slow-relay.integration.ts` (every outbound WebSocket frame held 20 ms behind the one before it, event loop 70% busy) was `it.fails`. On Optimystic 1.29.0 the commit it expected to fail now lands in most runs, so the arm turned the build red at random. It is now a plain `it` that accepts either end of the race and pins each one.

**`runJoinerFirstCommit` gained one option, `refusalAccepted`,** set only by the frame-capped arm. The loopback and 100 ms arms do not set it and still require the commit, so a refusal there is a failure as before.

**`execOrShortfall`** runs the joiner's seat batch and returns the promise-round shortfall when the cohort refused it and `refusalAccepted` is on; every other failure, and every failure at all when the option is off, is re-thrown unchanged. It matches `PromiseShortfallError` by class over the whole `cause` chain, using the existing `errorChainLinks` harness helper. The class check works in practice — run 1 below caught the instance through the optimystic Quereus plugin's rewrap and Quereus' own — so the ticket's `name ===` fallback was not needed and is not in the code.

**`expectFounderSilentShortfall`** pins the one refusal the arm accepts: 1 approval of 2, 2 needed, 0 rejections, `silentPeers` exactly the founder's strand node, `soloRefused` unset. Anything else fails the arm.

**The committed path is untouched**: the joiner still stops the moment its commit returns, and every row of the commit must be readable on the founder afterwards. On the refused path the arm logs the fingerprint and ends; nothing was saved, so there is nothing to read.

**Comments and docs** now say what is true: the scenario header's third-arm paragraph, the `KNOWN FAILURE` comment above the arm, the `NOTE:` beside `FIRST_SYNC_MS`, and the "Not covered" column of this scenario's row in `docs/contributing/topology-coverage.md` (what is not covered is now a first commit that must land on the capped link). A dated section was added to `tickets/blocked/decide-link-deadlines-from-measured-response-time.md` recording the measurement as evidence on 1.29.0.

## How to run it

```
yarn workspace @serfab/integration-tests exec vitest run src/scenarios/joiner-first-commit-over-slow-relay.integration.ts -t "20 ms frame cap"
```

About 3.5 to 6 minutes. Run it more than once: which branch it takes is a race.

## What the arm verifies, and what makes it red

No test was added. The change rewrites one existing arm, and the arm now asserts strictly more than it did as `it.fails` (which asserted only that the body threw something), at the gate time it already cost.

| Outcome | What is checked |
|---|---|
| The commit returns | The joiner stops immediately; within `CONVERGE` every row of its three-table transaction is readable on the founder, and the founder's `Seat` holds exactly both sides. Unchanged from before. |
| The commit is refused | The failure chain carries a `PromiseShortfallError` with 1 of 2 approvals, 2 needed, 0 rejections, `silentPeers` exactly the founder's strand node, `soloRefused` unset. |

Each of these turns the arm red, which is the point of asserting on the fields rather than on the error class alone:

- a commit that reports success while the founder never sees the rows — the phone defect this scenario was written for, and the thing `it.fails` could not catch;
- a refusal that is not a `PromiseShortfallError` at all;
- a shortfall over a cohort that is not both members (`peerCount` or `needed` other than 2);
- a shortfall naming the joiner itself, or anyone but the founder's strand node, as silent;
- a member that actually rejected the write (`rejections` above 0);
- a lone coordinator's refusal to write alone (`soloRefused` set), which is a different situation and has its own arms in this file.

The other arms of this file are unchanged in behaviour but share `runJoinerFirstCommit`'s body, so a cheap way to confirm nothing moved for them is the loopback arm (`-t loopback`, the fastest in the file).

## What was run

- `yarn lint` (ESLint plus `yarn check:docs`) — clean.
- `yarn workspace @serfab/integration-tests typecheck` — clean.
- The frame-capped arm twice, one run per command, logs in `tickets/.logs/joiner-first-commit-either-outcome.run{1,2}.log` until the pruner ages them out:
  - **run 1 — refused, arm passed.** First sync 239.2 s; seat refused after 87.6 s with 1/2 approvals, needed 2, 0 rejections, silent the founder's strand node, `soloRefused` unset. The fingerprint matched the assertion with nothing adjusted.
  - **run 2 — committed, arm passed.** First sync 151.3 s; seat committed after 35.3 s; the founder held every row 0.0 s after the joiner stopped. Arm 209 s.

So both branches are exercised and both pass.

## Known gaps, honestly

- **Only the frame-capped arm was run.** The loopback, 100 ms, two restart and durability arms were not — the file's full run is hours, and the ticket said not to run the suite for this. Their behaviour is unchanged by construction (`refusalAccepted` defaults to false, so `execOrShortfall` re-throws exactly what `exec` threw), and run 2 exercised the committed path end to end including the founder-side row assertions. A reviewer who wants belt and braces should run the loopback arm.
- **The arm is now a weaker claim than "always commits".** A run in which the commit is refused is recorded rather than failing, so this arm is no longer a signal for whether the deadline defect has been fixed. The signal for that is the phone arm under "How to confirm" in `blocked/decide-link-deadlines-from-measured-response-time`.
- **The slower first sync is an observation, not an attribution.** Five runs on one loaded Windows machine measured 151 s to 239 s where the header had said "about 45 s". Nothing was traced; the figures are now in the file and a `NOTE:` says what to do if a run ever hits the 600 s gate.
- **One lead was not chased.** In both refused runs the joiner's strand node held TWO connections to the founder's strand node when its strand became writable; in all three that committed it held one. Two against three on five runs is a correlation, and no code site was named for it, so it is recorded as evidence in the blocked ticket rather than filed. If duplicate strand-node connections are real they would double the frames this link has to drain, which is that ticket's subject.
- **No new test, deliberately.** Nothing here is new behaviour of the product; the change is to what one gate asserts.

## Tripwires parked

- `NOTE:` above the frame-capped arm: the arm's first sync measured 151 s to 239 s against the 600 s `FIRST_SYNC_MS` gate, about 2.5x of margin. Fine today; if a run ever times out there, measure a series before raising the constant, because the cost is in the drop cycle and the saturated link.
- The `NOTE:` beside `FIRST_SYNC_MS` itself now carries the same measured range instead of the stale 45 s figure, and no longer refers to the arm as an `it.fails`.
