# @serfab/cadre-host

Self-hosted cadre node manager for basement-PC deployments. Runs one always-on host machine, manages cadre nodes for a small trust circle (family, friends, hobby group), exposes a localhost web UI, and handles NAT/DDNS so members behind residential connections can still be reached.

The sibling of [`@serfab/cadre-provider`](../cadre-provider/README.md): the provider is a multi-tenant hosting service with API keys, billing, and Docker; cadre-host is a single-household manager with trust-circle auth, native child processes, and an installer.

## Install

```bash
npm install -g @serfab/cadre-host
cadre-host install
```

The full installer (service-host integration, first-run trust-circle setup, NAT bootstrap) is arriving in a follow-up release.

At this stage:

- `cadre-host invite <label>` issues a trust-circle invite via the running management API. See [docs/cadre-host.md](../../docs/cadre-host.md#trust-circle) for the lifecycle.
- `cadre-host trust list` and `cadre-host trust revoke <token-or-peerId>` round out trust-circle management.
- `cadre-host nat status`, `cadre-host nat test`, `cadre-host nat ddns set duckdns --hostname <h> --token <t>`, `cadre-host nat ddns external --hostname <h>`, `cadre-host nat settings [--external-port N] [--no-upnp]` manage NAT / DDNS. See [docs/cadre-host.md](../../docs/cadre-host.md#nat-and-ddns).
- `HostProcessOrchestrator` runs cadre nodes as native child processes.
- `NatService` + `TrustCircleService` are libraries (not yet hosted by a long-running process); `cadre-host-local-ui` constructs them.
- `install`, `start`, `status`, and `uninstall` still print "not yet implemented", pending the `cadre-host-installer` and `cadre-host-local-ui` tickets.

## More

- [docs/cadre-host.md](../../docs/cadre-host.md) — persona, package boundary, deployment model, security posture.
- [docs/architecture.md](../../docs/architecture.md) — overall cadre architecture.
