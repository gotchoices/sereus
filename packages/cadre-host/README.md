# @serfab/cadre-host

Self-hosted cadre node manager for basement-PC deployments. Runs one always-on host machine, manages cadre nodes for a small trust circle (family, friends, hobby group), exposes a localhost web UI, and handles NAT/DDNS so members behind residential connections can still be reached.

The sibling of [`@serfab/cadre-provider`](../cadre-provider/README.md): the provider is a multi-tenant hosting service with API keys, billing, and Docker; cadre-host is a single-household manager with trust-circle auth, native child processes, and an installer.

## Install

```bash
npm install -g @serfab/cadre-host
cadre-host install
```

The full installer (service-host integration, first-run trust-circle setup, NAT bootstrap) is arriving in a follow-up release. At this stage the CLI commands print "not yet implemented" — the package establishes the surface that sibling tickets (`cadre-host-process-orchestrator`, `cadre-host-trust-circle`, `cadre-host-nat`, `cadre-host-installer`, `cadre-host-local-ui`) plug into.

## More

- [docs/cadre-host.md](../../docs/cadre-host.md) — persona, package boundary, deployment model, security posture.
- [docs/architecture.md](../../docs/architecture.md) — overall cadre architecture.
