priority: 3
description: Design the server-side push-wake trigger — an always-on cadre peer that detects strand activity and fans FCM/APNs pushes to hibernating mobile peers
prereq: cadre-device-token-registry
files: packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/strand-wake-protocol.ts, packages/cadre-host/src, packages/cadre-provider/src, schemas/control.qsql, docs/architecture.md, docs/STATUS.md
----
This is the **sender** half of mobile push-wake and the **automatic trigger policy** the parent `mobile-background-service` design called out as still-owned. The control-network transport (`pushWake`/`StrandWakeService`) and the on-demand `serviceWake` receiver exist; the mobile *receive* path and `DeviceToken` registry land in `mobile-push-wake-receive` / `cadre-device-token-registry`. What remains: *who* decides to wake a hibernating mobile peer, how they enumerate the peers to wake, and how they deliver the push when a direct libp2p dial can't reach a suspended phone.

This stays in `plan/` (not `implement/`) because three consequential design questions remain open and benefit from a focused design pass before code:

1. **Server placement.** Which component hosts the always-on detector + sender? Candidates: `@serfab/cadre-host` (self-hosted manager, the natural "always-on node" for a party), `@serfab/cadre-provider` (multi-tenant), or a thin reusable module in `cadre-core` invoked by whichever host runs always-on. Resolve toward a `cadre-core` `PushNotifier` abstraction (credential-injected) consumed by `cadre-host` by default, but confirm against how cadre-host currently runs its node and whether multi-tenant provider needs per-tenant creds.

2. **Credential provisioning.** FCM (server key / service account JSON) and APNs (auth key `.p8` + key/team IDs) credentials must be provisioned and stored per party/host. This has a human/infra component (create Firebase project, APNs key) — the design must specify config surface (env/secret store) and clearly mark the provisioning steps as out-of-agent. This is the main reason the work isn't yet an implement ticket.

3. **Activity-detection hook point.** Where does the server learn a hibernating mobile peer has pending activity it should be woken for? Options: hook the server node's strand-network activity (it participates in the strand and sees new transactions), poll, or piggyback on the existing `pushWake` call site (when a direct dial fails / peer is known-mobile, fall back to the platform push). Resolve the trigger source and the enumeration of hibernating mobile members (cross-reference `CadrePeer` + `DeviceToken` + strand membership).

### Design surface to resolve

- **Detector**: on the server's participating strand, detect new activity destined for cadre members who are (a) not currently connected to the strand cohort and (b) have a `DeviceToken`. Define "pending activity for peer X" precisely (per-strand high-water vs. per-member delivery cursor) and avoid waking peers that are already live.
- **Fan-out & dedup**: batch wakes per device; debounce repeated activity bursts into a single push (APNs/FCM rate-limit silent pushes); per-(peer,strand) cooldown so a chatty strand doesn't spam pushes.
- **Delivery**: `PushNotifier` interface with `fcm`/`apns` implementations; payload exactly the `strand-wake` contract from `mobile-push-wake-receive` (`{type, strandId, reason}`), high-priority/content-available.
- **Fallback ordering**: prefer direct `pushWake` (libp2p) when the peer is reachable; fall back to platform push only when the dial fails or the peer is flagged mobile/suspended. Define how "mobile/suspended" is known (presence of `DeviceToken` + absence of a fresh dialable control address?).
- **Stale-token handling**: FCM/APNs report invalid/unregistered tokens; on such a response the sender should clear/expire the `DeviceToken` (or signal the peer to re-register).
- **Failure semantics**: push send failures are best-effort; check-in wake remains the backstop. No retry storms.

### Edge cases to enumerate (for the eventual implement ticket)

- Peer with a `DeviceToken` but currently foreground/connected → skip platform push (would double-wake).
- Multiple strands active for one device in a short window → coalesce into one push (or minimal set), not one-per-strand.
- Token rotated between resolve and send → send fails with unregistered; clear and rely on next registration.
- Server not a member of the strand whose activity it sees (shouldn't push for strands it can't vouch) → gate on participation, mirroring `StrandWakeService` membership gating.
- Multi-tenant provider: credentials and device-token scoping must not cross party boundaries.
- Clock/cooldown state must survive server restart or be acceptably lossy.

### TODO (planning)
- [ ] Decide server placement (cadre-host vs cadre-core module + host) — inspect how `cadre-host` runs its always-on node
- [ ] Specify `PushNotifier` interface + fcm/apns impls and the credential/config surface (mark infra-provisioning steps out-of-agent)
- [ ] Resolve the activity-detection hook point and "pending activity for peer" definition
- [ ] Specify dedup/cooldown/batching policy and direct-dial-vs-platform-push fallback ordering
- [ ] Specify stale-token handling against the `DeviceToken` registry
- [ ] Emit implement ticket(s); split detector vs delivery if each is its own agent run
