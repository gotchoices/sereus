description: An app writing to a shared workspace cannot tell whether a change it just saved is held only on this device or also by another member, so it cannot warn the user ("not yet delivered") or keep a phone awake until the change has gone out. Pass that information through from the database layer once it provides it.
architecture: docs/strands.md#joining-no-writes-before-the-first-sync
files: packages/cadre-core/src/strand-database.ts, packages/cadre-core/src/cadre-node.ts (strand events), docs/strands.md (Joining → "Writable does not mean connected"), ../optimystic/tickets/plan/5.5-feat-sql-commit-durability-reaches-the-app.md (read-only)
tradeoffs: Depends on an Optimystic feature that is only planned (its plan ticket 5.5, GitHub optimystic#26), and an app can already approximate it by watching strand peer connections, so a maintainer may reasonably wait until an app asks for more than that.
----
# A strand commit's durability reaches the app

Sereus decided (`docs/strands.md` → Joining → "Writable does not mean connected") not to refuse or hold a write made while no other strand member is connected; such a write commits with Optimystic's `quorum: 'local'` and reaches the others when this machine next connects to one. The cost is that a machine which then stops for good — an app killed in the background, a phone lost — loses the write, and today nothing tells the app the write was held only locally. That is the case reported in gotchoices/sereus#44.

Optimystic computes each commit's durability (`WriteDurability`: `local` or `full`) and fires a per-block event when a `local` write becomes fully replicated, but drops both before the SQL layer; its plan ticket `5.5-feat-sql-commit-durability-reaches-the-app` (optimystic#26) carries them up to the Quereus plugin.

## What Sereus needs

- `StrandDatabase` exposes the durability of the app's last commit (or per commit, in whatever shape Optimystic's plugin settles on), and an event when a `local` commit becomes `full`, re-emitted on `CadreNode` with the strand id, like `strand:writable`.
- The reference apps show "not yet delivered" on a message whose commit was `local`, and clear it on the event.
- `docs/strands.md` names the API in the "Writable does not mean connected" bullet.

## Use cases

- A chat app marks a message sent while alone, and clears the mark once the other member holds it.
- A two-party app's first act after joining ("take your seat") keeps the phone awake, or warns before the user leaves, until the seat is held by the other side.
