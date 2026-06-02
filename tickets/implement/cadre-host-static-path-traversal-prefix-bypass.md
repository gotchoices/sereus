----
description: Harden cadre-host static-file guard against sibling-directory prefix bypass
files: packages/cadre-host/src/server/static.ts, packages/cadre-host/src/server/__tests__/origin-guard.test.ts (pattern reference)
----
The static-file mount in `@serfab/cadre-host` validates resolved request targets against the
configured root directory with a bare string prefix check, the classic prefix-bypass
anti-pattern. In `resolveSafe()` the target is computed as
`normalize(join(rootDir, cleaned))` and then validated with
`target.startsWith(normalize(rootDir))` — no path-separator boundary
(`packages/cadre-host/src/server/static.ts:121-128`). A sibling directory whose name shares
`rootDir`'s basename as a prefix is therefore accepted: with `rootDir = /pkg/dist/ui`, a request
resolving to `/pkg/dist/ui-private/secret` passes the guard because the string starts with
`/pkg/dist/ui`, even though it is outside the intended root.

## Reproduction (confirmed)

The collapse in `normalize(join(...))` blocks ordinary out-of-tree traversal (e.g. escapes to a
path that does not share the `ui` prefix), but the sibling-prefix case slips through. Verified
with the exact guard expression on Windows separators:

```
root   = /pkg/dist/ui
request= /../ui-private/secret   (joins, normalizes to \pkg\dist\ui-private\secret)
buggy  startsWith(normalize(root)) === true     // accepted — BUG
fixed  relative(root,target) = "..\ui-private\secret" → starts with ".." → rejected
```

## Root cause & fix

The containment check must respect a path-separator boundary while still accepting `rootDir`
itself. Replace the prefix check with a `path.relative` based test, which is correct on both
POSIX and Windows separators and handles the cross-drive case via `isAbsolute`:

```ts
import { dirname, extname, isAbsolute, join, normalize, relative, resolve } from 'node:path';

function resolveSafe(rootDir: string, urlPath: string): string | null {
  const cleaned = decodeSafe(urlPath);
  if (cleaned === null) return null;
  const root = normalize(rootDir);
  const target = normalize(join(root, cleaned === '/' ? '' : cleaned));
  // Containment: target must be rootDir itself or strictly beneath it.
  const rel = relative(root, target);
  if (rel.startsWith('..') || isAbsolute(rel)) return null;
  return target;
}
```

`relative(root, root)` returns `''`, which neither starts with `..` nor is absolute, so the root
path itself is still accepted (matters for the `index.html` SPA-fallback join and a bare `/`
request). Descendants yield a relative path with no leading `..`; siblings such as `ui-private`
yield `..\ui-private\...` and are rejected. Cross-drive targets on Windows make `relative` return
an absolute path, caught by `isAbsolute`.

The `\0` / decode handling in `decodeSafe()` and the rest of `serveStatic` are unaffected and
should be left as-is.

## TODO

- Edit `packages/cadre-host/src/server/static.ts`: import `isAbsolute` and `relative` from
  `node:path`, and rewrite `resolveSafe()`'s containment check to use the `relative`-based guard
  above (remove the `startsWith` prefix check).
- Add a focused unit test for `resolveSafe`/static serving under
  `packages/cadre-host/src/server/__tests__/static.test.ts` (follow the `origin-guard.test.ts`
  Fastify-`inject` pattern, or test `resolveSafe` directly if it's exported for testing).
  Cover at minimum:
  - a normal in-root asset (e.g. `/assets/app.js`) → served / resolves inside root,
  - a bare `/` and `/index.html` → resolves to root,
  - the sibling-prefix bypass (`rootDir` basename + suffix, e.g. `/../ui-private/secret`) → rejected (null / 404),
  - an ordinary out-of-tree traversal (`/../../etc/passwd`) → rejected,
  - a NUL-byte path → rejected.
  Note `resolveSafe` is currently module-private; either export it for direct unit testing or
  drive it through `registerStaticMount` + a temp `rootDir` with sibling fixture dirs.
- Run `yarn workspace @serfab/cadre-host test` (stream output with `2>&1 | tee`) and
  `yarn workspace @serfab/cadre-host build` to confirm types and tests pass.
