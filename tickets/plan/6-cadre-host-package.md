description: New @serfab/cadre-host sibling package for self-hosted basement-PC deployments — skeleton, scope doc, CLI shell
files: packages/cadre-host/ (new), packages/cadre-provider/src/service/orchestrator.ts, packages/cadre-provider/src/service/store.ts, docs/cadre-host.md (new), docs/architecture.md
----

## Persona

The **self-host** user runs a sereus presence on their own always-on machine — typically a desktop PC in a basement or home office — and wants to share that machine's storage and uptime with themselves across devices and with a small trust circle (one or two friends or family members). They are not an operator. They will not run `systemctl`, edit YAML, or read API docs. They will double-click an installer, click through a setup wizard, and want the thing to keep working until they actively shut it off.

This persona is the inverse of the multi-tenant provider persona `@serfab/cadre-provider` was built for: small trust circle instead of arbitrary customers, no billing, no API keys, no Docker dependency, must survive reboots without manual intervention, must be configurable through a UI rather than a config file.

## Package boundary

`@serfab/cadre-host` is a **sibling** package to `@serfab/cadre-provider`, not a mode of it. It depends on cadre-provider's primitives — the `Orchestrator` interface (`packages/cadre-provider/src/service/orchestrator.ts`), the `ProviderStore` interface (`packages/cadre-provider/src/service/store.ts`), and the container/process lifecycle types in `cadre-provider/src/types.ts` — but ships its own:

- Entry point and CLI (`cadre-host install`, `cadre-host start`, `cadre-host status`).
- HostProcessOrchestrator (no Docker; see `cadre-host-process-orchestrator`).
- Trust-circle auth (no API keys, no customers; see `cadre-host-trust-circle`).
- Installer + service-host registration (see `cadre-host-installer`).
- Local management UI (see `cadre-host-local-ui`).
- NAT traversal + DDNS (see `cadre-host-nat`).
- No billing, no quotas — those code paths are not imported.

Splitting it into its own package keeps cadre-provider clean for the ops/cloud persona (where Stripe and customer accounts make sense) and gives the self-host persona a separate published artifact with its own README, version cadence, and installer story.

A small refactor of cadre-provider is in scope as part of this ticket: any code that is genuinely orchestrator-agnostic and store-agnostic but currently lives inside cadre-provider should move to a shared spot (a `cadre-provider/src/core/` folder or a third `@serfab/cadre-orchestration-core` package — decided at plan stage based on how much actually wants to be shared). Avoid premature factoring; if the shared surface is just the two interfaces and the lifecycle types, leave them in cadre-provider and have cadre-host import from there.

## Scope of this ticket

This ticket is the foundation. The other five tickets in this set (`cadre-host-process-orchestrator`, `cadre-host-trust-circle`, `cadre-host-nat`, `cadre-host-installer`, `cadre-host-local-ui`) each implement one slice and depend on this ticket landing first. Concretely this ticket delivers:

- `packages/cadre-host/` workspace with `package.json`, `tsconfig.json`, `tsconfig.build.json` matching the monorepo's existing per-package conventions.
- Dependency declarations: workspace deps on `@serfab/cadre-provider` and `@serfab/cadre-core`, runtime deps on `commander` (CLI), `debug`, `fastify` (for the eventual local UI's backend), and TypeScript devDeps.
- An empty CLI shell at `src/bin/host.ts` exposing `install`, `start`, `status`, `invite`, and `uninstall` commands. Each command is a stub that prints "not yet implemented" and exits 0 — the other tickets fill them in. The CLI **structure** is fixed by this ticket so the other tickets have a stable surface to wire into.
- An entrypoint at `src/index.ts` re-exporting the types and lifecycle hooks that consumers (the local UI, the installer scripts) will need.
- `docs/cadre-host.md` — the persona description, package boundary, deployment model, security posture (trust circle, not zero-trust), and an architecture sketch. This is the "what is this and why does it exist" doc. Length: short. The tickets below carry the implementation detail.
- An update to `docs/architecture.md` to mention cadre-host alongside cadre-provider under "Flexible deployment" and link to `docs/cadre-host.md`.
- A `README.md` with the persona pitch, an "install" section that for now just points at the (forthcoming) installer ticket, and a "what's in this package" pointer to the architecture doc.

## What this ticket does not deliver

- Any actual orchestrator, auth, UI, installer, or NAT logic. Each of those is a separate plan ticket. This ticket only delivers the package skeleton, the CLI surface, the docs, and the shared-code refactor (if any).
- Tests beyond a smoke test that `cadre-host --help` runs without crashing. Implementation tickets bring their own tests.

## Constraints & considerations

- **Naming.** Confirmed `@serfab/cadre-host`. Bin name `cadre-host`. Avoid name collisions with cadre-provider's `cadre-provider` bin.
- **Node version.** Match cadre-provider (`engines.node: >=18`). The installer ticket may bundle a Node runtime so the user doesn't need one preinstalled; that's its problem, not this ticket's.
- **License.** MIT, matching the rest of the monorepo.
- **Workspace integration.** This is a new package under `packages/`. Update `package.json` workspaces glob if it doesn't already match `packages/*` (it should). Update `tsconfig.json` references at the root if the build graph uses them.
- **Shared-code decision.** Before deciding whether to extract a third package, audit what cadre-host genuinely needs from cadre-provider versus what it should reimplement. The current `ContainerService` is somewhat coupled to billing and quota concerns; cadre-host may want a leaner lifecycle service rather than reusing it directly. Plan stage decides.

## Use cases enabled (by this ticket plus the rest of the set)

1. A user with a Windows desktop in their basement downloads the cadre-host installer, clicks through, and ends up with one cadre node running as a Windows Service, surviving reboots, accessible to themselves from their phone.
2. The same user generates an invite code in the local UI, sends it to a family member out-of-band, and the family member's cadre node joins the user's trust circle and starts using the basement PC as storage.
3. The user adds a second cadre node on the same host (because they participate in a second party) — the provider runs N nodes per host without contention.
4. The host machine reboots; the service restarts, the cadre nodes come back up, the friend's node reconnects automatically. The user does nothing.
5. A new version of cadre-host is released; on next launch the user is prompted in the local UI to update.
