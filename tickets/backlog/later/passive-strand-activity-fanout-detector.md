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

### Arm: none of this repo's always-on programs has any trigger, so stored push credentials send nothing

Found while the documentation was rewritten against the code; read from the source, not run.

The text above treats the explicit call as a working baseline ("a server that knows its own activity already fans out today"). That holds for a program that embeds cadre-core and makes the call itself. It does not hold for the three programs this repo ships to run an always-on node:

- `notifyStrandActivity` is defined in `packages/cadre-core/src/cadre-node.ts` and called from one place, `recordStrandActivity` in the same file. Nothing under `packages/cadre-cli/src`, `packages/cadre-host/src` or `packages/cadre-provider/src` calls either method.
- All three accept push credentials and hand them to the node: cadre-cli builds the notifier from its `push` block (`start-node.ts`), cadre-host stores them with `cadre-host push fcm|apns` and writes them into each hosted node's config (`host-process-orchestrator.ts`), and cadre-provider passes them to each container as `CADRE_PUSH`. Each node then builds a `PushFanoutService` that is never told about activity.

So an operator can configure FCM and APNs credentials on any of the three, see `cadre-host push status` report them, and no wake is ever sent, over the control network or through a platform push. A phone hibernated on request has no periodic check-in, so with no wake it stays down for a strand until the user opens the app. The package READMEs and `docs/strands/hibernation.md` ("Limits and accepted tradeoffs") now say this and name this ticket as the owner, which is why the finding is recorded here and not as a new ticket.

This changes what the ticket is for the shipped programs: for them the passive trigger is not an optimization over a working baseline but the only trigger they could have, since a headless node has no application layer to make the explicit call. A maintainer deciding whether this stays in `later/` should weigh it on that basis.

Two facts that have changed since the ticket was written, for whoever picks it up to check before relying on "not buildable today":

- A watcher on a strand table (`StrandDatabase.watchTables`, `Database.watch`) fires on a commit that this machine's own storage applies (`docs/strands/app-schema.md`, "Change notifications"). An always-on node runs the `storage` profile and stores the strand's blocks, so it may already have a local new-data signal without any upstream hook. Not verified: whether a storage replica with no sApp attached has a database to watch, and whether the watch fires for a commit the node only stores and did not originate.
- Optimystic's change-notification substrate is wired in as `CadreNodeConfig.strandReactivity` (`strand-reactivity.ts`), off by default, and cadre-host and cadre-provider nodes cannot be given the setting yet (`feat-cadre-host-and-provider-nodes-carry-strand-reactivity`).

Related setting, not a defect: `hibernation.enabled` is exposed only by cadre-cli. Nodes started by cadre-host and cadre-provider run with the timers off, so their own strands never hibernate.
