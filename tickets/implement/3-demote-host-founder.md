----
description: Stop treating "the host founds and owns a cadre" as cadre-host's main job; make donating nodes the default and turn the host's own personal cadre into an opt-in extra that a user only gets if they ask for it.
prereq: donation-service
files: packages/cadre-host/src/bin/host.ts, packages/cadre-host/src/orchestrator/host-process-orchestrator.ts, packages/cadre-host/src/installer/config.ts, packages/cadre-host/src/installer/index.ts, packages/cadre-host/src/server/routes/nodes.ts, packages/cadre-cli/src/commands/start.ts, packages/cadre-host/src/nat/nat-service.ts
difficulty: hard
----

# Demote the host-as-founder path

## Context

cadre-host was built around the wrong assumption that the host machine founds and
owns a cadre: `bin/host.ts start` unconditionally spawns an "owner node"
(`ensureOwnerNode`) whose party id is the host's own `installId`, `cadre-cli start
--owner` runs a genesis that mints the host's authority key, and the trust-circle
issues invites so phones join **the host's** cadre. `1-donation-grant-tokens` +
`2-donation-service` add the correct **donor** role alongside all of that. This
ticket makes the donor role primary and the founder role an explicit, opt-in
convenience — satisfying source-plan requirement #6.

## Decision: demote, don't delete (with tradeoff)

**Retain the owner-node / trust-circle / `--owner` machinery as an opt-in
"host owner also wants their own cadre here" feature, gated off by default.** The
donor path (spawn nodes for *other people's* cadres) runs without ever spawning an
owner node.

Rationale:
- Source plan #6 explicitly permits retaining the founder path "as an optional
  convenience … clearly separated from the donor role."
- The owner-node delegation, `OwnerNodeClient`, `TrustCircleService`, `NatService`
  owner-node coupling, the local UI, and `cadre-host-owner-node.integration.ts` are a
  large, tested, working subsystem. The realignment's actual defect is a **missing
  donor role + a docs/mental-model that presents founding as the whole point** — not
  that an owner-node code path may exist at all. Deleting it would be gratuitous
  destruction of working code to no functional gain.
- The always-on host-owned node is also the natural home for the future
  WAN-reachability broker (`backlog/feat-cadre-host-wan-grant-reachability`), so
  keeping it lowers the cost of that work.

**Tradeoff / when to revisit:** this leaves two personas in one package. If the
host-own-cadre convenience proves unwanted, a follow-up can delete `--owner`,
`ensureOwnerNode`/`buildOwnerChildConfig`, and the trust-circle-as-membership surface
outright ("no backwards compat yet" permits it). Recorded here so a future reader
knows removal is on the table, not foreclosed.

## Design

### Config flag (`installer/config.ts`)

Add `ownCadre: { enabled: boolean }` to `host.config.json` (default `false`). The
installer wizard (`installer/index.ts`) asks a single question — *"Also run your own
personal cadre on this machine? (most people just donating nodes to friends say no)"*
— default no. `installId` stays (it's the install identifier); it is used as the
host-own-cadre party id **only when `ownCadre.enabled`**.

### `bin/host.ts start` — donor-first, founder-optional

Restructure so the donor stack always comes up and the founder stack is conditional:

```
always:
  orchestrator = new HostProcessOrchestrator(...); await init()
  grantService + donationService (2-donation-service); mount /grants[-admin]
  start donation reap sweep
  bind loopback management server

if cfg.ownCadre.enabled:
  orchestrator.ensureOwnerNode({ identityPath, partyId: cfg.installId, libp2pPort })
  owner = new OwnerNodeClient(() => orchestrator.getOwnerAdminEndpoint())
  trustCircle = new TrustCircleService({ cadreNode: owner, ... })
  natService = new NatService({ cadreNode: owner, ... }); mount /nat, /auth
  wire invite-address push
else:
  skip owner node entirely; trust-circle + NAT routes either 404 or return a
  clear "host-own-cadre not enabled" error (pick 404 to keep the surface honest)
```

The current `start` (`bin/host.ts:261-346`) always builds `owner`/`trustCircle`/`natService`
and always calls `ensureOwnerNode` — move that whole block behind the flag.

### NAT when host-own-cadre is off

`NatService` today depends on the owner node (`getPeerId`/`getMultiaddrs`/
`inviteAddressResolver`). With no owner node there's nothing for it to map **in v1**
— the donated nodes' per-node NAT mapping is deferred to
`backlog/feat-cadre-host-wan-grant-reachability`. So when `ownCadre.enabled` is false,
do **not** construct `NatService`; the donor path is loopback-only in v1 (see
`2-donation-service`). Leave `NatService` otherwise untouched.

### `cadre-cli start --owner` — reframe, keep

No code removal. Update the `--owner` flag help + the `buildOwnerChildConfig`
docstring (`host-process-orchestrator.ts:690`, which currently says "it is the
founding node") to state plainly: this is the **host's own personal cadre** owner
node, spawned only when the host owner opts in — **not** the node donated to a
requester (donated nodes are generic, `createContainer`, and carry the *requester's*
pinned owner key, never a host genesis). This kills the docstring-level drift the
source plan flagged.

## Edge cases & interactions

- **Fresh install, `ownCadre` off (the common case)**: `start` must come up with
  **no** owner node, `/grants` live, `/nat` + `/auth` absent (404). The local-UI
  status/nodes routes must not assume an owner node exists (`nodes.ts`
  `isOwnerNode`/`ensureOwnerNode` paths must no-op gracefully when none is
  configured). Test: start with `ownCadre.enabled=false`, assert no owner handle,
  `POST /grants` works, `GET /nat/status` 404s.
- **`ownCadre` on**: behaves as today — owner node + trust circle + NAT all up.
  Existing `cadre-host-owner-node.integration.ts` + trust-circle/NAT suites must still
  pass unchanged (they represent the opt-in persona now).
- **Toggling the flag across restarts**: enabling later spawns the owner node on next
  `start` (idempotent genesis is already safe). Disabling later leaves the owner node's
  workdir on disk but unspawned — document that its data persists (don't delete it).
- **UI/settings**: `ownCadre.enabled` is install-time (not in the settings
  write-whitelist); editing requires reinstall/config edit + restart, like the other
  structural fields. Confirm the settings write-whitelist rejects it.
- **installId semantics**: still minted at install (identifies the install); only
  *doubles as a party id* when `ownCadre.enabled`. A pure-donor host's `installId` is
  never used as a cadre party id. Don't leak it into donated-node configs.

## TODO

- [ ] `installer/config.ts`: add `ownCadre.enabled` (default false) to the schema +
  defaults; ensure settings write-whitelist excludes it.
- [ ] `installer/index.ts`: wizard question (default no); `--own-cadre` non-interactive
  flag.
- [ ] `bin/host.ts start`: move owner-node / trust-circle / NAT construction behind
  `cfg.ownCadre.enabled`; donor stack + management server always up.
- [ ] `server/routes/nodes.ts` + local-UI status: no-owner-node graceful behavior.
- [ ] `orchestrator/host-process-orchestrator.ts`: reword `buildOwnerChildConfig`
  docstring (host-own-cadre owner, not "founding node"; donated nodes are generic).
- [ ] `cadre-cli/src/commands/start.ts`: reword `--owner` help.
- [ ] Tests: donor-only start (no owner node, `/grants` up, `/nat` 404); own-cadre start
  unchanged; settings-whitelist rejects `ownCadre`.
- [ ] `yarn workspace @serfab/cadre-host build` + `test`; `yarn lint` green.
