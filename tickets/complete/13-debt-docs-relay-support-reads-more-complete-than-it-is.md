---
description: The docs said relay is supported, which was true for a machine acting as a relay and false for some machines trying to be reachable through one. The architecture document now states once which kinds of node can and cannot be reached through a relay, and the per-package documents link to it.
architecture: docs/architecture.md#relay-integration
files: docs/architecture.md, docs/cadre-host.md, docs/reference-app-rn.md, docs/reference-app-ns.md, docs/strands.md, packages/reference-app-web/README.md, packages/reference-app-web/src/lib/relay-config.ts, packages/cadre-host/src/nat/address-resolver.ts, packages/cadre-host/src/orchestrator/host-process-orchestrator.ts, tickets/backlog/feat-cadre-host-children-reserve-on-a-relay.md
---

# Which nodes can be reached through a relay

Documentation and code comments only; no behaviour changed.

## What landed

- `docs/architecture.md` → Relay Integration → new `#### Which nodes can be reached through a relay`: separates the relay server (forwards for others) from the relay reservation (makes a NAT'd node dialable), says unqualified "relay support" means the server half, and gives one table of node kind → reachable through a relay? → how it names its relay → link to the per-package doc. Rows: any `CadreNode` (yes), `cadre-cli` (yes, fail-hard: no `requireRelay` setting), `cadre-host` (no), `cadre-provider` (not plumbed), web app (control node only), React Native app (yes, fail-soft), NativeScript app (no). "Minimal (Single Phone)" and the web-app reference paragraph (no longer "a runtime relay manifest") corrected.
- `docs/cadre-host.md`: NAT item 2 renamed "Circuit-relay reservation (not wired)" and states the actual gap (no host relay setting; children get no `CADRE_RELAY_ADDRS`); the broken ticket link removed; comparison table, public-surface bullet, NAT item 1 and invite-resolver bullet 3 no longer claim a relay fallback.
- One-line cross-links in `reference-app-rn.md`, `reference-app-ns.md`, `strands.md`.
- Comments corrected in `cadre-host` `address-resolver.ts` and `host-process-orchestrator.ts`, and in `reference-app-web` `relay-config.ts` + README (localStorage is a fallback, not an override; not a manifest).
- `tickets/backlog/feat-cadre-host-children-reserve-on-a-relay.md` lists every doc line and comment that must flip when cadre-host gains relay plumbing.

## Review findings

Read the diff of `ticket(implement): debt-docs-relay-support-reads-more-complete-than-it-is` first, then re-checked every matrix row against source at HEAD.

- **Facts verified against code:** `enableRelay` default (`cadre-core/src/relay-server.ts:87`, `network?.enableRelay ?? (profile === 'storage')`); cadre-cli `CADRE_RELAY_ADDRS` → `network.relayAddrs` and no `requireRelay` in its schema; the posture table the `CadreNode` row points to is indeed the next section; cadre-host has no relay setting and never sets `CADRE_RELAY_ADDRS`; cadre-provider `src` sets no relay var; web `resolveRelayAddrs` reads env first, localStorage only when env is empty; RN uses `requireRelay: false` (`phone-node-config.ts:143`); NS `cadre-phone.ts:257-258` has the relay transport, `listenAddrs: []`, no reservation. All correct.
- **Minor, fixed — overstated server claim:** the new architecture.md section said "every storage-profile `CadreNode` runs one" relay server; an explicit `enableRelay: false` turns it off. Reworded to "runs one unless that is set to `false`".
- **Minor, fixed — self-contradicting comment:** the `NOTE:` in the child env block of `host-process-orchestrator.ts` still opened with "Fine while children are reached at those ports or through a relay", while its (implementer-edited) tail now says children hold no relay reservation. Dropped "or through a relay". The backlog feat ticket already lists this `NOTE:` among the sites to flip.
- **Minor, noted not changed:** `packages/cadre-provider/src/service/container-env.ts:56` `NOTE:` says tenants are reached "at the provider's published host port or through a relay". Agreed with the implementer that it states a condition under which the note's tradeoff holds rather than a capability claim; the architecture matrix now says provider containers are not plumbed for a relay. Left alone.
- **Docs coverage:** searched `docs/` and package READMEs for "relay fallback", "relay-client work", "runtime relay manifest"; only the corrected, now-accurate cadre-host.md lines remain. The sibling `debt-docs-add-a-node-flows-dial-in-opposite-directions` is still in plan, so there is no section to cross-link yet.
- **Anchors:** the seven new anchors were checked by the implementer with a slug script; re-inspected by eye against the headings, and they match.
- **Tests:** none added or cut; the change is prose and comments only, so there is no behaviour to pin. `yarn eslint` on the three touched source files passes.
- **Tripwires / new tickets:** none. The one real gap (cadre-host passes no relay) is already filed as `feat-cadre-host-children-reserve-on-a-relay` in backlog.
- **Pre-existing, unrelated:** TypeScript hint "`cfg` declared but never read" at `host-process-orchestrator.ts:177`; untouched by this change.
