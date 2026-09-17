description: When a machine joins a shared workspace, the last step of the join — recording that it is a member and which device it is — sits idle for a full half-minute before it runs, because the job that does it checks too early and then waits out its whole retry timer. Kick it when the workspace becomes usable instead, so the join finishes in about a second.
files:
  - packages/cadre-core/src/strand-instance-manager.ts (publishDatabase, buildStrandRuntime — the arming and the seam the kick belongs on)
  - packages/cadre-core/src/strand-membership-reconciler.ts (the loop, its cadence, `reconcile()`)
  - packages/cadre-core/src/strand-first-sync-gate.ts (why `instance.database` is absent at arming time)
  - packages/cadre-core/test/strand-instance-manager-membership.spec.ts (arming assertions live here)
  - packages/cadre-core/test/strand-membership-reconciler.spec.ts (loop/cadence assertions live here)
  - packages/integration-tests/src/scenarios/strand-chat-participants-converge.integration.ts (joiner at a shortened cadence — the workaround)
  - packages/integration-tests/src/scenarios/strand-formation-cross-party-seed.integration.ts (same workaround, same reason)
  - packages/integration-tests/src/scenarios/blind-relay-phone-to-phone-e2e.integration.ts (a joiner at the DEFAULT cadence — where an end-to-end gate belongs)
  - docs/strands.md ("Joining")
difficulty: medium
----

# The joiner's membership writes wait out a full reconciler interval

## What the burst was

`fix/joiner-sends-45-cluster-streams-25s-after-joining-a-strand` reported that a joining machine opens a burst of 45 `/cluster` streams about 25–30 s after joining a two-party strand, with nobody saving anything, in every run. Reproduced and attributed on 2026-09-17 (sereus `79a22d1`, optimystic dist as built for the measurement ticket, two parties over direct loopback connections, chat schema, closed strand, joiner writing nothing at all):

| Time after `addStrand` was called | What happened | `/cluster` streams |
|---|---|---|
| +1.1 s | `addStrand` resolved; the strand went `active` (the first-sync gate opened at +1.07 s) | 0 |
| +1.1 s → +30.0 s | nothing | 0 |
| +30.07 s → +30.31 s | one transaction: `insert into Strand.Member` + `insert into Strand.ConsumedInvite` (the staged invitation redeemed) | **27** |
| +30.31 s → +30.41 s | one statement: `insert into Strand.MemberPeer` (this machine's device binding) | **18** |
| +30.4 s → +45 s (and to +90 s in a second run) | nothing — the burst does not repeat | 0 |

45 streams, one burst, never again. The same window also carried 23 `/repo` streams (the deferred constraints' reads). The caller is `StrandMembershipReconciler` (`strand-membership-reconciler.ts`), and the stack under the first stream is optimystic's `ClusterCoordinator.executeTransaction` → `ClusterClient.update`, i.e. an ordinary commit.

So the writes are not spurious: they *are* the join. They are simply 29 seconds late.

## Why they are late

`StrandInstanceManager.buildStrandRuntime` arms the reconciler with `getDatabase: () => instance.database?.getDatabase()`. On a joining machine the first-sync write gate deliberately withholds `instance.database` until the strand's `Strand.Header` has arrived from a peer and every `App` table has been read once. The reconciler's `start()` kicks an immediate pass — which runs *while the gate is still closed*, finds no database, and returns "no live database this instant — next tick decides".

The gate then opens about a second later and publishes the database. Nothing tells the reconciler. Its next opportunity is the interval tick it armed at `start()`: `DEFAULT_REVOCATION_POLL_INTERVAL_MS`, 30 s. That interval is sized for *idling* (re-checking whether a member row has turned up), not for *finishing a join* — and the join's one chance to run early has already been spent on a database that did not exist yet.

The cost is not mainly the traffic. For ~29 s after the app is told the strand is writable, the joining machine has no `Strand.Member` seat and no `Strand.MemberPeer` binding — the two rows revocation enforcement and future admission control key on. Over a slow relay the burst itself also lands as tens of seconds of relay traffic at an arbitrary moment, long after the user thinks the join finished.

Four integration scenarios already shorten `revocationPollMs` (which the manager mirrors into the reconciler) to keep this ladder inside their wait budgets; two of them say so in as many words — "a fast retry keeps the 'invite row not replicated yet' ladder inside the wait budget instead of the 30 s production default". Those overrides are the workaround; this ticket is the cause.

## The change

**Arm 1 — kick the reconciler when its database appears.** `StrandInstanceManager.publishDatabase` is the single seam where a withheld database becomes available: the gate's `onHeaderHeld`, and the founder-bootstrap-through-the-gate path (`ensureFounderBootstrap`) both funnel through it, and it is already where `whenStrandWritable` waiters are resolved and `strand:writable` is announced. Run one reconciler pass from there (`reconcile()` — it chains on the loop's own tail, so it cannot overlap a pass in flight and needs no new concurrency reasoning).

Verified experimentally on 2026-09-17: with exactly that kick in place, the redemption transaction ran at +1.16 s and the binding at +1.41 s, and the following 40 s of quiet carried **zero** `/cluster` streams. Both membership rows were present on the joiner.

Note the ordering: on a launch that is *not* gated (a founder, a restart that already holds the Header) `publishDatabase` runs before the reconciler is constructed, so there is nothing to kick and the reconciler's own immediate pass already sees the database. Only the gated path needs the kick — which is also the path `publishDatabase` already distinguishes as `wasGated`.

**Arm 2 — a cadence that suits an unfinished join.** The kick alone still leaves one hole: if the post-gate pass fails (the `Strand.Invite` row has not replicated to the joiner yet, or the cohort is briefly unwritable), the next attempt is again a flat 30 s away. A joiner that has not reached its done state should retry on a short ladder that escalates toward the poll interval — e.g. ~1 s, 2 s, 4 s, … capped at `pollIntervalMs` — and drop back to the flat interval once it is merely idling (no member row and no staged invitation, which is the "waiting for someone to admit us" state the 30 s cadence was designed for). Keep the existing shape where a pass is scheduled only after the previous one settles.

Do not fix this by lowering `DEFAULT_REVOCATION_POLL_INTERVAL_MS`: that constant is the revocation enforcer's deny-set refresh cadence, mirrored into the reconciler, and shortening it makes every machine poll membership harder forever to buy a joiner one faster retry.

**Arm 3 (optional, measure before committing to it) — one transaction instead of two.** The redemption (`Strand.Member` + `Strand.ConsumedInvite`) and the binding (`Strand.MemberPeer`) are two commits, measured at 27 and 18 `/cluster` streams. `inStrandTransaction` already joins a caller-owned transaction, so the reconciler could open one transaction around both, and the schema looks willing: `MemberPeer.MemberExists` reads the LIVE `Member` table (not `committed.Member`), and `MemberPeer.Authorized`'s add branch only verifies a self-signature over the new row, so a `Member` row inserted in the same transaction should satisfy both. `Member.Authorized`'s invite branch still gets its same-transaction fresh `ConsumedInvite`. This was **not** measured — the experiment was abandoned because the sibling optimystic workspace had uncommitted in-flight edits and rebuilding it would have changed the code under test. Treat it as a hypothesis with a plausible schema argument, worth perhaps a third of the burst plus one commit round-trip; prove it with a test before keeping it, and drop the arm rather than force it if the deferred checks disagree.

The other half of the original ticket's question — "if a write stores a value that hasn't changed, skip it" — is already satisfied and needs no work: `registerMemberPeer` is insert-if-absent behind a scan guard, and the loop latches `done` and stops, which is why the burst never repeats.

## The `TornActionError` question, answered

The source ticket asked whether this job's writes, or `control-write-retry`'s classifier, would retry after a `TornActionError` — the error optimystic can raise on a concurrent strand insert where the row may have been saved anyway (until optimystic's `fix/concurrent-inserts-from-two-members-tear-and-some-torn-writes-land` lands). Checked; no change needed:

- **The control-write classifier does not claim it.** `isRetriableControlWriteFailure` matches exactly two message shapes — the transactor's `Some peers did not complete:` aggregate carrying a single-block `[block:` token, and a super-majority shortfall with zero rejections. A torn-action message ("… is torn at rev N — its log entry is stored but block(s) … do not hold that revision …") carries neither, so it is surfaced rather than re-presented. That is the safe direction.
- **The reconciler re-derives state instead of trusting the error.** Every pass starts from `isStrandMember`, and `registerMemberPeer` starts from its own existence scan. A torn write whose row actually landed therefore heals: the next pass sees the member row, burns the leftover invitation (`ConsumedInvite` alone) and proceeds to the binding. A torn write whose row landed but is not yet readable locally retries the insert, fails on the primary key, is classified as neither sealed nor dead, and retries again until the row reads back. No sereus code matches `TornActionError` by name, and none should.

Arm 2 makes those retries faster, which is the only interaction between this ticket and that upstream one.

## What to watch when it lands

The fix moves the membership writes from +30 s to ~+1.2 s, which puts them *concurrent with the app's first write* — the device shape `strand-chat-participants-converge` test 2 exercises deliberately (a joiner that writes its participant and message the instant `addStrand` resolves). In the verification run both succeeded, but these are now two concurrent commits from one machine to different collections, and the relay measurement ticket recorded concurrent strand inserts tearing under a `storage` joiner. Run that scenario, and prefer an assertion that the joiner's rows and the membership rows all converge over one that assumes a particular interleaving.

`backlog/bug-removed-party-cannot-redeem-its-way-back` is about the same class's other half — a reconciler that has latched `stoppedFlag` is never re-armed by a fresh formation. This ticket does not fix that (a kick cannot restart a stopped loop, by design), but whoever lands either should read the other: the entry point added here is the one that ticket would want re-used.

## TODO

- Kick the membership reconciler from `StrandInstanceManager.publishDatabase` on the gated path, so a joiner's redemption and binding run as soon as its database is published rather than on the next interval tick.
- Give the reconciler a short escalating retry ladder while it has not reached its done state, falling back to the configured poll interval once it is only idling; leave `DEFAULT_REVOCATION_POLL_INTERVAL_MS` alone.
- Unit-cover the kick in `packages/cadre-core/test/strand-instance-manager-membership.spec.ts` (a gated launch publishes → exactly one extra pass runs; a non-gated launch adds none) and the ladder in `packages/cadre-core/test/strand-membership-reconciler.spec.ts` against the injected scheduler. The existing case "a pass with no live database (quiesce race) simply waits for the next tick" stays true and should keep passing.
- Add one end-to-end gate at the DEFAULT cadence — no `revocationPollMs` override — that a joiner's `Strand.Member` seat and its own `Strand.MemberPeer` binding are both present within a few seconds of the strand becoming writable. `blind-relay-phone-to-phone-e2e` is the natural host (a real relay, default cadences, a joiner already brought up); keep the budget generous enough for a circuit and let the 30 s regression be what fails it.
- Re-check the four scenarios that shorten `revocationPollMs` (`strand-chat-participants-converge`, `strand-formation-cross-party-seed`, `strand-party-removal-via-formation-e2e`, `strand-removal-cuts-network`). The first two shorten it only for this ladder and should be able to drop the override or say why they still need it; the removal pair use it for the enforcer and are unaffected — do not touch those.
- Run `strand-chat-participants-converge` (both tests) and confirm the write-immediately device shape still converges now that the membership writes overlap the app's first write.
- Only then, if you want arm 3: try the redemption and the binding in one transaction, measure the `/cluster` count against the 27 + 18 baseline, and keep it only if the deferred constraints hold and the saving is real.
- Update `docs/strands.md` ("Joining") to say when a joiner's membership rows land relative to the strand becoming writable — the current text describes the gate but not this last step of the join.
