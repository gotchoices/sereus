description: A machine joining a shared workspace was given only thirty seconds to receive that workspace's data, which is less than a phone on a slow relayed connection needs, so joins that were working were reported as failures; the wait is now two minutes, the measurement behind that number lives in one place, and a way the waiting loop could quietly die was fixed.
architecture: docs/strands.md#joining-no-writes-before-the-first-sync
files:
  - packages/cadre-core/src/strand-first-sync-gate.ts (DEFAULT_STRAND_FIRST_SYNC_TIMEOUT_MS 30_000 -> 120_000; doc comment rewritten; `StrandFirstSyncGate.probeHeld` added)
  - packages/cadre-core/src/types.ts (CadreNodeConfig.strandFirstSync doc)
  - packages/cadre-core/test/strand-first-sync-gate.spec.ts (one comment updated; one test added for a throwing probe)
  - packages/integration-tests/src/harness/node-fixtures.ts (stale "default 30 s" in the harness option's doc)
  - packages/integration-tests/src/scenarios/relay-round-trip-measure.integration.ts (stale "default 30 s first-sync gate" comment)
  - docs/strands.md ("Joining: no writes before the first sync", the addStrand bullet)
  - docs/reference-app-rn.md (paragraph beside the widened ping deadline)
  - .release-notes.pending.md
----

# The joining machine's first-sync wait is 120 s

## What landed

A machine that has never held a strand's data must not write to it, so `CadreNode.addStrand` withholds the strand database until the strand's rows arrive from another member, and rejects retryably with `StrandAwaitingFirstSyncError` if they have not arrived in time. That budget, `DEFAULT_STRAND_FIRST_SYNC_TIMEOUT_MS`, was 30 seconds — inside the run-to-run spread of a first sync over a relayed slow link, so roughly half of those joins were refused while the sync was progressing normally and went on to complete. It is now 120 seconds.

Nothing else in the gate's behaviour changed: the probe, its 500 ms cadence, the retryable rejection, the `strand:writable` event and the founder/restart fast paths are as they were. The measurement behind 120 s — the machine, the link, both cohort-read-deadline bands, and what the larger budget costs — is stated once, in that constant's doc comment; every other place that names the number points at it.

The review pass also fixed a latent defect in the gate's probe loop (below) and four stale statements of the old 30 s figure.

## Review findings

### Checked

- **The implement diff read first, ahead of its handoff summary.** One constant, four documentation sites, one test comment.
- **Every caller that could now block for two minutes.** Re-did the grep independently across `packages/cadre-core`, `packages/integration-tests`, `packages/cadre-cli`, `packages/cadre-host`, `packages/cadre-provider`, `packages/quereus-plugin-sereus` and all three reference apps. `cadre-cli`, `cadre-host`, `cadre-provider` and the SQL plugin never call `addStrand` or `whenStrandWritable`, so no request handler can hold a connection open on an unreachable strand. Integration scenarios all pin their own budget (`relay-round-trip-measure` 120 s, `blind-relay-phone-to-phone-e2e` 60 s, `strand-chat-participants-converge` 5 s on its unreachable arm, the `strand-join` harness its own).
- **Whether any other place still names 30 s as this budget.** Grepped every `.md` and every `src` tree.
- **The RN doc's claim about `joinClosedChatStrand`.** Read `packages/reference-app-rn/src/chat-strand.ts` and `use-cadre.ts`: `joinClosedChatStrand` does await `addStrand` and then write the joiner's `member` role, and `use-cadre.ts:322` does refresh on `strand:writable`. The claim is accurate.
- **The arithmetic behind "roughly half".** Two of the four samples at the 1000 ms cohort read deadline (23, 27, 31, 41 s) exceed 30 s. Correct as stated. The 120 s choice clears the worst sample at the 5000 ms deadline (46 s) by about 2.6x, so it also covers the band that will be in force after `2-declare-cohort-read-deadline-for-relayed-phones` lands.
- **Whether a 4x longer wait makes the probe loop 4x more expensive.** It does not: `StrandFirstSyncGate` schedules the next probe only after the previous read settles, and the app-table half of the probe is skipped until the Header is held, so a joiner with no peer pays one failing read per interval, not one per declared table.
- **Whether `docs/testing.md` should carry the band.** Confirmed `2-declare-cohort-read-deadline-for-relayed-phones` names `docs/testing.md` → "Where measurements live" in its own `files:`, so the implementer's decision to leave that file alone was right. Not touched.
- **Lint, typecheck, build, tests.** All pass; commands and results below.

### Found and fixed in this pass

- **The probe loop could die silently, and this change made the resulting hang four times longer.** `StrandFirstSyncGate.probe` is fired as `void this.probe()`, and `strandFirstSyncComplete` guards its *reads* but not the `App` schema lookup that precedes them (`appTableNames` calls `schemaManager.getSchema` outside any `try`). A throw there escaped `probe()` as an unhandled rejection *and* left nothing scheduled, so the strand stayed gated for the whole budget and never recovered — the one failure a gate whose entire job is "wait and re-probe" must not have. Extracted `probeHeld`, which reports any such throw as "not yet" and logs it, matching the invariant the module's own doc comments already state. Pre-existing at HEAD, not introduced by the 30→120 change, but amplified by it. One test added (`a probe that throws outside the read guards reschedules instead of killing the loop`), verified to fail against the unfixed code with exactly the unhandled-rejection shape described.
- **Four copies of one measured band.** The implement pass restated the 23-46 s measurement in the constant's doc comment, `types.ts`, `docs/strands.md` and `docs/reference-app-rn.md`. `docs/testing.md` states the project's own rule for this ("Do not copy those numbers here; a second copy is a second thing to leave stale") and `docs/strands.md` even announced the constant's comment as the home before duplicating it anyway. Kept the constant's comment as the single copy; the other three now carry the qualitative claim and a pointer. `.release-notes.pending.md` keeps its figure — release notes are a frozen record, not a thing that goes stale.
- **The measured delay was stated without its mode.** The comment said "900 ms one-way per-frame outbound delay" with no mode. `docs/testing.md` is explicit that "a delay figure means nothing without its mode", and that reading a `serial` figure as latency is what made the upstream issue report a breaking point that does not exist. Named `pipelined`, said what that means, and pointed at the file and the doc section.
- **Two stale comments naming the old default.** `integration-tests/src/harness/node-fixtures.ts` documented the harness option as "(default 30 s)", and `relay-round-trip-measure.integration.ts` explained itself as widening "the default 30 s first-sync gate". Both now name the constant instead of restating a number they do not own. Two other 30 s mentions were checked and left alone — `cadre-node.ts:6743` is the revocation enforcer's poll and `strand-party-removal-via-formation-e2e.integration.ts:147` is the membership reconciler's, both genuinely 30 s.

### Recorded as a tripwire, not a ticket

- **The cost of 120 s is an accepted tradeoff, and it now says so in the greppable form.** The constant's comment already stated the cost (a strand with no reachable member takes two minutes to report instead of thirty seconds) and why it is bounded; the review re-tagged it `NOTE: accepted tradeoff` and gave it a revisit condition it lacked — *if the gate ever learns whether any other member is connected, "no peer at all" could be reported at once and this budget would only ever be spent on a sync actually in progress.* That is the invariant that would retire the tradeoff rather than re-tune it, so it is parked at the site for whoever next touches the gate rather than filed as speculative work.

### Not filed, with the reason

- **No ticket filed.** The one real defect found (the dying probe loop) was small enough to fix inline with its test, and the remaining findings were duplication and stale comments — all resolved here. Nothing reached the filing bar and nothing needed a decision from a human, so `blocked/` and `backlog/` are untouched.
- **No pre-existing test failure to report.** The suite is green at 139 files / 2274 passed / 1 skipped, so `tickets/.pre-existing-error.md` was not written.

### One correction to the handoff's own account

The implement handoff said every joiner-shaped `addStrand` call "passes `awaitFirstSync: false` or an explicit `timeoutMs`". That is true of the tests and integration scenarios but not of the apps: `reference-app-rn`'s `joinClosedChatStrand`, `reference-app-web`'s `joinViaInvitation` and `reference-app-ns`'s `joinChatStrand` all await the default. That is the intended target of the change rather than a missed path — those are exactly the joins that were being refused — but it means three app-level join actions can now sit for two minutes before reporting, not one, and only the RN doc says so. It is app-level UX in reference code, so nothing was changed for it; noted here so a future reader does not take the handoff's sentence at face value.

## What was run

- `yarn workspace @serfab/cadre-core typecheck` — exit 0.
- `yarn workspace @serfab/integration-tests typecheck` — exit 0.
- `yarn lint` — exit 0.
- `yarn workspace @serfab/cadre-core build` — exit 0.
- `yarn workspace @serfab/cadre-core test` — 139 files, 2274 passed, 1 skipped, exit 0.
- The new gate test run against deliberately unfixed code, to confirm it discriminates — it fails there with the unhandled rejection from `appTableNames`.

Integration scenarios were not run: they are the slow, opt-in ones, none of them depends on this default, and their wall-clock puts them outside what a ticket run should attempt.
