description: Lightweight control-network pre-check so a hibernating strand can skip a full resume when a same-cadre peer already knows there is nothing new
files: packages/cadre-core/src/hibernation-manager.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/control-database.ts
----

Today (after `hibernation-checkin-backoff`) a hibernating strand's check-in is a **full resume-as-reachability cycle**: `CadreNode.handleStrandCheckIn` rebuilds the strand's libp2p node + `StrandDatabase`, holds it live for a bounded window so the strand network can connect and the app can drive pull-on-read activity, then re-hibernates if nothing surfaced. This is correct and uses only machinery that exists, but it is **expensive** — every check-in pays a node build + DB init + teardown even when there is demonstrably nothing new.

The expense is unavoidable *as a cohort query* because the cohort spans multiple parties reachable only over the **strand** network, and Optimystic syncs pull-on-read with no cheap repo-level "pull pending" / head-version API (`IRepo` exposes only get/pend/commit/cancel — confirmed during the backoff ticket). So a true "is there pending activity?" probe would need a strand head/version comparison Optimystic does not expose cheaply.

This ticket captures the **lighter pre-check**: before doing a full strand resume, ask the **control network** (the per-party network that already connects this party's own cadre — no strand resume needed) whether any same-cadre peer that *is* currently live on this strand has observed new activity. If a sibling cadre node is awake on the strand and reports "nothing new", this node can skip the resume entirely and just escalate its backoff. Only when no sibling can answer (or a sibling reports activity) does it fall back to the full resume cycle.

### Why this is a future concern, not active work

- It is a **performance optimization** layered on a correct baseline — the backoff check-in already lands and behaves honestly.
- It depends on cohort/liveness signals that are themselves still maturing (peer-record liveness, `fret-backed-peer-record-liveness`) and on a notion of "which of my cadre's nodes is currently live on strand X", which the control schema does not yet expose.
- It overlaps the resource-aware scheduling envisioned in `tickets/backlog/later/3-mobile-resource-awareness.md` (a device under battery/network pressure wants to avoid needless resumes); the two should be designed together so the pre-check and the resource policy share one decision point.

### Requirements / expected behavior

- A hibernating strand's check-in consults the control network for a cheap "pending activity?" answer from same-cadre peers **before** committing to a full strand resume.
- A confident "nothing new" answer lets the check-in skip the resume and escalate backoff exactly as a no-activity full check-in would (so the existing backoff/`nextCheckIn` semantics are preserved).
- An "activity" answer, or the absence of any answerable sibling, falls back to the existing resume → window → re-hibernate cycle (never report a false "synced").
- Must not regress the honesty guarantee: the pre-check is an *optimization gate*, not a replacement for the real sync; correctness still comes from the resume path.

### Open questions for the picking agent

- What control-network signal represents "a same-cadre node is live on strand X and has seen its latest activity at time T"? Does it need a new control schema surface (e.g. a per-strand liveness/heartbeat row), and how does that interact with `strand-membership-lifecycle-population` / peer-record liveness?
- How stale can a sibling's answer be before the pre-check must fall back to a full resume?
- How should this compose with resource-aware scheduling (`3-mobile-resource-awareness`) so there is a single place that decides "resume vs. skip" under both freshness and resource pressure?
