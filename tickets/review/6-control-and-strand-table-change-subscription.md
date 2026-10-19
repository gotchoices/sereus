description: Review the new way for cadre-core to be told that a control or strand table changed (locally or replicated in from another machine), which the idle pollers will use to wait for a change instead of re-reading on a timer (GitHub #50).
architecture: docs/architecture.md#table-change-subscriptions
files: packages/cadre-core/src/table-change-watch.ts (new), packages/cadre-core/src/control-database.ts (`watchTables`, `tableWatches`, `close`, `setMembershipChangeListener` doc), packages/cadre-core/src/strand-database.ts (`watchTables`, `tableWatches`, `close`), packages/cadre-core/test/table-change-watch.spec.ts (new), docs/architecture.md ("Table change subscriptions" under "Control Network Convergence")
----
# One change-subscription seam for control and strand tables — review handoff

## What landed

`packages/cadre-core/src/table-change-watch.ts`:

- `watchTables(db, tables, onChange, options): TableChangeWatch` — subscribes one Quereus `Database.watch` with a hand-built `full` scope (one watch per qualified `'Schema.Table'` name; a name without exactly one `.` throws, a missing table throws from Quereus). Options: `label`, `coalesceMs` (default `TABLE_CHANGE_COALESCE_MS` = 50), `backstopMs`, `onInvalidate`, `scheduler` (`TimeoutScheduler`).
- `TableChangeWatch` = `{ trigger(delayMs = 0), dispose() }`.
- `TableWatchRegistry` — small holder both database wrappers use: hands out watches, removes them from its set on `dispose`, `disposeAll()` for `close()`. Added so the two wrappers don't duplicate the tracking.
- `ControlDatabase.watchTables(...)` / `StrandDatabase.watchTables(...)` — `ensureInitialized()`, then the registry. `ControlDatabase.close()` calls `disposeAll()` as its first statement, before `await this.writeQueue`; `StrandDatabase.close()` calls it right after `unsubscribeCommits`, before any await.
- One sentence added to `setMembershipChangeListener`'s doc: only local writes notify there (awaited inside the write), and a replicated membership change reaches the gate through the control-cohort reconcile pass, which refreshes it. Worded to be true today (the pass refreshes on its timer cadence) and after `control-reconcile-woken-by-changes-reads-once` makes it change-driven.
- `docs/architecture.md`: new `#### Table change subscriptions` at the end of "Control Network Convergence" (what it hears, what it doesn't, scheduling, why consumers keep a backstop, why the membership listener stays separate), plus one sentence in that section's intro.
- Not exported from `index.ts`: every named consumer is inside cadre-core.

## How the scheduling is built (read this before reviewing the logic)

No clock is used. Every armed timer (the coalescing window, each `trigger` delay, the backstop) is a "wake" in one set. Whichever wake fires first starts the run, and starting a run clears every wake. That is how "an earlier pending run wins" is met without comparing due times. Consequences worth checking:

- A wake that fires during a run sets `rerun`; when the run settles, `rerun` arms one coalescing window. A change during a run arms the window directly (if none is armed); if that window has not fired by the time the run settles, it simply fires afterwards. Either way: exactly one follow-up.
- The backstop is armed at subscribe and at every settle, and is cleared at run start like any other wake, so it always counts from the last settle.
- A consumer's `trigger(backoffMs)` from inside its own failing `onChange` stays armed across the settle. A change that arrives before the backoff expires runs sooner and clears the backoff wake. This is "earlier wins" as the ticket specified it; flagging it because a consumer that wants a strict backoff floor would not get one.
- Wakes are objects (`{ handle }`), so the code does not rely on a `TimeoutScheduler` returning unique handles (the reconciler spec's fake returns a constant).
- `onInvalidate` is called after the window is armed, each call in its own try/catch (logged), so one throwing invalidation does not skip the others or the run. A thenable return is logged once per watch as misuse.
- The Quereus handler is `event => this.handleChange(event)`, which returns `undefined`; `handleChange` has no `await`. Verified by inspection, as the ticket asked.

## Tests (`packages/cadre-core/test/table-change-watch.spec.ts`)

Real in-memory Quereus `Database` (`declare schema Probe` with two memory tables) and a virtual-clock `TimeoutScheduler` written in the spec. The single-slot fakes in other specs could not hold several timers at once.

- *runs once for two commits inside the window, after invalidating each table by the name passed*: two inserts into two tables → one run, and `onInvalidate` received `['Probe.Thing', 'Probe.Other']` (the names as passed, not Quereus's lowercased keys). The second half is what `control-membership-rows-cached-until-changed` relies on.
- *runs exactly once more for any number of changes during a run*: run held on a deferred promise, one window expiring mid-run plus more inserts → exactly one follow-up after release.
- *starts no run after dispose, whether a change was pending or a run was in flight*: both arms in one test; the in-flight arm also calls `trigger()` after dispose and has a backstop set, to show neither re-arms.
- *lets the earliest of a trigger, a change and the backstop start the run, and re-arms the backstop from each settle*: **beyond the ticket's list.** Added because four consumers depend on the trigger/backstop rule and it has real branching. Cut it if you judge it over the bar.

Mutation-checked by hand: making a mid-run wake not set `rerun` fails the second test; not clearing wakes at run start fails the fourth.

Run: `yarn workspace @serfab/cadre-core test test/table-change-watch.spec.ts` (4 passed). Also ran `control-database-solo`, `control-write-lock`, `strand-founder-bootstrap`, `strand-instance-manager` specs (37 passed) since both `close()` methods changed; `yarn workspace @serfab/cadre-core typecheck` and `yarn lint` clean. The full cadre-core suite was not run.

## Known gaps / things to look at

- The wrappers are untested by design (ticket said so); their dispose-before-await ordering is by inspection.
- Nothing yet consumes the seam; consumer tickets (`strand-watcher-woken-by-control-changes`, `control-reconcile-woken-by-changes-reads-once`, `pending-join-runner-woken-by-changes`, `strand-revocation-enforcer-woken-by-membership-changes`, `control-membership-rows-cached-until-changed`) will be the first real use, including the first exercise against the Optimystic plugin's replicated-change events (double fire per local commit, first-touch arming).
- The `NOTE:`s the ticket named are at `watchTables`: an untouched table hears only local commits; Quereus silently disposes a subscription whose table is dropped or altered (revisit condition included).
- `docs/architecture.md`: the new subsection links "join backfill" to `#replication-cluster-size`, which is where the peer-join catch-up is described.
