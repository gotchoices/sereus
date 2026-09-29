---
description: The docs say relay is supported, which is true for a machine acting as a relay and false for some machines trying to be reachable through one. State once, in the architecture document, which kinds of node can and cannot be reached through a relay today, and link to it from the per-package documents.
architecture: docs/architecture.md#relay-integration
files: docs/architecture.md, docs/cadre-host.md, docs/reference-app-rn.md, docs/reference-app-ns.md, docs/strands.md, packages/cadre-host/src/nat/address-resolver.ts, tickets/backlog/feat-cadre-host-children-reserve-on-a-relay.md
---

# "Relay is supported" is true for servers and false for some clients

## Background

Relay support has two halves that live in different documents, and no document states the split:

- **Relay server** — a node forwarding connections for others (`network.enableRelay`, on by default for the storage profile). Implemented everywhere cadre-core runs as a storage node.
- **Relay client reservation** — a NAT'd node holding a slot on a relay so that it gets a `/p2p-circuit` address and others can dial *it*. This is what makes a phone or a home machine behind carrier-grade NAT reachable. Whether it exists depends on the package.

A reader planning "a phone dialed through a relay" or "a home cadre-host behind CGNAT reachable through a relay" can read "relay is supported" and design something that cannot work today.

## Verified facts (HEAD, 2026-09-29)

| node kind | reserves on a relay? | how it is configured | evidence |
| --- | --- | --- | --- |
| any `CadreNode` (cadre-core) | yes | `network.relayAddrs` (fatal on failure unless `requireRelay: false`) or `CadreNode.reserveRelays()` (fail-soft) | `packages/cadre-core/src/relay-addrs.ts`, `relay-reservation.ts`; architecture.md "Reservations are requested explicitly, not discovered" |
| `cadre-cli` node | yes | `network.relayAddrs` / `CADRE_RELAY_ADDRS` | `packages/cadre-cli/src/config/env.ts:43` |
| `cadre-host` owner node and donated nodes | **no** | nothing: host config has no relay field, and the child spawn scrubs every `CADRE_*` var from the parent env and never sets `CADRE_RELAY_ADDRS` | `packages/cadre-host/src/orchestrator/host-process-orchestrator.ts` (`scrubbedParentEnv`, the env block near line 609 and its `NOTE:`) |
| web reference app | yes | `VITE_RELAY_ADDR` or `localStorage["relay-addr"]`, via `CadreNode.reserveRelays` (control node only — see the `NOTE:` in `packages/reference-app-web/src/lib/cadre-web.ts:425`) | `packages/reference-app-web/src/lib/relay-config.ts` |
| React Native reference app | yes | `EXPO_PUBLIC_RELAY_ADDR` or Settings → Relay, via `network.relayAddrs` with `requireRelay: false` | `docs/reference-app-rn.md` → "Reachability: configuring a relay" |
| NativeScript reference app | **no** | carries the circuit-relay *transport* (so it can dial *through* a relay) but never sets `relayAddrs` or calls `reserveRelays`; it also has no invitation flow, so it is dial-out only | `packages/reference-app-ns/src/cadre-phone.ts:257` |
| `cadre-provider` containers | not plumbed | the provider sets no `CADRE_RELAY_*` var; containers are reached at their published host ports | `grep -rn RELAY packages/cadre-provider/src` is empty — implementer: confirm the provider docs assume a publicly dialable Docker host before writing the row |

Answer to the plan-stage question about `cadre-host.md` ("circuit addresses appear once the relay-client work lands" — is that still the only gate?): the reservation itself is done (cadre-cli has it, and cadre-host's children *are* cadre-cli processes). What is missing is cadre-host plumbing: a host setting for relay addresses, passed to its children as `CADRE_RELAY_ADDRS`. That is not the relay-*deployment* work in `tickets/backlog/later/4-relay-bootstrap-infrastructure.md` (multi-region relays, dnsaddr, abuse limits), which is what the doc currently links (and links to the wrong folder). This plan files the plumbing as `tickets/backlog/feat-cadre-host-children-reserve-on-a-relay.md`; the docs should name the gap concretely rather than point at a ticket path.

## The change

**1. One matrix, in `docs/architecture.md` → "Relay Integration".** Add a short subsection near the top of "Relay Integration" (before "Reservations are requested explicitly, not discovered"), e.g. `#### Which nodes can be reached through a relay`. Contents:

- One sentence separating the two halves (server = forwards for others; client reservation = becomes dialable itself), and that "relay support" in these docs means the server half unless it says otherwise.
- The table above, trimmed for a reader choosing an architecture: node kind, reachable through a relay (yes/no), how to configure it, and a link to the per-package section. Drop the evidence column; keep file references only where the per-package doc does not already give them.
- Two explicit lines: inbound-to-phone **works** on the web and React Native reference apps given a configured relay; it does **not** work for `cadre-host` (use UPnP, a manual port forward, or IPv6 until the host plumbs a relay) or for the NativeScript app.
- Every node can *dial through* a relay it holds no reservation on (already stated in strands.md and architecture.md's blind-relay section — link, don't restate).

Also fix the two architecture.md passages that imply more than exists:

- "Minimal (Single Phone)" under "Deployment Configurations" (`relay-dependent for inbound connectivity`) — add that this holds for the web and RN apps and link the new subsection.
- The reference-apps paragraph (search "Becoming **dialable** for formation requires a circuit-relay") says the web app's relay is "resolved from a runtime relay manifest, like the ICE manifest". It is not a manifest: `relay-config.ts` reads `VITE_RELAY_ADDR` then `localStorage["relay-addr"]`. Correct it. The same paragraph's "live two-party convergence … is the reference's remaining deferred e2e tier" — leave it unless you verify it is stale; it is out of scope here.

**2. `docs/cadre-host.md` → "NAT and DDNS", item 2 "Circuit-relay client (deferred)".** Rewrite to say what is actually missing: cadre-core and cadre-cli can reserve, but cadre-host has no setting for a relay and does not pass one to its owner node or donated nodes (the spawn scrubs `CADRE_*`). Replace the broken `backlog/4-relay-bootstrap-infrastructure` link (it points at `../tickets/backlog/`; the file is in `backlog/later/` and is about deploying relays, not this) — per AGENTS.md "current work state lives in tickets/, not in docs", state the gap and link the architecture.md matrix instead of linking a ticket path. Keep "Until then, hosts behind CGNAT will need either IPv6 or manual port forwarding."

**3. `docs/cadre-host.md` → "Invite address resolver", third bullet** ("including any `/p2p-circuit/` addresses once the relay-client work lands"): reword to "once cadre-host passes a relay to its owner node" (or equivalent), so it names the real gate. Apply the same rewording to the doc comment in `packages/cadre-host/src/nat/address-resolver.ts:7-8` ("once relay-client wiring lands (see follow-up tickets)") so code and doc agree.

**4. Cross-links (one line each, no restatement):**

- `docs/reference-app-rn.md` → "Reachability: configuring a relay": a line linking the architecture.md matrix.
- `docs/reference-app-ns.md` → "Architecture Overview" (near the "WebSocket + circuit relay" transport row): say plainly that the NS app carries the relay transport for dialing out only, does not reserve, and so is not reachable through a relay; link the matrix.
- `docs/strands.md` → "SN–SN (both parties are single NAT nodes)": a line saying which apps can be the reserving party today, linking the matrix.
- `docs/cadre-host.md` item 2 (above) links it too.

Do not touch the add-a-node dial-direction material — that is the sibling ticket `debt-docs-add-a-node-flows-dial-in-opposite-directions` (plan stage), which will link to this matrix for its reachability column. If that ticket has already landed a section by the time you work this, link the two sections to each other.

## Edge cases & interactions

- **Web app reserves on its control node only.** `reserveRelays` reaches the control node, not strand nodes (`cadre-web.ts:425` `NOTE:`). The matrix row must not claim more than "the tab's control node is dialable through a relay"; check that note's current wording and reflect it in one clause. Verify by reading the note.
- **RN posture is fail-soft.** `requireRelay: false`: a dead relay leaves the phone started but undialable. The matrix's "how to configure" cell for RN should not suggest reachability is guaranteed. Verify by inspection against reference-app-rn.md.
- **cadre-cli posture is fail-hard by default.** `relayAddrs` with the default `requireRelay` makes `start()` throw when the relay is down. Say so in the cadre-cli row (one clause) since that is the node kind a host operator would reach for. Verify against architecture.md's posture table.
- **Provider row.** Only include it once confirmed from `packages/cadre-provider` docs/code that containers are expected to be publicly dialable; otherwise write "not plumbed" without a reachability claim.
- **Stale anchors.** Any new `#anchor` link must match the heading slug GitHub generates (lowercase, spaces → hyphens, punctuation dropped). Verify each new link by inspection.
- **No duplicated facts.** The RN and web configuration details already live in their own docs; the matrix links them rather than copying env-var semantics beyond the variable names.

No tests: documentation plus one code comment.

## TODO

- Confirm the provider row (read `packages/cadre-provider` orchestrator env + its docs) and the web `reserveRelays` note wording.
- Add the "Which nodes can be reached through a relay" subsection to `docs/architecture.md` → "Relay Integration".
- Fix architecture.md "Minimal (Single Phone)" and the web-app "runtime relay manifest" sentence.
- Rewrite `docs/cadre-host.md` NAT item 2 (gap stated concretely, broken ticket link removed, matrix linked).
- Reword `docs/cadre-host.md` invite-resolver bullet 3 and the matching comment in `packages/cadre-host/src/nat/address-resolver.ts`.
- Add the cross-link lines in `docs/reference-app-rn.md`, `docs/reference-app-ns.md`, `docs/strands.md`.
- Check every new link/anchor resolves.
