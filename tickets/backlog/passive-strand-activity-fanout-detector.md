description: Passive Optimystic-level activity detector that auto-triggers the server push-wake fan-out with zero application involvement, removing the need for an explicit notifyStrandActivity/recordStrandActivity call
files: packages/cadre-core/src/push-fanout.ts, packages/cadre-core/src/cadre-node.ts
----

The server push-wake fan-out (`PushFanoutService`, shipped in `4.1-cadre-push-fanout`) decides *who*/*when* to wake hibernating mobile peers and how to deliver (direct control-network dial first, FCM/APNs fallback, per-`(peer,strand)` cooldown). Its **v1 trigger is explicit**: an always-on host/relay/sApp must call `CadreNode.notifyStrandActivity(strandId, reason?)` — or simply `recordStrandActivity(strandId)`, which now also drives the fan-out — when it observes activity on a participated strand. That fully serves a server/relay sApp that *knows* when activity lands (it is the layer doing pull-on-read).

This ticket captures the **enhancement**: a *passive* detector that fans out with **zero application involvement** — the fan-out self-triggers from the strand network itself, so even a generic storage/relay node with no app-level activity signal wakes hibernating peers when new transactions land.

### Why this is deferred, not active work

- It is **not buildable today** without an upstream Optimystic change. Optimystic syncs **pull-on-read** and exposes no repo-level "new transaction" / "commit received" / "block received" hook a participating node could subscribe to (`IRepo` is get/pend/commit/cancel only — the same constraint that forces the hibernation check-in to be a blind resume→probe, and that `hibernation-control-network-pending-precheck` runs into from the receiver side).
- The explicit trigger is a **correct, honest baseline** — this is an additive optimization over it, not a correctness gap. A server that knows its own activity already fans out today.

### Dependency (external workspace)

Requires Optimystic (`../optimystic`) to expose a commit/block-received (or pull-completed-with-new-data) hook on `IRepo` / the coordinated repo that a participating `CadreNode` can subscribe to. This is the gating prerequisite; there is no tess ticket for it yet, so it is named here in prose rather than as a `prereq:` slug. The picking agent should confirm the upstream hook exists (or scope it) before implementing the cadre-core side.

### Requirements / expected behavior

- When the upstream hook is available, a participating `CadreNode` subscribes to strand-network commit/block-received events and calls the fan-out's `notify(strandId, reason)` automatically — no `notifyStrandActivity`/`recordStrandActivity` call from the app required.
- The passive trigger reuses the existing fan-out policy unchanged (participation gate, debounce, per-`(peer,strand)` cooldown, direct-first/platform-fallback, stale-token expiry). It is a new *trigger source*, not a new fan-out.
- The explicit `notifyStrandActivity` seam **remains** — the two trigger sources coexist (an app may still call it; the detector is the zero-involvement path), and the debounce/cooldown already coalesce a strand woken by both.
- Must not regress the honesty guarantee: a passive trigger fires only on a *real* new-data signal from Optimystic, never on a speculative or connect-time event.

### Open questions for the picking agent

- What is the exact shape of the upstream Optimystic hook (event name, payload, per-strand vs global), and does it distinguish "new data for a strand this node participates in" from incidental repo traffic?
- Should the detector debounce/throttle at the subscription layer too, or rely entirely on the fan-out's per-strand debounce?
- How does this compose with the receiver-side `hibernation-control-network-pending-precheck` — both want a richer Optimystic activity signal; can one upstream hook serve both the sender (this ticket) and receiver (precheck) sides?
