----
description: Hibernation releases no resources and check-in never queries the cohort
files: packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/hibernation-manager.ts, docs/architecture.md, docs/STATUS.md
----
Sereus's stated goal for strand hibernation is to save resources on idle strands while keeping them current through latency-hinted cohort check-ins, with three wake paths (local, check-in, push). The current implementation delivers none of the resource savings or check-in semantics it claims, and the docs overstate it as complete.

### Resources are never released on hibernate

`CadreNode.handleStrandHibernate` and `handleStrandWake` only mutate `instance.status` and emit `strand:hibernating` / `strand:waking` events (`packages/cadre-core/src/cadre-node.ts:478-498`). The libp2p node is explicitly left running — the code even carries a comment acknowledging it ("Optionally disconnect libp2p to save resources / For now we keep it connected but could stop it here"). The node is never stopped or quiesced on hibernate, nor recreated/reconnected on wake. As a result a "hibernating" strand holds the same open connections, transports, and memory as an active one, so the status transition is purely cosmetic and yields zero resource savings.

### Check-in is a no-op that never queries the cohort

`HibernationManager.scheduleCheckIn` installs a fixed-interval `setInterval` that only advances `instance.nextCheckIn` (`packages/cadre-core/src/hibernation-manager.ts:213-239`). The body carries a comment stating "In a real implementation, this would query the cohort for pending activity. For now, we just update the nextCheckIn timestamp." Consequences:
- A hibernating `archive`/`background` strand never observes new data produced by peers; it only "wakes" when external activity is recorded locally.
- The interval is fixed per latency hint — there is no exponential backoff (minutes → hours → days) as the strand stays idle.
- There is no push-wake path: a cadre member with incoming connectivity has no way to propagate a wake request to a hibernating peer over the control network.

### Documentation overstates the behavior

`docs/architecture.md:485-493` describes idle-strand behavior as disconnecting from strand peers, periodic check-in with exponential backoff (minutes → hours → days), check-ins that query the cohort for pending transactions, and a push-wake mechanism — none of which are implemented. `docs/STATUS.md` likewise should not present exponential-backoff check-in / hibernation resource release as complete. The docs and STATUS must be corrected to reflect actual behavior (status-flag-only hibernation, fixed-interval no-op check-in, no push-wake).

### Expected behavior

- Hibernation must actually reduce a strand instance's footprint: stop or quiesce the libp2p node (or otherwise release/close strand-scoped connections and transports) on hibernate, and rehydrate/reconnect on wake. The active vs hibernating distinction must correspond to a real difference in held resources.
- Check-ins must genuinely query the cohort for pending transactions/activity over the control network, on a backoff schedule that lengthens as idle time grows (minutes → hours → days), bounded by the strand's latency hint.
- A push-wake path must exist so another cadre member can signal a hibernating peer to come online, pull pending activity, and re-hibernate.
- `docs/architecture.md` and `docs/STATUS.md` must be brought in line with the real implementation as it lands (no claims of capabilities that are not present).

### Use cases

- An `archive` strand hibernated for days releases its libp2p resources and, on its backed-off check-in, contacts a cohort peer, discovers a batch of pending transactions, syncs them, and re-hibernates.
- A peer produces new activity on a `background` strand that a remote member is hibernating; the producer (or a relay with incoming connectivity) issues a push-wake so the hibernating member catches up without waiting for its next scheduled check-in.

### Related

Overlaps with the mobile-platform specs `tickets/backlog/3-mobile-background-service.md` (push-wake delivery, pause/resume primitives) and `tickets/backlog/later/3-mobile-resource-awareness.md` (resource-aware check-in scheduling). Those define mobile/RN-facing requirements; this ticket addresses the underlying `cadre-core` hibernation and check-in implementation that they depend on.
