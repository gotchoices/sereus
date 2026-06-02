description: The cadre-cli Docker image does a non-immutable yarn install that regenerates the lockfile per build — make the image build reproducible
prereq: optimystic-db-p2p-libp2p-dep-skew
files: packages/cadre-cli/docker/Dockerfile, packages/cadre-cli/docker/workspace-root.package.json, yarn.lock
----

# Make the cadre-cli Docker image build reproducible

## Problem

`packages/cadre-cli/docker/Dockerfile` (the Yarn 4 workspace rewrite) runs a **non-immutable**
`yarn install` in its `deps` stage. This is intentional today: the repo `yarn.lock` is seeded
into the image to pin known-good transitive versions, but it pins `@optimystic/*` / `@quereus/*`
to `link:` sibling-repo targets that do not exist in the build context, so the install must
regenerate those entries from the registry — which only an immutable-disabled install allows.

The side effect is that the **effective lockfile is regenerated on every image build**. Two
builds at different times can resolve different versions of `@optimystic/*`, `@quereus/*`, and
any transitive deps whose ranges still float, even though the seeded lock holds most pins. That
defeats reproducible builds and means a registry change (a republish, a new satisfying version,
or an unpublish) silently alters the image. The review's native reproduction also reconfirmed the
known multiaddr/libp2p type-skew (tracked separately in `optimystic-db-p2p-libp2p-dep-skew`) is
exactly what an un-pinned drift reintroduces, so the pinning is load-bearing.

## Expected behavior

A cadre-cli image build resolves the **same** dependency versions every time, independent of
registry state at build time, while still pulling `@optimystic/*` / `@quereus/*` from the
registry (not sibling `link:` checkouts).

## Possible directions (for the planner — not prescriptive)

- Generate and **commit a Docker-specific lockfile** (resolutions-free, registry-pinned) under
  `packages/cadre-cli/docker/`, copy it into the image, and switch the install back to
  `--immutable`. Add a documented refresh step so it tracks the repo lock intentionally rather
  than drifting per build.
- Or decouple the repo's sibling-repo `resolutions` from `yarn.lock` so a single lock works both
  for local dev and the image (larger change to the dev workflow).

## Context

Surfaced by the `cadre-cli-docker-yarn-workspace-build` review. The current non-immutable
approach is documented in the Dockerfile header comment and is correct/working — this ticket is
hardening for supply-chain reproducibility, not a build break.
