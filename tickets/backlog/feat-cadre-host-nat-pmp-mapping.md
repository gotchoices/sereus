description: cadre-host only asks the home router to open ports through UPnP. Routers that speak only NAT-PMP or its successor PCP (some Apple and open-source router firmware) get no automatic mapping, so their users must forward ports by hand.
architecture: docs/cadre-host.md#nat-and-ddns
files: packages/cadre-host/src/nat/port-mapper.ts, packages/cadre-host/src/nat/nat-service.ts, packages/cadre-host/src/nat/types.ts, docs/cadre-host.md
tradeoffs: Most consumer routers support UPnP, manual forwarding already covers the rest, and NAT-PMP needs the default gateway's address, which Node does not expose without a new dependency or reading routing tables per platform.
----

# NAT-PMP / PCP fallback for automatic port mapping

`cadre-host-nat-per-node-mappings` maps each hosted node's TCP and WebSocket ports through UPnP-IGD only (`@achingbrain/nat-port-mapper` v4 `upnpNat`). The same library offers `pmpNat(gatewayIp)`, which returns the same `Gateway` interface, but it needs the IPv4 address of the default gateway, and UPnP discovery (SSDP) is what finds the gateway today.

## Expected behaviour

- When UPnP discovery finds no gateway, cadre-host tries NAT-PMP against the default gateway before reporting the node unreachable.
- Mappings made through NAT-PMP behave exactly like UPnP ones in status (`source` distinguishes them, e.g. `'natpmp'`), lease renewal, per-port failure isolation, and the advertised external port (NAT-PMP routers often assign a port different from the one requested).

## Open design point

How to find the default gateway's address without a hand-written routing-table parser: a maintained dependency (for example `default-gateway`), or a platform command whose output format is stable and documented. Choose during planning.
