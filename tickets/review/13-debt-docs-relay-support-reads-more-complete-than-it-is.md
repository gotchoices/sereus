---
description: The docs said relay is supported, which was true for a machine acting as a relay and false for some machines trying to be reachable through one. The architecture document now states once which kinds of node can and cannot be reached through a relay, and the per-package documents link to it.
architecture: docs/architecture.md#relay-integration
files: docs/architecture.md, docs/cadre-host.md, docs/reference-app-rn.md, docs/reference-app-ns.md, docs/strands.md, packages/reference-app-web/README.md, packages/reference-app-web/src/lib/relay-config.ts, packages/cadre-host/src/nat/address-resolver.ts, packages/cadre-host/src/orchestrator/host-process-orchestrator.ts, tickets/backlog/feat-cadre-host-children-reserve-on-a-relay.md
---

# Review: which nodes can be reached through a relay

Documentation and code comments only. No behaviour changed, so no tests were added. `yarn eslint` passes on the three touched source files.

## What changed

**`docs/architecture.md` → Relay Integration → new `#### Which nodes can be reached through a relay`** (placed before "Reservations are requested explicitly, not discovered"). It separates the relay *server* (forwards for others) from the relay *reservation* (a slot that makes a NAT'd node dialable), says unqualified "relay support" means the server half, and gives one table: node kind → reachable through a relay? → how it names its relay → link to the per-package section. It is followed by two plain lines (phones: web and RN work, given a relay; cadre-host and the NativeScript app do not) and one line saying a node can dial *through* a relay it holds no slot on (links strands.md SN–SN).

Rows and what each rests on (all re-checked at HEAD):

- any `CadreNode`: `relayAddrs` or `reserveRelays()`, pointing to the posture table in the next section.
- `cadre-cli`: yes, fail-hard. `CADRE_RELAY_ADDRS` → `network.relayAddrs` (`packages/cadre-cli/src/config/env.ts:43`); the strict schema (`config/schema.ts:118`) has no `requireRelay`, so a down relay fails `start()`, which matches the cadre-cli README's `CADRE_RELAY_ADDRS` row.
- `cadre-host`: no. No relay field anywhere in `packages/cadre-host/src`; the child spawn scrubs `CADRE_*` and never sets `CADRE_RELAY_ADDRS`.
- `cadre-provider`: "not plumbed", with no reachability claim. `container-env.ts` sets no relay var; `docker-orchestrator.ts` publishes the p2p port on the Docker host. The provider README says nothing about the host being publicly dialable, so the row says "dialable only if the published port is".
- web app: control node only. It matches the `NOTE:` at `packages/reference-app-web/src/lib/cadre-web.ts` (search "reaches the CONTROL node only").
- RN app: yes when the relay is up. It uses `requireRelay: false`, so a dead relay means running but undialable.
- NativeScript app: no. `packages/reference-app-ns/src/cadre-phone.ts` sets `transports: [webSockets(), circuitRelayTransport()]`, `listenAddrs: []`, and no `relayAddrs` or `reserveRelays`.

**Other architecture.md fixes:** "Minimal (Single Phone)" now says only the web and RN reference apps can reserve today and links the matrix. The reference-apps paragraph no longer says the web relay comes "from a runtime relay manifest, like the ICE manifest". It now says `VITE_RELAY_ADDR`, else `localStorage["relay-addr"]`. The "remaining deferred e2e tier" sentence was left as is: I did not check whether it is stale.

**`docs/cadre-host.md`:** NAT item 2 is renamed "Circuit-relay reservation (not wired)". It says what is actually missing (a host setting, and passing `CADRE_RELAY_ADDRS` to children) and links the matrix. The broken `../tickets/backlog/` link to the relay-*deployment* ticket is gone. The invite-resolver third bullet now names the real gate: "once cadre-host passes a relay to its owner node". **Beyond the ticket's list**, three more passages in the same file claimed a relay fallback: the cadre-provider/cadre-host comparison table, the "Public libp2p surface" bullet, and NAT item 1's "fall back to a relay (next bullet)". Each now says the fallback is not wired yet.

**Cross-links (one line each):** `reference-app-rn.md` → Reachability, `reference-app-ns.md` → Architecture Overview (dial-out only, no reservation), `strands.md` → SN–SN (which apps can be the reserving party).

**Code comments:**

- `packages/cadre-host/src/nat/address-resolver.ts` header now names the real gate, matching the doc.
- `packages/cadre-host/src/orchestrator/host-process-orchestrator.ts`: the existing `NOTE:` in the child env block said strand nodes and off-LAN phones "are reached through observed addresses or a relay". Children hold no reservation, so it now says observed addresses only, and why. This was not in the ticket's list.
- `packages/reference-app-web/src/lib/relay-config.ts` and `packages/reference-app-web/README.md` → Dialability: both repeated the "like the ICE manifest, resolved at runtime" claim and called `localStorage` an "override". `resolveRelayAddrs` reads env first and localStorage only when env is empty, so both now say "fallback", and "not a manifest". This was not in the ticket's list either.

**`tickets/backlog/feat-cadre-host-children-reserve-on-a-relay.md`:** Its statement about what cadre-host.md says is corrected, and a "Docs that change when this lands" section lists every doc line and comment above that must flip when cadre-host gains relay plumbing.

## For the reviewer

- **Anchors**: every new `#anchor` was checked against GitHub's slug rule by a throwaway script (lowercase, drop punctuation including the en dash, spaces → hyphens, `-N` for duplicates). All seven resolve: `architecture.md#which-nodes-can-be-reached-through-a-relay`, `cadre-cli/README.md#environment-variables`, `cadre-host.md#nat-and-ddns`, `reference-app-web/README.md#dialability-relay-reservation`, `reference-app-rn.md#reachability-configuring-a-relay`, `reference-app-ns.md#architecture-overview`, `strands.md#snsn-both-parties-are-single-nat-nodes`.
- **Left alone on purpose**: the mermaid label `NAT layer (DDNS · UPnP/PCP · relay)` in cadre-host.md's component diagram, which names a planned layer in a diagram and is not a capability claim. The host UI's CGNAT advice ("Use a relay / tunnel (e.g. Cloudflare Tunnel, Tailscale Funnel)"), which means an external TCP tunnel and is accurate. The `container-env.ts` `NOTE:` in cadre-provider ("Fine while tenants are reached at the provider's published host port or through a relay"), which states a condition, not a claim that containers reserve.
- **Sibling ticket** `debt-docs-add-a-node-flows-dial-in-opposite-directions` is still in `plan/`. Nothing of it has landed, so there is no section to cross-link yet. That ticket is expected to link to this matrix.
- An unrelated TypeScript "declared but never read" hint on `cfg` at `host-process-orchestrator.ts:177` showed up in editor diagnostics. It was there before this change (only a comment was edited) and was not touched.
