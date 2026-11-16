description: cadre-host only asks the home router to open ports through UPnP. Routers that speak only NAT-PMP or its successor PCP (some Apple and open-source router firmware) get no automatic mapping, so their users must forward ports by hand.
architecture: docs/hosting/cadre-host.md#nat-and-ddns
files: packages/cadre-host/src/nat/port-mapper.ts, packages/cadre-host/src/nat/nat-service.ts, packages/cadre-host/src/nat/types.ts, docs/hosting/cadre-host.md
tradeoffs: Most consumer routers support UPnP, manual forwarding already covers the rest, and NAT-PMP needs the default gateway's address, which Node does not expose without a new dependency or reading routing tables per platform.
----

# NAT-PMP / PCP fallback for automatic port mapping

`cadre-host-nat-per-node-mappings` maps each hosted node's TCP and WebSocket ports through UPnP-IGD only (`@achingbrain/nat-port-mapper` v4 `upnpNat`). The same library offers `pmpNat(gatewayIp)`, which returns the same `Gateway` interface, but it needs the IPv4 address of the default gateway, and UPnP discovery (SSDP) is what finds the gateway today.

## Expected behaviour

- When UPnP discovery finds no gateway, cadre-host tries NAT-PMP against the default gateway before reporting the node unreachable.
- Mappings made through NAT-PMP behave exactly like UPnP ones in status (`source` distinguishes them, e.g. `'natpmp'`), lease renewal, per-port failure isolation, and the advertised external port (NAT-PMP routers often assign a port different from the one requested).

## Open design point

How to find the default gateway's address without a hand-written routing-table parser: a maintained dependency (for example `default-gateway`), or a platform command whose output format is stable and documented. Choose during planning.

## Arm: text that already claims NAT-PMP

Three places in `packages/cadre-host/src` describe NAT-PMP as if it were implemented. Only `upnpNat` is imported (`nat/port-mapper.ts`), so each is wrong until this ticket lands, and each needs rewording now or when it does:

- the help text of `cadre-host install --no-upnp` in `bin/host.ts`: "Disable UPnP/NAT-PMP probing on first run";
- the comment on `HostConfigFile.upnpEnabled` in `installer/config.ts`: "Whether UPnP/NAT-PMP should be attempted at start time" (that field is also never read after install; see `debt-accepted-settings-nothing-reads`);
- the comment on `ExternalIpResult.routerIp` in `nat/external-ip.ts`: "IP reported by the upstream router (UPnP/NAT-PMP gateway)".

The help text is the one a user sees. `packages/cadre-host/README.md` and `docs/hosting/cadre-host.md` already say UPnP only.
