description: Rewrite the @serfab/cadre-cli Docker build to use the Yarn 4 workspace toolchain (replace npm ci / package-lock with yarn install) so `docker compose up` produces a working cadre node
files: packages/cadre-cli/docker/Dockerfile, packages/cadre-cli/docker/docker-compose.yml, packages/cadre-cli/package.json, packages/cadre-core/package.json, packages/strand-proto/package.json, package.json, .yarnrc.yml, yarn.lock
effort: high
----

# Make the cadre-cli Docker image build under the Yarn 4 workspace toolchain

## Problem (diagnosed in the fix stage)

`packages/cadre-cli/docker/Dockerfile` is written for an npm project, but Sereus is a
Yarn 4.12.0 workspace (`package.json` → `packageManager: yarn@4.12.0`, `nodeLinker: node-modules`).
The build fails at several distinct points:

1. **Nonexistent lockfile.** `COPY package.json package-lock.json ./` (Dockerfile:15) aborts
   the build — there is no `package-lock.json`; the repo uses `yarn.lock`.
2. **npm can't do `workspace:`.** `npm ci --ignore-scripts` (line 20) cannot resolve the
   `workspace:^` protocol. cadre-cli → `@serfab/cadre-core` is `workspace:^`
   (`packages/cadre-cli/package.json:58`); cadre-core → `@serfab/strand-proto` is also
   `workspace:^` (`packages/cadre-core/package.json:66`).
3. **Missing workspace member.** The Dockerfile never copies `packages/strand-proto`, but
   cadre-core depends on it, so even a corrected install/build would fail to resolve it.
4. **Sibling-repo `resolutions` (the deepest issue).** The root `package.json` `resolutions`
   block (lines 10-18) force `@optimystic/*` and `@quereus/*` to
   `link:../optimystic/...` / `link:../quereus/...` — sibling checkouts *outside* the Docker
   build context (the compose `context` is `../../..`, i.e. the Sereus repo root). These are a
   developer convenience for local co-development. `yarn.lock` pins them to those `link:`
   targets, so any lockfile-faithful (`--immutable`) install inside the image fails because the
   paths don't exist in the context.

## Key facts established during the fix stage

- The pinned `@optimystic/*` and `@quereus/*` versions **are published to the registry**
  (`@optimystic/db-core` 0.13.5, `@optimystic/db-p2p` 0.13.5, `@quereus/quereus` 3.3.0 which
  satisfies cadre-core's `^3.2.1`). A registry-based install that drops the `link:`
  resolutions therefore resolves cleanly. This is also the correct semantics for a deployable
  image: it ships the published versions an external consumer of cadre-cli would get, not a
  developer's local sibling checkout.
- Build closure for cadre-cli is exactly three workspaces: `strand-proto` → `cadre-core` →
  `cadre-cli`. None of the other six workspaces (cadre-host, cadre-provider, reference apps,
  integration-tests, quereus-plugin-sereus) are needed.
- Build order matters: cadre-core/cadre-cli import their workspace deps' built `dist` via the
  node_modules symlink (no TS project `references`), so deps must build first. `yarn workspaces
  foreach -At run build` builds in topological order.
- Yarn 4.12.0 bundles the `workspaces foreach` / `workspaces focus` commands — no `plugins:`
  entry is required (verified: `yarn workspaces foreach --help` works with the repo's bare
  `.yarnrc.yml`). The image gets yarn via `corepack enable` (Node 22 alpine ships corepack).
- Each package's `tsconfig.json` is self-contained and `tsconfig.build.json` extends only the
  local `./tsconfig.json` — there is no root base tsconfig to copy.
- The repo's `.yarnrc.yml` contains a **hardcoded `npmAuthToken`** (a leaked secret) and a
  `packageExtensions` block only relevant to react-native. Do **not** copy that file into the
  image. Use a minimal Docker-specific `.yarnrc.yml` with just `nodeLinker: node-modules`. The
  optimystic/quereus packages are public, so no auth token is needed for install.
- There is no `.dockerignore`; the whole repo is in the build context (fine — we COPY narrowly).

## Approach

Add two small Docker-specific workspace-root files under `packages/cadre-cli/docker/` and
rewrite the Dockerfile to a three-stage build (deps install → compile → minimal production),
all using yarn. The Docker-specific root manifest narrows `workspaces` to the three needed
packages and **omits the sibling-repo `resolutions`**, so the in-image `yarn install` resolves
`@optimystic/*` / `@quereus/*` from the registry. Because the existing `yarn.lock` is pinned to
the `link:` targets, the in-image install is intentionally **not** `--immutable` — it generates
a fresh lockfile scoped to this image. Document this deviation clearly in a Dockerfile comment.

### New file: `packages/cadre-cli/docker/workspace-root.package.json`

```json
{
  "name": "sereus-workspace",
  "version": "0.7.1",
  "private": true,
  "packageManager": "yarn@4.12.0",
  "workspaces": [
    "packages/strand-proto",
    "packages/cadre-core",
    "packages/cadre-cli"
  ]
}
```

(No `resolutions` → optimystic/quereus come from the registry. No root devDeps needed: each
package carries its own `typescript` devDep used by its `build` script.)

### New file: `packages/cadre-cli/docker/workspace.yarnrc.yml`

```yaml
nodeLinker: node-modules
```

### Rewritten `packages/cadre-cli/docker/Dockerfile` (reference shape)

```dockerfile
# ============================================================================
# Stage 1: install workspace dependencies
#   NOTE: uses a Docker-specific workspace root that omits the repo's
#   `resolutions` linking @optimystic/* and @quereus/* to sibling repos outside
#   this build context. Those packages are installed from the registry instead.
#   The install is intentionally NOT --immutable: the repo yarn.lock pins the
#   link: targets, so we regenerate a lockfile scoped to this image.
# ============================================================================
FROM node:22-alpine AS deps
WORKDIR /app
RUN apk add --no-cache python3 make g++
RUN corepack enable

COPY packages/cadre-cli/docker/workspace-root.package.json ./package.json
COPY packages/cadre-cli/docker/workspace.yarnrc.yml ./.yarnrc.yml
COPY packages/strand-proto/package.json packages/strand-proto/
COPY packages/cadre-core/package.json   packages/cadre-core/
COPY packages/cadre-cli/package.json    packages/cadre-cli/

RUN yarn install

# ============================================================================
# Stage 2: compile the three workspaces in topological order
# ============================================================================
FROM deps AS build
WORKDIR /app

COPY packages/strand-proto/src packages/strand-proto/src
COPY packages/strand-proto/tsconfig.json packages/strand-proto/tsconfig.build.json packages/strand-proto/
COPY packages/cadre-core/src packages/cadre-core/src
COPY packages/cadre-core/tsconfig.json packages/cadre-core/tsconfig.build.json packages/cadre-core/
COPY packages/cadre-cli/src packages/cadre-cli/src
COPY packages/cadre-cli/tsconfig.json packages/cadre-cli/tsconfig.build.json packages/cadre-cli/

RUN yarn workspaces foreach -At run build

# ============================================================================
# Stage 3: production-only dependency tree
# ============================================================================
FROM node:22-alpine AS prod-deps
WORKDIR /app
RUN corepack enable
COPY packages/cadre-cli/docker/workspace-root.package.json ./package.json
COPY packages/cadre-cli/docker/workspace.yarnrc.yml ./.yarnrc.yml
COPY packages/strand-proto/package.json packages/strand-proto/
COPY packages/cadre-core/package.json   packages/cadre-core/
COPY packages/cadre-cli/package.json    packages/cadre-cli/
COPY --from=deps /app/yarn.lock ./yarn.lock
RUN yarn workspaces focus @serfab/cadre-cli --production

# ============================================================================
# Stage 4: minimal runtime image
# ============================================================================
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -S cadre && adduser -S cadre -G cadre

# production node_modules (registry deps + symlinked workspace packages)
COPY --from=prod-deps /app/node_modules ./node_modules
# built workspace outputs (dist) + their manifests
COPY --from=build /app/packages/strand-proto/dist ./packages/strand-proto/dist
COPY --from=build /app/packages/strand-proto/package.json ./packages/strand-proto/
COPY --from=build /app/packages/cadre-core/dist ./packages/cadre-core/dist
COPY --from=build /app/packages/cadre-core/package.json ./packages/cadre-core/
COPY --from=build /app/packages/cadre-cli/dist ./packages/cadre-cli/dist
COPY --from=build /app/packages/cadre-cli/package.json ./packages/cadre-cli/

# ... entrypoint, user, data dir, healthcheck, env, ports unchanged from current Dockerfile ...
```

Keep the existing production-stage tail (entrypoint copy/chmod, `/data` volume + ownership,
`EXPOSE`, `HEALTHCHECK`, `USER cadre`, the `ENV` block, `ENTRYPOINT`/`CMD`) exactly as it is
today — only the build/install mechanics change.

### Caveat to verify during implementation (`yarn workspaces focus --production` + symlinks)

`yarn workspaces focus @serfab/cadre-cli --production` symlinks the workspace packages
(strand-proto, cadre-core) into `node_modules` and installs only production deps. The runtime
needs those symlink targets to contain built `dist` — which Stage 4 supplies by copying each
package's `dist` to its workspace path. Confirm the symlinks from `prod-deps`'s `node_modules`
resolve to `/app/packages/<pkg>` (matching the copied layout) and that `node
/app/packages/cadre-cli/dist/bin/cadre.js --help` runs in the final image. If `focus`'s
symlinks don't line up with the copied paths, fall back to copying the full build-stage
`node_modules` (as the original Dockerfile did) and accept a larger image, or run a plain
`yarn install` in `prod-deps` and prune. Prefer the `focus` path for image minimality; only
fall back if it doesn't resolve.

## TODO

- [ ] Add `packages/cadre-cli/docker/workspace-root.package.json` (workspaces narrowed to
      strand-proto, cadre-core, cadre-cli; no `resolutions`).
- [ ] Add `packages/cadre-cli/docker/workspace.yarnrc.yml` (`nodeLinker: node-modules` only —
      no npmAuthToken, no packageExtensions).
- [ ] Rewrite `packages/cadre-cli/docker/Dockerfile` per the reference shape: corepack-enabled
      yarn, deps/build/prod-deps/runtime stages, copy strand-proto + cadre-core + cadre-cli,
      build with `yarn workspaces foreach -At run build`. Remove all `npm ci` / `package-lock`
      / `npm run build -w` usage. Add the comment explaining the intentional non-immutable,
      resolutions-free install.
- [ ] Ensure the runtime stage ships only `dist` + production `node_modules` and preserves the
      current entrypoint/user/healthcheck/env/ports tail unchanged.
- [ ] Add a `.dockerignore` (at repo root or `packages/cadre-cli/docker/`) excluding
      `**/node_modules`, `**/dist`, `.yarn/cache`, `.git`, `**/*.tsbuildinfo` to keep the build
      context small and avoid copying host artifacts into the image. Verify the COPY paths
      still resolve with it in place.
- [ ] Build it: from the repo root run
      `docker build -f packages/cadre-cli/docker/Dockerfile -t sereus-cadre-node:local . 2>&1 | tee /tmp/cadre-docker-build.log`
      (stream output — the build is multi-minute). NOTE: a full docker build likely exceeds the
      agent idle/wall-clock limits and may not be runnable under tess — if so, document the
      deferral and leave the build verification to the reviewer / CI / a human, but ensure all
      file changes are complete and internally consistent.
- [ ] Smoke-test the image: `docker run --rm sereus-cadre-node:local cadre --help` (passes
      through the entrypoint's default `*` case to `node .../cadre.js`), and verify
      `docker compose -f packages/cadre-cli/docker/docker-compose.yml up` starts a node when a
      `.env` with `CADRE_PARTY_ID` + `CADRE_BOOTSTRAP_NODES` is supplied (compose `context` is
      already `../../..`, so no compose change is required unless build verification surfaces
      one).
- [ ] If you cannot run docker under tess, at minimum verify locally that
      `yarn workspaces foreach -At run build` succeeds for the three packages and that the
      Docker-specific `workspace-root.package.json` + `workspace.yarnrc.yml` install cleanly in
      a scratch dir (registry resolution of optimystic/quereus), then hand off honestly noting
      the in-container build was not executed.
