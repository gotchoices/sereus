description: The self-hosted manager's local web UI can add and remove people from a party but has no screen for the shared networks the party belongs to, so an owner has to drop to the command line to leave one.
prereq: feat-strand-removal-cli
files: packages/cadre-host/src/server, packages/cadre-cli/src/server/admin-server.ts, packages/cadre-core/src/cadre-node.ts
difficulty: medium
----

# Owner-facing screen for leaving a shared network

## Why

Removing one of the shared networks a party participates in is an owner-only, irreversible
control-plane action. The command-line path lands in `feat-strand-removal-cli`
(`cadre strand remove <id> [--yes]`). The self-hosted manager (cadre-host) already gives an
owner a local web UI for the comparable membership action — removing a peer from the party —
so an owner who never opens a terminal currently cannot leave a shared network at all.

## What is missing

Owner actions run *inside* the cadre node, not in the manager process; the manager reaches
them over the loopback management channel (`packages/cadre-cli/src/server/admin-server.ts`,
which is how the trust-circle UI's peer removal already works). There is no strand resource on
that channel at all — no list, no delete. So this needs:

- a strand resource on the admin channel (list the party's strands; delete one), delegating to
  the node methods,
- a manager-side screen listing them with an explicit confirmation step,
- confirmation strong enough for the closed-network case, where the row holds a secret that is
  stored nowhere else and cannot be recovered — the same consequence the command line gates
  behind an explicit flag.

## Notes for whoever picks this up

- Removal takes effect party-wide but only removes *our* party's participation; the other
  parties in that network are unaffected. The UI wording has to make that distinction, or an
  owner will read the button as "delete this network for everyone".
- A removal that commits while the node has no connections to its siblings may not reach them
  when they return. The UI must not promise more durability than the layer beneath delivers —
  see "Delete-while-alone durability" in `docs/architecture.md`.
