----
description: Docker build broken against the yarn-workspace monorepo (npm ci + missing package-lock + workspace:^)
files: packages/cadre-cli/docker/Dockerfile, packages/cadre-cli/package.json, packages/cadre-cli/docker/docker-compose.yml
----
The `@serfab/cadre-cli` Docker image cannot be built against this monorepo. The build Dockerfile is written for an npm-based project, but Sereus is a Yarn 4 workspace, so `docker compose up` fails before any application code compiles.

In `packages/cadre-cli/docker/Dockerfile`, the build stage runs `COPY package.json package-lock.json ./` (line 15) followed by `RUN npm ci --ignore-scripts` (line 20). The repo has no root `package-lock.json` — it uses `yarn.lock` — so the `COPY` itself fails the build because the source path does not exist. Even if the copy were corrected to bring in `yarn.lock`, `npm ci` cannot resolve the `workspace:^` protocol that cadre-cli uses for its dependency on `@serfab/cadre-core` (`packages/cadre-cli/package.json:58`, `"@serfab/cadre-core": "workspace:^"`). The `npm run build -w ...` invocations later in the file (lines 30-31) similarly assume the npm workspace toolchain rather than yarn.

This diverges from Sereus's stated goals. `@serfab/cadre-cli` is the headless CLI runtime and its README and `packages/cadre-cli/docker/docker-compose.yml` advertise Docker as a first-class, headless deployment path for a cadre node. With the build broken, that documented deployment target is unreachable. It also conflicts with the project mandate (AGENTS.md) that this monorepo uses yarn — the container toolchain must match the rest of the repo.

Expected behavior: the container build must use the Yarn 4 workspace toolchain so that the `workspace:^` dependency on `@serfab/cadre-core` resolves correctly and both packages build inside the image. Specifically, the build should rely on `yarn install` with the workspace's lockfile and resolution (not `npm ci` against a nonexistent `package-lock.json`), and the documented `docker compose up` path (`packages/cadre-cli/docker/docker-compose.yml`) should produce a working cadre-cli image and start a node. The production stage should continue to ship only the built `dist` output and the runtime dependencies needed for a minimal image.

Key references:
- `packages/cadre-cli/docker/Dockerfile` (lines 15, 20, 30-31 — npm ci / package-lock / npm workspace build)
- `packages/cadre-cli/package.json:58` (`@serfab/cadre-core` via `workspace:^`)
- `packages/cadre-cli/docker/docker-compose.yml` (advertised `docker compose up` deployment path)
