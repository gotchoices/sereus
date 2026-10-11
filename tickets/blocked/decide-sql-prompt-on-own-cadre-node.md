description: A user wants to query the data of a shared workspace their own machines already hold, from a SQL prompt on the command line. There is no supported way today; the maintainer needs to pick which approach to build.
files: packages/cadre-cli/src/server/admin-server.ts, packages/cadre-cli/src/commands/admin-client.ts, packages/cadre-cli/src/commands/strands.ts, packages/cadre-cli/README.md, packages/quereus-plugin-sereus/README.md, packages/cadre-core/src/cadre-node.ts (getStrand)
----
# Decide: a SQL prompt onto strands my own cadre runs

**Blocked on:** a maintainer decision (the specification is silent on operator SQL access). Unblocks when the choice below is recorded and this moves to `plan/`.

## The request (gotchoices/sereus#43, kjeib)

In Taleus, a user and a friend share a closed strand (a tally). The user wants to look at the tally with SQL from the command line, for example in Quoomb, the Quereus shell.

## What exists (1.14)

- `@serfab/quereus-plugin-sereus` loads into Quoomb CLI (`.plugin install`) and has a Node build. Standalone, it starts its **own** libp2p node and connects to a strand by id. That peer is not a member of the user's cadre and holds no strand membership key, so it has no legitimate way into a closed strand. (It may connect today only because `backlog/feat-strand-member-allowlist-admission` is not built.)
- The plugin accepts an injected node (`libp2pNode` + `coordinatedRepo`), but only from code the embedder writes.
- Every cadre machine running the strand already has a Quereus database for it (`CadreNode.getStrand(id).database.getDatabase()`). A storage-profile machine (cadre-cli or cadre-host node) runs every strand its party publishes.
- cadre-cli has a loopback-only admin channel with a bearer token (`--admin-port`, `admin-server.ts`), already serving `GET /admin/strands`. It has no SQL route, and `cadre` has no SQL command.

## Proposal (recommended default)

**(c) `cadre sql <strandId>` in cadre-cli, over the admin channel.** A new admin route, `POST /admin/strands/:id/sql` with `{ sql }`, runs the statement against that node's strand database and returns rows as JSON. `cadre sql <strandId> [-e <statement>]` prints rows, or opens a line-at-a-time prompt when `-e` is absent. **Read-only by default**: statements run inside a transaction that is rolled back, and `--write` commits them, authored as this machine's party (the strand schema's own constraints apply, as for any app write). It reuses the admin channel's existing loopback binding and token, so no new exposure. A node not running the strand answers `404` naming it.

Why this one: it is the smallest change, it needs no new identity or membership, and the data is already on the user's machine. Quoomb integration can come later over the same route if wanted.

## Alternatives considered

- **(a) Quoomb joins the cadre as a member** (through a cadre invitation, like `cadre start --invitation`). Rejected as the first step: the plugin would have to embed a full `CadreNode` (identity, control database, enrollment, strand watcher), duplicating cadre-cli, and every Quoomb session would be a new cadre machine the owner must admit and later remove.
- **(b) Quoomb attaches to a running cadre-cli node** over its admin port. Possible later on top of (c)'s route, but the plugin is a virtual-table module, so forwarding whole statements to another process does not fit its shape; it would be a separate "remote" mode.
- **Do nothing:** users write a script that injects a node, or run the plugin standalone into closed strands, which will stop working once member admission is enforced.

## Open sub-questions for the decider

- Read-only by default with `--write` (recommended), or read-only only?
- Should cadre-host expose the same for its hosted nodes? `backlog/feat-cadre-host-hosted-node-strand-view` would add per-node admin ports, which this could reuse.

## Reversibility

Fully reversible: a new admin route and CLI command, no schema or protocol change.
