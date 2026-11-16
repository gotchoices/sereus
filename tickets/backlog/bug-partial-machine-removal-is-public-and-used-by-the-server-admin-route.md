description: There are two ways to remove a machine from a party, and the older one removes only its membership record, leaving its push-notification address, the invitations it could use to come back, and its key in members-only shared databases; the server program's administration interface uses that older one.
architecture: docs/cadre/membership.md#removing-a-machine
files: packages/cadre-core/src/cadre-node.ts (`removePeer`, `removeMachine`), packages/cadre-core/src/seed-bootstrap.ts (`SeedBootstrapService.removePeer`), packages/cadre-core/src/control-database.ts (`removeMachine`), packages/cadre-cli/src/server/admin-server.ts (`DELETE /admin/members/:peerId`), packages/cadre-cli/README.md (Admin channel)
repro: static
severity: wrong-result
likelihood: unusual
tradeoffs: Eleven spec and scenario files call a `removePeer` (the node's, or the service method under it) for the bare row delete it is, no shipped command or user interface in this repository calls the admin route, and replacing either means choosing what an operator-facing removal should answer when the fuller removal leaves work pending.
----

# `removePeer` removes only the membership row, and cadre-cli's admin route calls it

## What is wrong

`CadreNode` has two public removals:

- **`removeMachine(peerId)`** is the documented one (`docs/cadre/membership.md` → "Removing a machine"). In one control transaction under one owner approval it deletes the machine's `CadrePeer` row, deletes its `DeviceToken` row, withdraws every live cadre invitation the machine could redeem to return (one targeted at it, or one it redeemed that has uses left), and writes a `PendingStrandPartyKey` row for each closed strand so the party moves to a membership key the removed machine cannot read. It refuses to remove this node's own machine and refuses on a node that is not an owner.
- **`removePeer(peerId)`** deletes the `CadrePeer` row and nothing else. Its comment says so and points to `removeMachine`.

The document gives the reason each extra write exists: "A removed phone must not be woken by push", "Without this a removed device could redeem a live invitation again", and "removal from the cadre alone would leave the machine a member" of each closed strand. A removal made through `removePeer` leaves all three in place.

**Arm 1, the reachable instance.** cadre-cli's admin server answers `DELETE /admin/members/:peerId` by calling `node.removePeer(id)` and returning `{ ok: true }` (`admin-server.ts`; the route is listed in `packages/cadre-cli/README.md` → "Admin channel"). An operator who removes a machine this way is told it succeeded. The machine's push token stays resolvable, an invitation it holds with uses left still admits it, and it keeps the party's membership key in every closed strand. No command in `packages/cadre-cli/src/commands` and nothing in cadre-host calls this route, so reaching it today takes a hand-made request carrying the start-up token.

**Arm 2, the standing hazard.** `removePeer` is a public method beside `removeMachine`, with the shorter and more obvious name. An embedder that picks it gets the partial removal with no error.

## Expected behaviour

Taking a machine out of a party has one public call, and it is the complete one. The admin route calls `removeMachine` and reports its result (removed rows, withdrawn invitations, and the closed strands whose key replacement is still pending), mapping `MachineRemovalRefusedError` to a refusal. The bare row delete either stops being public or carries a name that says it is partial.

## Evidence and confirmation

Read from the files above; not run. To confirm arm 1: on a party with a second machine that has registered a device token and redeemed a multi-use cadre invitation, send `DELETE /admin/members/<that peer id>` to a cadre-cli owner node, then read `DeviceToken`, the invitation's liveness (`listCadreInvitations`) and `listPendingPartyKeyRotations()`. The token row and the live invitation remain and no rotation is pending.

In-repository callers of `CadreNode.removePeer` other than the admin route are tests: specs under `packages/cadre-core/test` and two integration scenarios (`control-delete-while-alone-convergence`, `control-write-degraded-cohort-member`) that use it to produce a single guarded delete.
