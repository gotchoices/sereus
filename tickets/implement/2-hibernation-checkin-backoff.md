description: Real cohort check-in on an exponential backoff schedule, replacing the no-op fixed-interval timer
prereq: hibernation-resource-release
files: packages/cadre-core/src/hibernation-manager.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/types.ts, packages/cadre-core/test/hibernation-manager.spec.ts, packages/cadre-core/test/cadre-node.spec.ts, docs/architecture.md, docs/STATUS.md
----

Today `HibernationManager.scheduleCheckIn` installs a fixed-interval `setInterval` whose body only advances `instance.nextCheckIn` (`packages/cadre-core/src/hibernation-manager.ts:213-239`, comment "we just update the nextCheckIn timestamp"). A hibernating strand therefore never discovers peer activity and never backs off. This ticket makes check-in (1) escalate its interval (minutes → hours → days) bounded by the latency hint, and (2) perform a **real** cohort check via a new `onCheckIn` callback that resumes the strand, lets it sync, and re-hibernates if still idle.

### Exponential backoff schedule

Replace the single `checkInInterval` with an escalating schedule. Keep `HibernationTimeouts.checkInInterval` (in `types.ts`) as the **base** interval and add a bounded backoff:

- Each successive check-in that finds **no** pending activity multiplies the delay by a factor (default 2), capped at a per-hint ceiling.
- A check-in that **finds** activity (the strand wakes) resets the backoff to the base on the next hibernation cycle.
- Ceilings reflect the architecture's "minutes → hours → days" intent and the latency hint: e.g. `interactive` base 30s → cap ~1h; `background` base 5m → cap ~6h; `archive` base 1h → cap ~3 days. Make the factor + per-hint cap configurable via `HibernationConfig` (extend `customTimeouts`/add a `checkInBackoff` knob) with sensible defaults in `HIBERNATION_TIMEOUTS`.

Mechanically: replace the fixed `setInterval` with a self-rescheduling `setTimeout` chain that recomputes the next delay from the current backoff multiplier. This also fixes the latent bug that `setInterval` keeps a fixed period regardless of how long the check-in body takes.

### Real cohort check-in action

Add an `onCheckIn(strandId): Promise<void>` callback to `HibernationCallbacks`. The self-rescheduling timer invokes it (awaiting completion before scheduling the next tick). `CadreNode` implements it as a **resume → sync → re-hibernate** cycle, reusing the quiesce/resume primitives from the `hibernation-resource-release` ticket:

1. Resume the strand (rebuild node + db, re-resolve cohort seed/mode).
2. Give the strand network a bounded window to connect to reachable cohort peers and pull pending transactions through the existing optimystic sync path.
3. If activity was pulled (or the app recorded activity during the window), the strand stays `active` and the idle/hibernate timers take over (backoff resets). Otherwise quiesce again and schedule the next, longer-delayed check-in.

**Design tradeoff (documented choice):** the cohort spans multiple parties and is reachable only over the **strand** network, while the per-party control network only connects this party's own cadre. A bespoke "is there pending activity?" pre-probe would need a strand head/version comparison that optimystic does not currently expose cheaply. So this ticket realizes "query the cohort for pending activity" via the resume-sync-rehibernate cycle (uses machinery that exists, never reports false "synced") rather than a fragile bespoke probe. A lighter control-network pre-check that avoids a full resume when a same-cadre peer already knows there is nothing new is a future optimization — park it in `backlog/` (it overlaps `tickets/backlog/later/3-mobile-resource-awareness.md` resource-aware scheduling).

**Open item to resolve during implement:** confirm whether resuming a strand node actually pulls pending cohort transactions on connect, or only on query, in the optimystic layer (`@optimystic/quereus-plugin-optimystic`, `coordinatedRepo` sync). If sync is pull-on-read only, the check-in window must trigger a representative read (or a sync API) to surface pending activity; identify and use the real sync hook rather than sleeping. If no such hook exists, document the gap honestly in the review handoff and treat the resume-as-reachability-check as the landed behavior.

### Docs

- `docs/architecture.md:492-511`: update "Idle Strand Behavior" / the latency-hint table so the check-in column describes the **base interval + backoff cap** and the resume-sync-rehibernate semantics actually implemented — no claim of a control-network pending-probe.
- `docs/STATUS.md`: flip the cohort check-in / backoff checklist item to reflect what landed.

### Key tests

- `hibernation-manager.spec.ts` (fake timers): after hibernating, successive no-activity check-ins fire `onCheckIn` at escalating delays (base, base×factor, …) capped at the per-hint ceiling; `nextCheckIn` advances accordingly; `onCheckIn` is awaited before the next tick is scheduled (a slow `onCheckIn` does not overlap). A check-in that leads to wake resets backoff to base on the next hibernation.
- `cadre-node.spec.ts`: `onCheckIn` resumes then (no activity) quiesces again, leaving the strand `hibernating`; when the mocked strand reports activity, the strand stays `active`.

## TODO

- [ ] Extend `HibernationConfig`/`HibernationTimeouts` (and `HIBERNATION_TIMEOUTS` defaults) with a backoff factor + per-hint cap; keep `checkInInterval` as the base.
- [ ] Replace the fixed `setInterval` in `scheduleCheckIn` with a self-rescheduling `setTimeout` chain that escalates delay per no-activity tick, resets on wake, and awaits `onCheckIn` before scheduling the next tick.
- [ ] Add `onCheckIn` to `HibernationCallbacks`; wire `CadreNode.handleStrandCheckIn` to resume → bounded sync window → re-hibernate-if-idle, reusing `resumeStrand`/`quiesceStrand`.
- [ ] Investigate the optimystic sync-on-connect vs sync-on-read behavior; use a real sync/read hook in the check-in window or document the gap.
- [ ] File a `backlog/` ticket for the control-network "no pending activity" pre-check optimization.
- [ ] Update `docs/architecture.md` check-in description + latency-hint table and `docs/STATUS.md`.
- [ ] Add the tests above; run `yarn workspace @serfab/cadre-core test` + typecheck/build, streaming with `tee`.
