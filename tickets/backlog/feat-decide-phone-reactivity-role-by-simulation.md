description: Phones currently forward live change notifications to other subscribers, the same as servers. Run a simulation to decide whether phones should instead only receive notifications, weighing their battery and bandwidth against how quickly everyone else hears about changes.
prereq: node-roles-in-cadre-core
architecture: docs/architecture.md#node-classes
files: packages/cadre-core/src/node-roles.ts (NODE_ROLE_PRESETS.device.reactivity), ../optimystic/packages/db-p2p/src/testing/reactivity-mesh-harness.ts (per-node edge/core profiles), ../optimystic/packages/substrate-simulator, ../optimystic/docs/reactivity.md (Origination point, Per-cohort policy, Edge profile)
tradeoffs: Forwarding by every node is working today and its cost on phones has not been observed as a problem, so the simulation may only confirm the current default.
----

# Should phones forward change notifications?

`node-roles-in-cadre-core` adds `NodeRoles.reactivity` (`forwarder` | `subscriber`) and keeps `forwarder` as the default for both presets, which is today's behaviour. This ticket decides the default for the `device` (phone) preset.

## The tension

- **Against forwarding on phones:** a forwarder keeps a replay buffer and push state per watched collection and sends notifications to other subscribers, which costs a sleeping, metered device battery and data, and a phone that sleeps mid-fan-out delays everyone behind it.
- **Against subscriber-only phones:** a strand's announcing group is the storage group of a collection's tail block, and phones hold blocks by default (`strandCohortMember: true`). In a small strand most of that group may be phones. A subscriber-only member may decline registrations and may not announce the commits it coordinates; subscribers then fall back to the watch service's tail poll (20–30 s), so changes arrive later rather than being lost. `node-roles-in-cadre-core` records exactly what happens in this case; read its handoff first.

## What to measure

For party sizes typical of Sereus (2–4 machines per party, 2–5 parties per strand) and for a large strand (hundreds of phones, a few servers), with phones as forwarders vs. subscribers:

- time from commit to a subscriber waking, median and tail;
- share of wakes that came from the poll rather than a notification;
- notifications sent and bytes per phone per hour;
- the same with phones asleep a realistic share of the time.

Optimystic's `reactivity-mesh-harness` already accepts a per-node `edge`/`core` profile, which is the cheapest place to start; `substrate-simulator` for the large case. Either runs in `../optimystic`, so the run itself may need to be filed there.

## Outcome

A default for `NODE_ROLE_PRESETS.device.reactivity` with the measurements behind it recorded in `docs/architecture.md` § Node Classes. If the answer depends on strand size, say so: that would argue for a per-strand setting, which is a separate ticket.
