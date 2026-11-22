description: One slow-link test was marked "expected to fail", but it now succeeds about two runs in three, so it turns the build red at random. Rewrite it to accept either result — a write that reaches the other machine, or a refusal that names the cause — so the build stops flapping while the underlying slowness stays tracked.
architecture: docs/network/deadlines.md#limits-and-accepted-tradeoffs
files: packages/integration-tests/src/scenarios/joiner-first-commit-over-slow-relay.integration.ts, docs/contributing/topology-coverage.md, tickets/blocked/decide-link-deadlines-from-measured-response-time.md
repro: verified
difficulty: medium
----

## What the investigation found

The defect the `it.fails` arm recorded is **not fixed**. It now happens in some runs and not others, and when it happens the fingerprint is byte-for-byte the one the arm's comment already describes.

Reproduced on 2026-11-21 against Optimystic 1.29.0, three runs of the arm alone with the arm temporarily switched to a plain `it` so a failing body prints its error (`yarn workspace @serfab/integration-tests vitest run src/scenarios/joiner-first-commit-over-slow-relay.integration.ts -t "20 ms frame cap"`; logs `tickets/.logs/joiner-first-commit-busy-loop.run{1,2,3}.log` until they are pruned):

| | first sync | the joiner's seat | arm | outcome |
|---|---|---|---|---|
| run 1 | 151.3 s | committed in 35.4 s, rows on the founder 0.0 s after the joiner stopped | 209 s | commits |
| run 2 | 231.6 s | refused | 353 s | refused |
| run 3 | 170.1 s | committed in 44.9 s, rows on the founder 0.0 s after the joiner stopped | 236 s | commits |

Run 2's refusal, in full:

```
PromiseShortfallError: Failed to get super-majority: 1/2 approvals (needed 2, 0 rejections)
Serialized Error: { approvals: 1, rejections: +0, peerCount: 2, needed: 2,
  silentPeers: [ '<the founder's strand node>' ], soloRefused: undefined }
```

That is the old cause: the cohort was both members (`peerCount: 2`), the joiner approved its own pend, and the founder's leg answered nothing inside the deadline. So the commit was refused in its promise round, nothing was saved, and the app was told — which is the behaviour the scenario's header already says the arm shows. Read with the ticket's own earlier record (4 of 6 runs committed), the arm now commits in **6 of 9 recorded runs on 1.29.0** and is refused in 3. The commit succeeding is therefore not a fix; it is the same race falling the other way more often, as Optimystic 1.28.0's silent-member grace and relay reservation renewal would be expected to make it.

**The root cause is already tracked and is not this repo's to fix.** It is the deadline that fires: the founder's answer is queued behind a saturated link, and a deadline counted in declared round trips gives up on it. That is `blocked/decide-link-deadlines-from-measured-response-time` (`docs/network/deadlines.md` → "Limits and accepted tradeoffs", the "No deadline adapts to a peer's measured response time" bullet), whose own measurements record this exact fingerprint on the joiner's seat. It waits on Optimystic and FRET releases.

**A retry is not the remedy.** Optimystic documents this refusal as not retryable by a write path: "every coordinator of the cohort meets the same silent members, so a re-read and re-pend fails the same way until they answer again" (`../optimystic/packages/db-core/src/network/promise-shortfall-error.ts`). The sibling scenario `strand-workload-on-a-phone-link` retries the joiner's seat for this reason and its measurements show second attempts failing too, so a retry-based arm would be slower and no more deterministic.

### Two other things seen, neither traced

- **The first sync is much slower than the header says.** The header states the joiner becomes writable "after about 45 s"; the three runs measured 151.3 s, 231.6 s and 170.1 s. The gate (`FIRST_SYNC_MS`) is 600 s, so there is margin, but the figure in the header is wrong by 3× to 5× and the margin is no longer the one the NOTE beside that constant assumes. Three runs on one loaded Windows machine is not a series, so this is an observation, not an attribution.
- **In the one refused run, the joiner's strand node held two connections to the founder's strand node** (`joiner strand connections:` lists that peer twice); the two runs that committed held one. One failure against two passes is a lead, not a finding. The `peer-join block catch-up … has failed 3 times in a row` warning appeared in all three runs, so it does not separate them.

## What to build

Make the arm deterministic by having it accept **either** outcome, and pin each one:

- If the commit returns, the arm keeps today's assertions unchanged: the joiner stops the moment its commit returns, and every row of that commit must be readable on the founder afterwards. That is the promise the scenario exists for — a commit that reported success must not live only on the machine that made it — and today's `it.fails` arm asserts nothing about it, because it requires the body to fail.
- If the commit is refused, the refusal must be exactly this one: a `PromiseShortfallError` over a cohort of both members (`peerCount` 2, `needed` 2) with no rejections, with the founder's strand node named in `silentPeers`, and `soloRefused` unset. Anything else — a different error class, a shortfall naming the joiner itself, a rejection rather than silence, or a commit that reports success while the founder never sees the rows — turns the arm red, which is what a gate is for.

Both branches log which one was taken and how long it took, as the arm already logs its steps, so a run's log says what the link did.

This is strictly more than the gate checks today, costs the gate-time the arm already costs, and cannot flap. It is a weaker claim than "always commits": a run in which the commit is refused is recorded by the arm rather than failing it, and the deadline defect behind the refusal stays on `blocked/decide-link-deadlines-from-measured-response-time`, where the fix will be measured.

### Alternatives rejected

- **Opt-in behind an environment variable**, as `strand-workload-on-a-phone-link` does for its phone arm. It stops the flapping, but it also takes the frame-capped link off the gate entirely, so nothing would catch a commit on that link that reports success while the founder never sees its rows — the original phone defect this scenario was written for.
- **`it.skip` naming the tracking ticket.** Same loss of coverage as opt-in, with no way to run the arm deliberately.
- **Leave it as `it.fails`.** It is red whenever the commit lands, which is now most runs, so `yarn check` cannot pass.
- **Retry the commit until it lands.** Rejected above: the refusal is documented as not retryable until the silent member answers.

### Asserting the error

`PromiseShortfallError` is exported from `@optimystic/db-core`, which this package already depends on, and its own doc comment says to test for the class rather than the message text (the text is matched by a downstream repository and is not the test's business). Prefer `instanceof`. If the instance does not survive the Quereus plugin boundary in practice, match `name === 'PromiseShortfallError'` together with the typed fields, and say in a comment why the class check was not used — do not fall back to matching the message.

## TODO

- Give `runJoinerFirstCommit` an option that says a named refusal of the joiner's first commit is an accepted outcome for this arm, and use it only from the frame-capped arm. The loopback and 100 ms arms keep requiring the commit.
- Wrap the joiner's seat `exec` so a refusal is caught and checked against the shape above, then end the arm; leave the committed path, the joiner's stop and the founder-side row assertions exactly as they are.
- Rename the arm to say what it now asserts (it either commits with its rows outliving the joiner, or is refused by name), and make it a plain `it`.
- Replace the `KNOWN FAILURE … kept as it.fails` comment above the arm with what is true now: the measured rate (6 of 9 runs on Optimystic 1.29.0 committed), the fingerprint when it is refused, and the ticket that owns the cause.
- Update the scenario header's third-arm paragraph: it still says the arm's first sync takes "about 45 s" and still describes the arm as an expected failure. Put the measured first-sync range in, and correct the NOTE beside `FIRST_SYNC_MS`, which refers to "the third arm's `it.fails`".
- Add a `NOTE:` at the arm recording the slower first sync as a tripwire: it is fine against the 600 s gate today, and if a run ever times out there, measure a series before raising the gate — the drop cycle and the saturated link are the place to look, not the constant.
- Update `docs/contributing/topology-coverage.md`: the row for this scenario says the not-covered column is "A passing first commit on the capped link: that arm is marked `it.fails`". What is not covered after this change is a first commit that must land on the capped link.
- Add a short dated section to `tickets/blocked/decide-link-deadlines-from-measured-response-time.md` recording this measurement as evidence on 1.29.0: the 6-of-9 rate, the fingerprint with the founder silent over a two-member cohort, and that the arm no longer requires the refusal.
- Run the arm at least twice (`-t "20 ms frame cap"`, about 4 to 7 minutes each) and confirm it passes whichever way the commit falls. Each run is well inside one command's limit; run them one per command.
- `yarn lint` and `yarn workspace @serfab/integration-tests typecheck`. Do not run the whole integration suite for this: the file is the only one touched, and the suite is hours.
