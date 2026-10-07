description: Reframe cadre-host around one action, "Join a cadre": the host starts a node and shows a QR code, the owner's phone scans it and claims the node. Remove the grant-token system, which let token holders ask the host to spawn nodes on demand.
prereq: node-claim-cli-and-scenario, cadre-host-node-reachability, cadre-invitations-redeemable-by-any-member
files: packages/cadre-host/src/donation/, packages/cadre-host/src/owner/, packages/cadre-host/src/installer/, packages/cadre-host/src/server/routes/grants.ts, packages/cadre-host/src/server/routes/grants-admin.ts, packages/cadre-host/src/server/routes/provision-request-validation.ts, packages/cadre-host/src/server/routes/bootstrap-node-validation.ts, packages/cadre-host/src/bin/, packages/cadre-host/ui/, packages/cadre-host/README.md, docs/cadre-host.md, docs/architecture.md
difficulty: hard
----

# cadre-host: "Join a cadre" replaces grants

## Product decisions (settled with the project owner)

- The realistic case: you start a cadre on your phone and add the always-on machine in your basement to it. That is the primary flow.
- Setup is out of band and happens once. The host does **not** listen for requests to provision nodes.
- **The host shows the QR** and the phone scans it, because the phone cannot be dialed and the QR has to carry the node's addresses.
- The node must be reachable from outside the LAN (automatic mapping or a manual forward); otherwise it is not doing its job.
- **Grants are dropped.** To put up a node for a friend, run "Join a cadre" again and let the friend scan it. The node belongs to whoever claims it.
- **Owner signing stays on user-held devices** (phones, hardware keys such as a YubiKey), never on a server. cadre-host therefore never holds an owner key and never founds a cadre: a cadre always starts on a phone, and the host joins it. The founder role is removed.
- A hosted node is **not** an owner. Owner authority stays on the phone, and the owner app is the admin for adding devices (`app-joins-existing-cadre-by-invitation`).
- Hosted nodes run the `storage` profile, so they host every strand of the party and answer formation for it while the phone is offline. Serving the cadre's strands to external parties is the point of the node.

## What to build

- **Join flow.** `cadre-host join` and a UI "Join a cadre" button spawn a node in unclaimed mode (`node-claim-protocol`) with a fresh claim secret, resolve its public addresses (`cadre-host-node-reachability`), and show a QR code plus copyable text: `{ peerId, multiaddrs (public tcp + ws, then LAN), claimSecret }` in a versioned encoding (e.g. a `sereus-join:` URI). The CLI prints the text and a terminal QR.
- **Join by invitation** (a second way in, for a cadre that already has a reachable member). The UI and CLI also accept a pasted cadre invitation (`cadre-invitations-redeemable-by-any-member`, e.g. one the owner app copies). The host spawns a node and has it redeem the invitation at the members the invitation names. No claim secret is needed: the invitation carries the owner keys the node pins, and members admit the node on the invitation's signature. This fails with a clear message when no named member is reachable (the usual case for a cadre's **first** always-on node, whose only member is a phone), and the UI then points to the QR claim.
- Live claim state: waiting → claimed (party id) → syncing. An unclaimed node can be cancelled; it does not expire, because nobody can claim it without the secret.
- **Hosted nodes.** The host runs N nodes, each claimed into some cadre. Keep `DonationSupervisor`'s respawn rules and the stuck-provisioning reap; the stale-awaiting-seed reap goes away (an unclaimed node waits). Rename "donation" to "hosted node" throughout. Removing a node is a local admin action.
- **Remove grants**: `GrantService`/`GrantStore`, `/grants`, `/grants-admin`, `provision-request-validation.ts`, cadre-host's copy of `bootstrap-node-validation.ts` (cadre-provider keeps its own; drop the cross-reference comment there), the `cadre-host grant` CLI, the UI Grants page and `grants.json`. No migration: there is no backwards compatibility yet.
- **Remove the founder role**: `ownCadre.enabled`, the installer question and `--own-cadre`, the owner node and its admin-channel owner operations (`packages/cadre-host/src/owner/`), the interim "Adding a device to a host-founded cadre" route in docs/cadre-host.md (the trust circle itself is already gone), and the `role` field on `/api/status`. The host has one kind of node: hosted nodes, joined by QR. `/nat/*` is always mounted. Check what else uses `cadre-cli start --owner` before touching it; cadre-cli is out of scope here (see the backlog ticket on owner keys held only by user devices).
- **Docs.** Rewrite docs/cadre-host.md around this model (remove "Two roles", the founder sections, "Adding a device to a host-founded cadre" and "Node admin channel"; replace "Node donation", "Grant tokens" and "Reachability (loopback-only in v1)"); update architecture.md mentions of cadre-host grants (Which Side Dials, Provider Integration) and the README. Reword `tickets/blocked/decide-non-owner-machine-completes-a-pending-join.md`, which calls the always-on machine "a cadre-host grant".

## Edge cases & interactions

- Host restart while a node is unclaimed: the node comes back unclaimed with the same secret, peer id and ports, so a QR already shown stays valid. (Supervisor test.)
- The node is not yet reachable from outside: still show the QR (the LAN address works at home), with a clear warning.
- An invitation-joined node that respawns before its redemption completed retries the redemption; one whose invitation expired meanwhile ends in `error` with that reason.
- Respawn after claim keeps ports, so the cadre's stored addresses stay valid (existing rule).
- The secret appears only on the loopback UI/CLI and is never logged.
- Someone who photographs the QR code claims the node first: the host shows the claimant owner key's fingerprint once the node is claimed, and offers **Reset** (terminate the node, spawn a fresh unclaimed one with a new secret). The user's phone also sees "already claimed".
- Replacing a dead host is: remove the old node from the cadre (`remove-a-device-or-app-from-a-cadre`), then join a new one.

## TODO

- Join flow: service, routes, CLI, UI page with QR.
- Rename and trim the donation layer; delete grants.
- Rewrite docs.
- Integration test: `cadre-host join` → a phone-shaped claimant takes the payload string → claims → syncs, and the connection survives a respawn. Replaces `cadre-host-donation-phone-requester.integration.ts` and `cadre-host-node-donation.integration.ts`.

## Note from planning `cadre-invitations-redeemable-by-any-member`

That ticket chain deleted the cadre-host trust circle (service, store, routes, UI page, `invite`/`trust` CLI commands) because its only mechanism (`createInvite`/`acceptPhone`) was removed, and added `cadre start --invitation <encoded>` for "join by invitation" (both landed). Plan the rest of the founder-role removal on top of that.
