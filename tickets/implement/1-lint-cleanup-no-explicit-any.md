----
description: burn down the @typescript-eslint/no-explicit-any warning backlog (~68 sites) and promote the rule from `warn` to `error`
prereq: lint-cleanup-mechanical
files: eslint.config.mjs, packages/cadre-core/test/seed-bootstrap.spec.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-provider/src/config/loader.ts, packages/cadre-provider/src/server/routes.ts, packages/cadre-provider/src/server/auth.ts, packages/cadre-provider/src/service/docker-orchestrator.ts, packages/quereus-plugin-sereus/test/plugin.spec.ts, packages/quereus-plugin-sereus/test/browser-shape.spec.ts, packages/quereus-plugin-sereus/src/compose-strand.ts
----

# Lint cleanup, part 2: kill `no-explicit-any` → error

Second of three burndown tickets from `build-health-lint-warning-cleanup`. This is the bulk of the
backlog: **68** `@typescript-eslint/no-explicit-any` warnings. "Don't be type lazy — avoid `any`"
(AGENTS.md). After the sites are clean, promote the rule to `error`.

Depends on lint-cleanup-mechanical only to serialize edits to `eslint.config.mjs` (avoids conflicts); no
code dependency.

## Current state (measured via `yarn lint`, 2026-06-08 — re-run for live line numbers)

68 `no-explicit-any` warnings, distributed:

| file | count | nature |
|---|---|---|
| packages/cadre-core/test/seed-bootstrap.spec.ts | 31 | **the bulk** — test scaffolding at the Quereus/libp2p boundary |
| packages/cadre-provider/src/config/loader.ts | 8 | config parsing — likely `unknown` + validation |
| packages/cadre-provider/src/server/routes.ts | 7 | request/response handler typing |
| packages/quereus-plugin-sereus/test/plugin.spec.ts | 6 | Quereus boundary test casts |
| packages/quereus-plugin-sereus/test/browser-shape.spec.ts | 4 | browser-shape assertions |
| packages/quereus-plugin-sereus/src/compose-strand.ts | 4 | `as any` casts at Quereus `registerModule/Function/Collation` |
| packages/cadre-provider/src/service/docker-orchestrator.ts | 2 | dockerode API typing |
| packages/cadre-provider/src/server/auth.ts | 2 | auth payload typing |
| packages/cadre-core/src/control-database.ts | 2 | row/result typing |
| packages/cadre-core/src/cadre-node.ts | 2 | (~line 1123-1124) |

## Strategy

Triage each site into one of three buckets — prefer them in this order:

1. **Real type exists** → use it. `src/` sites (loader, routes, auth, docker-orchestrator,
   control-database, cadre-node, compose-strand) should get genuine types. Config loaders parse external
   input → type the input as `unknown` and narrow with a type guard / schema check rather than `any`.
   `routes.ts`/`auth.ts` handler payloads usually have a framework type or a domain interface. `control-database.ts`
   row results should use the Quereus row type, not `any`.

2. **Narrow to `unknown` + guard** → when the value is genuinely dynamic but you only touch a few
   properties, type as `unknown` and guard at the use site. This is the right move for most boundary code
   and most test assertions in `seed-bootstrap.spec.ts` / `plugin.spec.ts` / `browser-shape.spec.ts` —
   `unknown` forces an explicit cast at the point of use instead of silently propagating `any`.

3. **Genuinely unavoidable `any`** (upstream Quereus/dockerode/libp2p type doesn't expose the needed
   surface) → keep it but make it explicit with `// eslint-disable-next-line @typescript-eslint/no-explicit-any`
   and a one-line rationale naming the upstream limitation. `compose-strand.ts`'s `registerModule(…,
   vtable.module as any, …)` / `registerFunction(func.schema as any)` / `registerCollation(… as any …)`
   are the likely candidates — check whether `@quereus/...` exposes the proper parameter types first (the
   `../quereus` workspace is linked via root `resolutions`); only fall back to a scoped disable if it
   truly doesn't. Do NOT blanket-disable a whole file.

The 31 sites in `seed-bootstrap.spec.ts` are the long pole. They're test helpers building Quereus seed
state; many will share a small number of helper signatures, so typing one helper may clear several
warnings at once. Look for the common shapes before grinding site-by-site.

## Promote rule to error

In `eslint.config.mjs` (~line 83) move `@typescript-eslint/no-explicit-any` from `warn` → `error`, and
update the comments at lines 11-12 and 82 so it's no longer described as a `warn` backlog.

## TODO

- [ ] `seed-bootstrap.spec.ts` (31): identify shared helper signatures, type them once, then clear
      residual sites. Prefer `unknown` + guard for dynamic boundary values.
- [ ] cadre-provider src (loader 8, routes 7, auth 2, docker-orchestrator 2): real types; `unknown` +
      validation for parsed config/request input.
- [ ] quereus-plugin-sereus: compose-strand.ts (4) — check `@quereus/*` types before any scoped disable;
      plugin.spec.ts (6) + browser-shape.spec.ts (4) — `unknown` + guards.
- [ ] cadre-core src: control-database.ts (2) → Quereus row types; cadre-node.ts (2).
- [ ] Promote `@typescript-eslint/no-explicit-any` → `error` and refresh comments.
- [ ] `yarn lint` exits 0 (only svelte warnings remain — downstream ticket). Typecheck and test the
      touched packages (`yarn workspaces foreach -A run typecheck` is broad; at minimum typecheck+test
      cadre-core, cadre-provider, quereus-plugin-sereus) and report results in the handoff. Type changes
      in `src/` can surface real type errors — fix them, don't `any` around them.
