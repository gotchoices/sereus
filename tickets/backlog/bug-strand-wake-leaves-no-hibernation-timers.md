description: A strand woken by an explicit or peer-sent wake stays awake indefinitely unless the app happens to use it, and an on-demand service wake permanently ends a sleeping strand's periodic check-ins; both leave the strand without the timers that should put it back to sleep or check on it.
architecture: docs/architecture.md#strand-hibernation
files: packages/cadre-core/src/hibernation-manager.ts (wakeStrand, beginWake success path, clearTimersForWake, recordActivity's post-wake re-arm), packages/cadre-core/src/cadre-node.ts (wakeStrand, runServiceWake, handleStrandWake already-live branch), packages/cadre-core/src/strand-wake-protocol.ts (push-wake calls CadreNode.wakeStrand)
repro: static
severity: wrong-result
likelihood: normal-use
tradeoffs: The mobile runner drives hibernation itself and never relies on these timers, so the visible cost is limited to always-on and desktop nodes, where an awake strand costs a libp2p node and some traffic rather than failing anything.
----
# After a wake settles, the strand's timer cycle must match its resulting state

## Background

`HibernationManager` keeps two kinds of per-strand timers: the idle countdown (idle → hibernate) for a live strand, and the check-in chain for a hibernating one. Every wake first clears both (`clearTimersForWake`). What happens after the wake settles depends on who asked:

- **Activity-driven wake** (`recordActivity` on an idle or hibernating strand): after `beginWake` resolves with the strand `'active'`, it re-arms the idle countdown. Correct.
- **Explicit or peer-sent wake** (`CadreNode.wakeStrand` → `HibernationManager.wakeStrand`, used by the control-network push-wake receiver in `strand-wake-protocol.ts`, the formation wake and the founder `needs-resume` path): nothing re-arms the idle countdown after success. The strand stays `'active'` with no timer until something records activity. The same holds when `wakeStrand` is called on a strand that is already live: its running idle countdown is cleared and not restarted.
- **`serviceWake`** (mobile on-demand check-in cycle): its wake cancels an armed check-in chain, then its window re-hibernates the strand when no activity arrived, and nothing re-arms the chain. On a node that hibernates on timers (not the mobile runner, which force-hibernates with no chain), one `serviceWake` ends that strand's check-ins until the next idle-driven hibernation.

A failed wake already restores a cancelled chain (`restoreCheckInChain`, added by `ticket(implement): bug-strand-resume-double-build-and-stuck-error`), and a check-in that leaves the strand live restarts the idle countdown (`rearmIdleAfterCheckIn`). This ticket is the success-path counterpart.

## Expected behaviour

When a wake settles, the manager leaves the strand with the timers its state calls for, whoever triggered it: a live (`active`/`syncing`) strand with a finite idle timeout has its idle countdown running; a strand that is `'hibernating'` again and had a check-in chain before the wake has that chain re-armed; a strand force-hibernated without a chain (the mobile background path) gains none.

The natural site is `HibernationManager.beginWake`'s settle path, which already restores the chain on failure; the activity-driven re-arm in `recordActivity` would then fold into it. `serviceWake`'s re-hibernation happens after the wake settles (its window runs after), so its chain restore needs either a hook the window's end can call or a manager entry point for "re-hibernated after a probe".
