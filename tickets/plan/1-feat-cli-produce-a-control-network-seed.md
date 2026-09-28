---
description: To stand up a second machine you have to hand it a seed file, but nothing in the CLI can produce one — `cadre enroll` mints a different artifact and `--seed` only consumes. The one documented path out of this is an admin HTTP route, so a plain CLI operator has no way to grow a cadre past one node.
files: packages/cadre-cli/src/commands/enroll.ts, packages/cadre-cli/src/commands/start.ts, packages/cadre-cli/README.md
---

# The CLI can consume a seed but cannot make one

`cadre start --seed <file>` takes a `ControlNetworkSeed` — the artifact that breaks the
cold-start cycle for a joining node (see "Control Network Seed" in
[`docs/architecture.md`](../../docs/architecture.md)). Nothing in the CLI writes one.

What exists nearby, and why neither closes it:

- **`cadre enroll create`** mints a `CadreInvite`. Different artifact, different job — an
  invite carries pinned owner keys and a redemption token; a seed carries peer address
  hints and the rows a joiner needs to validate anyone. `--seed` will not take an invite.
- **`cadre strand`** is list/remove only.
- **The admin surfaces** (`/admin/invites` on cadre-cli, `POST /seed` on a node) can move a
  seed around once something has produced it, but they are HTTP routes on a *running*
  node, not a CLI verb, and cadre-host's donation flow is the only caller wired to use them.

So the documented "start solo, add a machine later" story has a hole in the middle for
anyone driving the CLI directly: `CadreNode.createSeed` exists in the library and is
reachable from no shipped command.

## What this is worth

This is the first thing an operator hits after a solo node works, and it is the step that
turns Sereus from a local database into the thing it claims to be. It was reported from
outside the project as "the real operator friction for standing up a first drone."

## Shape of the work

A `cadre seed create` subcommand alongside `enroll`, writing the same artifact `--seed`
reads, taking the same node-session plumbing the other commands share
(`node-session.ts`). Decisions worth making deliberately rather than by default:

- **Whether it requires a running node or opens the state directory directly.** `createSeed`
  projects `CadrePeer` rows, so it needs the control database either way; `status-query.ts`
  is the precedent for the read-only-against-a-running-node shape.
- **Which addresses go in.** A seed is dial hints; emitting a node's bare listen addresses
  produces a seed that works on a LAN and silently fails across a NAT. Whatever the answer,
  the README must say which case the command serves.
- **Whether it belongs under `enroll`.** `cadre enroll seed` keeps the two onboarding
  artifacts in one place; a top-level `cadre seed` treats them as peers. No strong view.

Until it lands, the cadre-cli README should say plainly that growing a cadre past one node
needs the admin route or an embedding app, rather than leaving a reader to infer a command
that does not exist.

## Provenance

Raised in an outside documentation review of the published `v0.11.0` tree (2026-08-19),
item 9. Verified against HEAD 2026-08-22: `packages/cadre-cli/src/commands/` holds
`enroll`, `start`, `status`, `status-query`, `strands`, `validation-key` — no seed producer.
