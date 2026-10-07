description: Let the cadre-host web page show which shared data networks (strands) each hosted node is serving for its cadre. The page that used to show this asked the host's own owner node, which no longer exists.
files: packages/cadre-host/src/orchestrator/host-process-orchestrator.ts, packages/cadre-host/src/server/routes/nodes.ts, packages/cadre-host/ui/src/routes/NodeDetail.svelte, packages/cadre-cli/src/server/admin-server.ts, docs/cadre-host.md
tradeoffs: It needs a loopback admin channel on every hosted node (an admin port per node, which `cadre-host-remove-founder-role` dropped), and the view is read-only, since a hosted node is not an owner and cannot sign a strand removal; a maintainer may prefer the owner app to be the only place strands are managed.
----

# Read-only strand view per hosted node

`cadre-host-remove-founder-role` deleted the Strands page and `StrandService`, because they asked the host's own owner node over its admin channel, and the founder role is gone. A hosted node still replicates its party's `Strand` table and runs a storage replica of each strand (`storage` profile), so "which strands does this node serve, and are they running" is answerable from the node itself: `GET /admin/strands` on cadre-cli's admin channel lists from the control database with the running instances overlaid, and needs no owner key.

## What to build

- Give every hosted node an admin port (`--admin-port`, bearer `CADRE_STARTUP_TOKEN`, loopback only), as the owner node had.
- `GET /api/nodes/:id/strands` in cadre-host, forwarding to the node's `GET /admin/strands`; `503 node_unavailable` when the node is down.
- A "Strands this node serves" card on the node detail page: id, open or closed, running, status. No removal: that is an owner-signed delete, done from the owner app (`remove-a-device-or-app-from-a-cadre` and the strand tickets own that side).

## Use case

An operator whose basement node seems idle wants to confirm it is actually hosting the family's strands, without opening the phone app.
