description: New @serfab/cadre-host sibling package — skeleton, CLI shell, docs. Foundation for the cadre-host-* ticket set.
files: packages/cadre-host/ (new), packages/cadre-provider/src/service/orchestrator.ts, packages/cadre-provider/src/service/store.ts, packages/cadre-provider/src/types.ts, packages/cadre-provider/src/index.ts, docs/cadre-host.md (new), docs/architecture.md, package.json (root)
----

## Goal

Create the `@serfab/cadre-host` workspace package with a stub CLI, the persona/architecture doc, and exports that the five sibling tickets (`cadre-host-process-orchestrator`, `cadre-host-trust-circle`, `cadre-host-nat`, `cadre-host-installer`, `cadre-host-local-ui`) can wire into. No actual orchestration, auth, NAT, installer, or UI logic — that's their job. This ticket establishes the surface.

## Plan-stage decisions

**Shared-code refactor.** The surface cadre-host actually needs from cadre-provider is small:
- `Orchestrator` interface plus its request/result/stats types (`packages/cadre-provider/src/service/orchestrator.ts`).
- `ProviderStore` *interface pattern* (cadre-host defines its own store; the cadre-provider one has API-key / billing / customer concerns that cadre-host won't import).
- Container lifecycle types: `ContainerStatus`, `ContainerResources` (`packages/cadre-provider/src/types.ts`).

This is too thin to justify a third `@serfab/cadre-orchestration-core` package. Leave the types where they are; cadre-host depends on `@serfab/cadre-provider` (workspace) and imports only the orchestrator + lifecycle types. The trust-circle, container-storage, NAT, etc. surfaces in cadre-host are bespoke and live in this package. If sibling tickets discover a real shared concern that needs hoisting, they can extract then — premature factoring is not warranted now.

The one small assist this ticket *does* perform on cadre-provider: re-export `ContainerStatus` and `ContainerResources` from `packages/cadre-provider/src/index.ts` if they aren't already exposed (verify during implement). The `Orchestrator` type is already exported.

**CLI commands.** Per the ticket spec: `install`, `start`, `status`, `invite`, `uninstall`. Each prints `"not yet implemented"` and exits 0. `--help` and `--version` work normally via `commander`.

**Bin name.** `cadre-host` (distinct from cadre-provider's `cadre-provider` and cadre-cli's `cadre`).

**Tsconfig / package.json shape.** Mirror `packages/cadre-provider` exactly (NodeNext, ES2020, strict; build via `tsconfig.build.json`; `dist/` output; `bin` field pointing at `dist/bin/host.js`). MIT license. `engines.node >=18`.

**Test.** Single smoke test that runs `node dist/bin/host.js --help` (or invokes commander programmatically) and asserts non-empty output / exit 0. Use `vitest` for consistency with the rest of the monorepo.

## Architecture (skeleton only)

```
packages/cadre-host/
├── package.json
├── tsconfig.json
├── tsconfig.build.json
├── README.md
├── src/
│   ├── bin/
│   │   └── host.ts              # commander setup; install/start/status/invite/uninstall stubs
│   ├── index.ts                 # re-exports (empty surface initially; placeholders for sibling tickets)
│   └── __tests__/
│       └── cli.smoke.test.ts    # invokes `--help`, asserts exit 0 & non-empty stdout
```

`src/index.ts` is intentionally near-empty for now — it re-exports the cadre-provider `Orchestrator` types so consumers of cadre-host don't need a separate import, plus stub placeholder comments for what sibling tickets will add (no actual exports until those tickets land):

```typescript
// @serfab/cadre-host — self-hosted cadre node manager.
// Implementations of HostProcessOrchestrator, TrustCircleAuth, NAT layer,
// installer scripts, and local UI live in sibling subdirectories under src/
// and are added by their respective tickets.

export type {
  Orchestrator,
  OrchestratorCreateRequest,
  OrchestratorCreateResult,
  OrchestratorStats,
} from '@serfab/cadre-provider';
```

`src/bin/host.ts` sketch:

```typescript
#!/usr/bin/env node
import { Command } from 'commander';

const program = new Command();
program
  .name('cadre-host')
  .description('Sereus cadre node manager for self-hosted basement-PC deployments')
  .version('0.6.0');

for (const [name, summary] of [
  ['install', 'Install cadre-host as a system service and run first-run setup'],
  ['start', 'Start cadre-host in the foreground'],
  ['status', 'Show running status of cadre-host and the cadre nodes it manages'],
  ['invite', 'Generate an invite to add a member to the trust circle'],
  ['uninstall', 'Stop and uninstall the cadre-host service'],
] as const) {
  program
    .command(name)
    .description(summary)
    .action(() => {
      console.log(`cadre-host ${name}: not yet implemented`);
      process.exit(0);
    });
}

program.parse();
```

## docs/cadre-host.md (length target: ~150 lines)

Sections:
- **Who it's for** — the self-host persona (basement PC, small trust circle, no Docker, no ops). Contrasts with cadre-provider's multi-tenant persona.
- **Package boundary** — sibling of cadre-provider, not a mode. Depends on cadre-provider for `Orchestrator` interface and container lifecycle types. Ships its own orchestrator (host processes), auth (trust circle), installer (service-host), UI (localhost web), and NAT layer.
- **Deployment model** — one always-on host machine, N cadre nodes as child processes, friends/family connect via libp2p, UI on `http://localhost:<port>`.
- **Security posture** — trust circle, not zero-trust. Any local process on the host can fully control cadre-host (same threat model as any desktop app). Friends are authenticated by cryptographic peer identity inherited from cadre-core. No API keys.
- **Architecture sketch** — single mermaid diagram showing host process → HostProcessOrchestrator → N spawned `CadreNode` children, with the local UI and the public libp2p surface as the two external surfaces.
- **Status** — "v0.x foundation; orchestrator/auth/NAT/installer/UI implementations forthcoming (tickets `cadre-host-*`)."

## docs/architecture.md update

Under the "Flexible deployment" bullet and the "Package Structure" mermaid, add a node for `@serfab/cadre-host` with the one-liner "self-hosted basement-PC deployments — see [cadre-host.md](cadre-host.md)." Don't restructure the diagram beyond adding the new node — keep the diff minimal.

## README.md

Short. Three sections:
- **What** — one-paragraph persona pitch.
- **Install** — placeholder pointing at the forthcoming installer ticket: "Run `npm install -g @serfab/cadre-host && cadre-host install` (full installer arriving in a follow-up release)."
- **More** — links to `docs/cadre-host.md` and `docs/architecture.md`.

## Workspace integration

- The root `package.json` already has `"workspaces": ["packages/*"]` — no change needed.
- Add a `pub:cadre-host` script entry under `scripts` and append it to the `pub` aggregator script, matching the existing pattern for cadre-provider. Use `node scripts/publish-package.js cadre-host` (verify the script handles the new package — likely just takes the name and works).
- No root-level tsconfig references to add (none exist for the sibling packages).

## Tests / validation

- `cd packages/cadre-host && yarn build` — succeeds; emits `dist/bin/host.js` and `dist/index.js` with `.d.ts`.
- `node packages/cadre-host/dist/bin/host.js --help` — exits 0, prints command list.
- `cd packages/cadre-host && yarn test` — smoke test passes.
- From repo root: `yarn workspaces foreach -At run build` — completes (validates cadre-provider → cadre-host topological order if dependent).
- `yarn typecheck` at repo root remains green.

## TODO

Package scaffold
- Create `packages/cadre-host/package.json` mirroring cadre-provider's shape (name `@serfab/cadre-host`, bin `cadre-host` → `dist/bin/host.js`, deps: `commander`, `debug`, `fastify`, `@serfab/cadre-provider` (workspace:^), `@serfab/cadre-core` (workspace:^); devDeps: `@types/debug`, `@types/node`, `rimraf`, `typescript`, `vitest`; scripts: clean/build/test/dev:test/start matching cadre-provider).
- Create `packages/cadre-host/tsconfig.json` and `tsconfig.build.json` copying the cadre-provider versions verbatim.
- Create `packages/cadre-host/src/bin/host.ts` per sketch above. Add `#!/usr/bin/env node` shebang.
- Create `packages/cadre-host/src/index.ts` per sketch above (re-export Orchestrator types from cadre-provider, placeholder comment).

Smoke test
- Create `packages/cadre-host/src/__tests__/cli.smoke.test.ts`. Use `child_process.execFileSync` (or `execaNode` if already in the monorepo — check; otherwise plain node) to run `dist/bin/host.js --help`; assert exit 0 and that stdout contains all five subcommand names.
- Verify `yarn build` produces the bin file before the test runs (test should depend on build or invoke `tsx` directly on the source — `tsx` adds a dep; prefer the build-then-run pattern matching cadre-provider's test setup).

Cadre-provider re-exports
- Confirm `Orchestrator`, `OrchestratorCreateRequest`, `OrchestratorCreateResult`, `OrchestratorStats` are exported from `packages/cadre-provider/src/index.ts` (they are). No change needed unless verification reveals a gap.
- No code changes inside cadre-provider — the shared-code decision is "leave it where it is."

Docs
- Write `docs/cadre-host.md` (~150 lines, sections as described). Include one mermaid diagram of the host-process topology.
- Edit `docs/architecture.md`: add `@serfab/cadre-host` to the package structure mermaid and the "Flexible deployment" bullet. Append a one-liner under "Implementation Status" noting cadre-host is at foundation stage.
- Write `packages/cadre-host/README.md` per the three-section sketch.

Root package.json
- Add `"pub:cadre-host": "node scripts/publish-package.js cadre-host"` to scripts.
- Append `&& yarn pub:cadre-host` to the existing `pub` chain.
- Verify `scripts/publish-package.js` accepts arbitrary package names without modification.

Build verification
- Run `yarn install` at repo root to register the new workspace.
- Run `yarn workspaces foreach -At run build` and confirm it completes including cadre-host.
- Run `yarn test` at repo root and confirm the new smoke test passes.
- Run `node packages/cadre-host/dist/bin/host.js --help` manually and eyeball the output.

## Out of scope (deferred to sibling tickets)

- `HostProcessOrchestrator` implementation — `cadre-host-process-orchestrator`.
- Trust-circle auth — `cadre-host-trust-circle`.
- NAT / DDNS — `cadre-host-nat`.
- Installer / service-host integration / update-at-launch — `cadre-host-installer`.
- Local UI and management API — `cadre-host-local-ui`.

Each sibling adds its own subdirectory under `packages/cadre-host/src/` and extends `src/index.ts` with the surfaces it introduces.
