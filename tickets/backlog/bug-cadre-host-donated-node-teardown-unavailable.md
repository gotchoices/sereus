----
description: When you cut off someone you had been lending computing capacity to, the machines you already lent them keep running on your computer and there is no supported way to shut them down.
files: packages/cadre-host/src/server/routes/grants-admin.ts, packages/cadre-host/src/server/routes/grants.ts, packages/cadre-host/src/server/routes/nodes.ts, packages/cadre-host/src/donation/donation-supervisor.ts, packages/cadre-host/src/donation/grant-service.ts, packages/cadre-host/README.md
repro: static
severity: wrong-result
likelihood: normal-use
tradeoffs: A maintainer could argue the donor can always stop the whole cadre-host service (or hand-edit `donations.json`) and that a proper admin teardown belongs with the wider WAN-reachability work, so it can wait.
----

# Revoking a grant cannot actually stop the nodes donated under it

## What a user expects

`cadre-host grant revoke <token>` is the "cut this person off" action. A donor who
revokes reasonably expects the capacity they were lending to stop being used — at
minimum, to have *some* supported way to reclaim it.

## What actually happens

Revoking blocks future requests, but every node already donated under that grant
keeps running, and all three plausible ways to stop one fail:

- **The grantee can no longer release it.** `DELETE /grants/:id` runs the same
  bearer gate as the rest of the grantee surface, and a revoked grant fails that
  gate with 403 (`grant-service.ts` `validate()` reports `revoked`; `grants.ts`
  `denyStatus()` maps that to 403). So the one documented teardown call stops
  working at exactly the moment the donor wants it used.
- **Stopping it from the local UI does not stick.** `POST /api/nodes/:id/stop`
  stops any node, including a donated one. The child exits, the orchestrator
  emits its state change, and `DonationSupervisor` — which holds the invariant
  *a non-terminal donation is expected to be running* — respawns it within
  milliseconds. The Nodes page therefore offers a control that silently undoes
  itself.
- **There is no admin teardown at all.** `DonationService.terminate` exists and
  is exported, but the only HTTP route that reaches it is the bearer-gated
  `DELETE /grants/:id`. `/grants-admin` handles issue / list / revoke only.

`grant-service.ts`'s own `revoke()` docstring already assumes the missing piece:
"Existing live nodes are **not** torn down here — that is a separate admin action
via the donation service's terminate." That admin action was never wired up.

## Root cause — one seam, two arms

Donated-node lifecycle is meant to be owned exclusively by the donation surface.
`routes/nodes.ts` already enforces that for `start` and `restart`, which refuse a
non-owner id with a 501 pointing at `/grants`. `stop` was left as "works for any
running node" and so contradicts the same invariant. Meanwhile the donation
surface itself has no host-side entry point. Both arms resolve at that one seam:

- Give the donor a real teardown path — a `/grants-admin` route (and matching
  `cadre-host grant`/UI affordance) that reaches `DonationService.terminate`,
  which writes the record `terminated` so the supervisor correctly stops caring.
- Make `POST /api/nodes/:id/stop` refuse a donated id the same way `start` and
  `restart` do, so no surface offers a lifecycle control it cannot honor.

Whether revoke should *cascade* into terminating that grant's live donations, or
stay a separate explicit step, is a product decision for whoever picks this up —
today's code comments assume "separate", and that is a defensible default.

## Confirming it

Nothing here was run; it is read from the code. An integration test against a
real donated child would confirm both arms: provision a node, `POST
/api/nodes/:id/stop`, and assert it is still down a few seconds later; then
revoke the grant and assert `DELETE /grants/:id` still terminates (or that some
admin route does).

## Note

`packages/cadre-host/README.md` previously told readers to stop such nodes from
the Nodes page or have the grantee release them. Both instructions were wrong;
the README now states the gap and links this slug. Correct the README when this
lands.
