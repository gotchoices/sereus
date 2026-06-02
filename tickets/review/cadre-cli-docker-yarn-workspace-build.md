description: Review the rewritten @serfab/cadre-cli Docker build (Yarn 4 workspace toolchain) — verify the in-container build/run, which could not be executed under tess (no docker available)
files: packages/cadre-cli/docker/Dockerfile, packages/cadre-cli/docker/workspace-root.package.json, packages/cadre-cli/docker/workspace.yarnrc.yml, .dockerignore, packages/cadre-cli/docker/docker-compose.yml, ops/docker/sereus-node/docker-compose.yml
----

# Review: cadre-cli Docker build under the Yarn 4 workspace toolchain

## What was done

Replaced the npm-based `packages/cadre-cli/docker/Dockerfile` with a four-stage Yarn 4
workspace build, plus two Docker-specific workspace-root files and a repo-root `.dockerignore`.

### Files added
- **`packages/cadre-cli/docker/workspace-root.package.json`** — Docker-specific workspace root.
  `workspaces` narrowed to the **two** packages in the build closure (`packages/cadre-core`,
  `packages/cadre-cli`); **no `resolutions` block** (so `@optimystic/*` / `@quereus/*` resolve
  from the registry instead of the repo's `link:` sibling-repo targets).
- **`packages/cadre-cli/docker/workspace.yarnrc.yml`** — `nodeLinker: node-modules` only. Does
  NOT carry the repo `.yarnrc.yml`'s leaked `npmAuthToken` or its react-native
  `packageExtensions` (optimystic/quereus are public, no auth needed).
- **`.dockerignore`** (repo root) — excludes `**/node_modules`, `**/dist`, `**/*.tsbuildinfo`,
  `.yarn/cache`, `.yarn/install-state.gz`, `.git`.

### Files changed
- **`packages/cadre-cli/docker/Dockerfile`** — fully rewritten. Stages: `deps` (corepack yarn
  install of manifests) → `build` (`yarn workspaces foreach -At run build`, topological) →
  `prod-deps` (`yarn workspaces focus @serfab/cadre-cli --production`) → runtime (dist +
  production node_modules). The production-stage tail (entrypoint, `/data` volume + ownership,
  `EXPOSE`, `HEALTHCHECK`, `USER cadre`, `ENV`, `ENTRYPOINT`/`CMD`) is unchanged from the
  original.

## Key deviation from the ticket spec — READ THIS

The ticket's fix-stage diagnosis was based on a now-stale codebase snapshot. Two corrections
were necessary and are the highest-value things to review:

1. **strand-proto is NOT in the build closure.** The diagnosis claimed
   `cadre-core → @serfab/strand-proto` is a `workspace:^` dep (citing
   `packages/cadre-core/package.json:66`). That is false in the current tree: cadre-core's
   manifest has **no** `@serfab/strand-proto` dependency, and strand-proto is only referenced in
   code *comments* (`packages/cadre-core/src/strand-formation-protocol.ts`, as the deprecated
   transport it replaced). The build closure is exactly **cadre-core → cadre-cli**. The
   Dockerfile and workspace root therefore copy/narrow only those two packages — strand-proto is
   intentionally omitted. **Reviewer: confirm strand-proto really is dead weight and nothing at
   runtime dynamically imports it.**

2. **The install MUST be seeded with the repo `yarn.lock`** (the ticket's reference shape used a
   bare `yarn install` with no lockfile — that is broken). A lockfile-free install lets Yarn
   drift to the newest satisfying transitive versions: `@libp2p/interface 3.2.3` /
   `libp2p 3.3.3` / nested `@multiformats/multiaddr 13.0.3`, whose `Uint8Array<ArrayBufferLike>`
   vs `Uint8Array<ArrayBuffer>` typings are **incompatible** with cadre-core's top-level
   `@multiformats/multiaddr 12.5.1`, so `tsc` fails with TS2345 in `seed-bootstrap.ts`,
   `strand-formation-protocol.ts`, `strand-wake-protocol.ts`. The repo's `yarn.lock` pins the
   known-good set (`@libp2p/interface 3.1.0` / `libp2p 3.1.3` / nested multiaddr `13.0.1`), which
   builds. So the Dockerfile `COPY yarn.lock ./yarn.lock` into the `deps` stage and runs a
   **non-immutable** `yarn install` (the lock still pins the `link:` targets for the dropped
   resolutions, so it regenerates registry entries for optimystic/quereus while keeping every
   other pin). This is documented in the Dockerfile header comment.

## Validation performed (native, NOT in-container — no docker under tess)

Docker is not installed in the tess environment, so the actual `docker build` / `docker compose
up` could not run. Instead, every stage's mechanics were reproduced natively with the repo's
real `yarn@4.12.0` against the live npm registry, in throwaway scratch dirs:

- **deps install (seeded lock, resolutions dropped):** `yarn install` → exit 0. Confirmed
  `@optimystic/db-core@npm:0.13.5`, `@optimystic/db-p2p@npm:0.13.5`,
  `@optimystic/quereus-plugin-*@npm:0.13.5`, `@quereus/quereus@npm:3.3.0` resolved **from the
  registry** (the `link:` targets were dropped). Transitive pins held at the known-good versions.
- **build:** `yarn workspaces foreach -At run build` → exit 0, topological (cadre-core then
  cadre-cli). (A control run WITHOUT the seeded lock reproduced the `tsc` TS2345 failure above —
  this is why the lock copy is mandatory.)
- **prod-deps:** `yarn workspaces focus @serfab/cadre-cli --production` → exit 0. The workspace
  symlink `node_modules/@serfab/cadre-core` resolves to `packages/cadre-core`, matching the
  runtime stage's `/app/packages/<pkg>` COPY layout — so the ticket's "fall back to copying the
  full build-stage node_modules" path is **not** needed.
- **runtime smoke:** `node packages/cadre-cli/dist/bin/cadre.js --help` ran cleanly against both
  the full and the production-only dependency trees (exit 0, prints the cadre CLI usage). This
  exercises the real runtime import closure (commander + all transitive libp2p/optimystic/quereus
  deps load).
- The **real repo build** (`yarn workspaces foreach -Rpt --from @serfab/cadre-cli run build`)
  also passes (exit 0) — baseline that the source itself compiles.

## What the reviewer still needs to do (the floor, not the ceiling)

The in-container path was never executed. Please run, from the repo root:

```
docker build -f packages/cadre-cli/docker/Dockerfile -t sereus-cadre-node:local . 2>&1 | tee /tmp/cadre-docker-build.log
docker run --rm sereus-cadre-node:local cadre --help
```

Then a `docker compose -f packages/cadre-cli/docker/docker-compose.yml up` with a `.env`
supplying `CADRE_PARTY_ID` + `CADRE_BOOTSTRAP_NODES` (see `docker/env.example`) to confirm the
entrypoint generates config, creates an identity, and starts a node. Note `ops/docker/sereus-node/docker-compose.yml`
builds the **same** Dockerfile from the same repo-root context — worth a sanity build too.

Specific things to scrutinize in-container that native testing could not fully cover:
- **Alpine symlink form.** Native (Windows) yarn created *absolute* workspace symlinks; alpine
  yarn typically creates *relative* ones. Either resolves because both `prod-deps` and the
  runtime stage root at `/app`, but verify `node /app/packages/cadre-cli/dist/bin/cadre.js
  --help` actually runs in the final image (i.e. `COPY --from=prod-deps /app/node_modules`
  preserved the symlinks and they resolve to the copied `/app/packages/<pkg>`).
- **Native addon builds.** `deps` installs `python3 make g++` for any node-gyp deps; confirm the
  install doesn't need them at *runtime* (the runtime stage omits them). The smoke test only
  loaded `--help`; a real `start` exercises more of the libp2p/native surface.
- **Registry availability / version float.** The install is non-immutable and pulls optimystic
  0.13.5 / quereus 3.3.0 from npm at build time. If those are ever unpublished or float, the
  build changes. Consider whether the regenerated lockfile should be committed for
  reproducibility (currently it is generated fresh per build).

## Known non-blocking issue to note

`yarn install` and `yarn workspaces focus` both emit a peer-dependency **warning** (YN0060/
YN0086): `@quereus/quereus` 3.3.0 doesn't satisfy `~0.16.2` requested by
`@optimystic/quereus-plugin-crypto` (and others). This is a warning only — install, build, and
the `--help` runtime smoke all succeed. It originates from stale peer ranges in the published
optimystic plugins and is present in the normal repo install too (not introduced by this
ticket). Flagging in case the reviewer's in-container `start` surfaces a real runtime
incompatibility behind it.

## No pre-existing test failures

No `tickets/.pre-existing-error.md` was written — the only build failure encountered (the
multiaddr TS2345 skew) was caused by the install strategy and is resolved by the seeded-lock
approach, not a pre-existing break.
