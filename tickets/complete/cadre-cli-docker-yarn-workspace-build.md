description: Rewrote the @serfab/cadre-cli Docker build to the Yarn 4 workspace toolchain (npm → yarn, four-stage build, Docker-specific workspace root) so `docker compose up` produces a working cadre node
files: packages/cadre-cli/docker/Dockerfile, packages/cadre-cli/docker/workspace-root.package.json, packages/cadre-cli/docker/workspace.yarnrc.yml, .dockerignore, packages/cadre-cli/docker/docker-compose.yml, ops/docker/sereus-node/docker-compose.yml, packages/cadre-cli/README.md
----

# Complete: cadre-cli Docker build under the Yarn 4 workspace toolchain

## Summary

The npm-based `packages/cadre-cli/docker/Dockerfile` was replaced with a four-stage Yarn 4
workspace build (`deps` install → `build` compile → `prod-deps` focus → minimal runtime),
plus a Docker-specific workspace root (`workspace-root.package.json` narrowing `workspaces` to
`cadre-core` + `cadre-cli` and dropping the sibling-repo `resolutions`), a minimal Docker
`.yarnrc.yml` (`nodeLinker: node-modules` only, no leaked token), and a repo-root
`.dockerignore`. The repo `yarn.lock` is seeded into the image to pin known-good transitive
versions; the install is intentionally non-immutable so `@optimystic/*` / `@quereus/*`
re-resolve from the registry instead of the local `link:` targets. See the Dockerfile header
for the full rationale.

## Review findings

### Scope of review

Read the full implement diff (`362f073`) with fresh eyes, then every file the change touches
and the docs/compose files it should have touched. Verified the implementer's two key
deviations from the (stale) fix-stage spec, re-derived the build closure from the manifests,
and independently reproduced the Dockerfile's stage mechanics natively (no docker in the
environment, same as implement).

### What was checked and confirmed correct

- **Build closure (strand-proto exclusion).** Confirmed independently: `cadre-core/package.json`
  has **no** `@serfab/strand-proto` dependency; `cadre-core/src` references strand-proto only in
  comments (deprecated transport), with no static or dynamic import. The closure is exactly
  `cadre-core → cadre-cli`. Excluding strand-proto is correct.
- **Resolutions dropped → registry resolution.** Reproduced in a scratch dir with the
  Docker-specific root + seeded lock + `yarn install` (non-immutable): exit 0, with
  `@optimystic/*@npm:^0.13.5` / `@quereus/quereus@npm:^3.2.1` resolved from the registry (no
  `link:`), and **no auth token required**.
- **Seeded-lock build.** `yarn workspaces foreach -At run build` in the scratch tree → exit 0;
  both `cadre-core/dist/index.js` and `cadre-cli/dist/bin/cadre.js` produced. (Confirms the
  seeded lock keeps the known-good transitive set; the un-pinned drift is the multiaddr/libp2p
  TS2345 skew tracked in `optimystic-db-p2p-libp2p-dep-skew`.)
- **prod-deps focus.** `yarn workspaces focus @serfab/cadre-cli --production` → exit 0;
  `node_modules/@serfab/cadre-core` symlinked to the workspace path; `typescript` (devDep)
  correctly absent from the production tree.
- **Runtime-stage layout.** Assembled the final-image layout (production `node_modules` +
  symlink + copied `dist`) and ran `node packages/cadre-cli/dist/bin/cadre.js --help` against
  it → exit 0, full import closure loads. This mirrors Dockerfile stage 4.
- **No missing bundled assets.** `cadre-core` reads no files at runtime; `cadre-cli`'s only
  `readFileSync` calls (`config/loader.ts`) target user-supplied config/key paths under `/data`,
  not package-bundled assets. No `.qsql`/template/`import.meta.url` asset the minimal image
  would drop.
- **Compose wiring.** Both `packages/cadre-cli/docker/docker-compose.yml` and
  `ops/docker/sereus-node/docker-compose.yml` use `context: ../../..` (repo root) +
  `dockerfile: packages/cadre-cli/docker/Dockerfile` — consistent with the new build and the
  repo-root `.dockerignore`.
- **Lint + build.** `eslint` on both packages → 0 errors (56 pre-existing backlogged `warn`s,
  unrelated). Closure build + `cadre --help` smoke → exit 0.

### Minor findings — fixed in this pass

- **`prod-deps` lacked the native-build toolchain.** The `deps` stage installs
  `python3 make g++`, but `prod-deps` (which also runs an install via `yarn workspaces focus`)
  did not. A production dep shipping a glibc prebuild but no musl prebuild would compile from
  source on Alpine and fail in `prod-deps` while succeeding in `deps` — the classic
  works-native/fails-in-container gap the implementer flagged. **Fixed:** added
  `RUN apk add --no-cache python3 make g++` to `prod-deps`. The stage is discarded (only its
  `node_modules` is copied), so this adds no final-image bulk.
- **Stale `README` build-from-source instructions.** `packages/cadre-cli/README.md` told
  developers to build from a git clone with `npm install` + `npm run build -w …` — which fails
  on this Yarn-4 `workspace:`-protocol repo (the exact npm-can't-do-workspaces problem this
  ticket fixed for Docker). **Fixed:** all three occurrences now use `yarn install` +
  `yarn workspaces foreach -Rt --from '@serfab/cadre-cli' run build` (verified exit 0; the sudo
  git-method block also `corepack enable`s). The npm-based *consumer* install lines (global
  install of the published package) were left as-is — npm is fine for registry consumers. Also
  fixed the dangling `docker/README.md` link (no such file) to point at the `docker/` directory
  contents.

### Major findings — filed as new tickets (out of scope to fix here)

- **`tickets/backlog/yarnrc-leaked-npm-auth-token.md`** — the repo root `.yarnrc.yml` carries a
  live `npmAuthToken` committed to VCS. Pre-existing (not introduced by this ticket, and the
  Docker build correctly avoids copying it), but a real leaked credential needing rotation +
  de-tracking. Human-driven (needs npm account access).
- **`tickets/backlog/cadre-docker-build-reproducibility.md`** — the image's non-immutable
  install regenerates the lockfile per build, so versions can float with registry state. The
  pinning via the seeded repo lock is load-bearing but not reproducible. Hardening follow-up
  (commit a docker-specific resolutions-free lock + switch back to `--immutable`). Chained
  `prereq: optimystic-db-p2p-libp2p-dep-skew`.

### Not done / deferred (with reason)

- **In-container `docker build` / `docker compose up` was NOT executed** — docker is not
  installed in the agent environment (same constraint as the implement stage; verified
  `docker --version` → command not found). All stage *mechanics* were reproduced natively with
  the real `yarn@4.12.0` against the live registry, but the actual image build and a live
  `start` (libp2p networking, identity creation, config generation) remain unverified in-image.
  A human/CI must still run, from the repo root:
  ```
  docker build -f packages/cadre-cli/docker/Dockerfile -t sereus-cadre-node:local . 2>&1 | tee /tmp/cadre-docker-build.log
  docker run --rm sereus-cadre-node:local --help
  docker compose -f packages/cadre-cli/docker/docker-compose.yml up   # with .env (CADRE_PARTY_ID, CADRE_BOOTSTRAP_NODES)
  ```
  Note: the entrypoint's pass-through runs `node cadre.js "$@"`, so the smoke command is
  `docker run --rm <img> --help` (the handoff's `… cadre --help` would pass a literal "cadre"
  as the subcommand).
- **Peer-dependency warning (YN0060/YN0086)** — `@quereus/quereus` 3.3.0 vs the `~0.16.2` the
  optimystic plugins request. Reproduced in every native install; warning only (install/build/
  runtime `--help` all succeed). Originates from stale published peer ranges, present in the
  normal repo install too — not introduced here. Left as-is; flagged in case an in-container
  `start` surfaces a real incompatibility behind it.

## Pre-existing test failures

None. No `tickets/.pre-existing-error.md` was written; lint and the closure build/smoke all
pass at HEAD.
