description: Review hardened cadre-host static-file containment guard (prefix-bypass fix)
files: packages/cadre-host/src/server/static.ts, packages/cadre-host/src/server/__tests__/static.test.ts
----

## What changed

`@serfab/cadre-host`'s hand-rolled static-asset mount validated resolved request targets
against the root directory with a bare `startsWith` prefix check — the classic
prefix-bypass anti-pattern. A sibling directory sharing the root's basename as a prefix
(`dist/ui-private` vs root `dist/ui`) passed the guard.

`resolveSafe()` in `packages/cadre-host/src/server/static.ts` now uses a `path.relative`
based containment test instead:

```ts
const root = normalize(rootDir);
const target = normalize(join(root, cleaned === '/' ? '' : cleaned));
const rel = relative(root, target);
if (rel.startsWith('..') || isAbsolute(rel)) return null;   // reject escapes
return target;
```

- `relative(root, root)` → `''` (root itself / bare `/` / `index.html` SPA join still accepted).
- Descendants → relative path with no leading `..` (accepted).
- Siblings / out-of-tree → `..\…` leading `..` (rejected).
- Cross-drive on Windows → `relative` returns an absolute path, caught by `isAbsolute`.

`isAbsolute` and `relative` were added to the `node:path` import. `decodeSafe()` (NUL/decode
handling) and the rest of `serveStatic` are unchanged.

**API change:** `resolveSafe` was module-private and is now `export`ed (with a doc comment)
so it can be unit-tested directly. It is imported only by the new test from `../static.js`;
it is *not* re-exported from the package `index`, so this does not widen the published
surface (`exports` still points only at `dist/index.js`).

## ⚠️ Honest gap — read this before reviewing the tests

**The bug is not reachable through Fastify's HTTP transport.** While writing the integration
test I discovered that Fastify/`find-my-way` collapses `../` segments — both literal
(`/../ui-private/x`) and percent-encoded (`/%2e%2e/ui-private/x`) — to a within-root path
*before* the `setNotFoundHandler` runs. So over HTTP, `resolveSafe` never receives the
escaping form, and the sibling content is never served regardless of the fix. The
bug is reachable only by a **direct/internal caller** of `resolveSafe` (or any future code
path that feeds it an un-normalized path that didn't pass through Fastify's router).

Consequences for the test suite (`packages/cadre-host/src/server/__tests__/static.test.ts`):

- **Regression coverage = the `describe('resolveSafe')` direct unit tests.** These call the
  exported function with raw escaping paths and are genuine regression tests: I reasoned
  through (and the math holds on both separators) that
  `resolveSafe('/srv/app/dist/ui', '/../ui-private/secret')` returns a **non-null** target
  under the old `startsWith` guard (because `…\dist\ui-private\secret`.startsWith(`…\dist\ui`)
  is true) and **null** under the new `relative` guard. The reviewer can confirm by
  temporarily reverting `static.ts` and watching `rejects the sibling-directory prefix bypass`
  fail.
- **The `describe('serveStatic …')` Fastify integration tests are happy-path + boundary
  smoke only.** `never serves sibling-prefix directory content over HTTP` asserts the no-leak
  invariant (`body` never contains the secret) but deliberately does **not** assert a status
  code, and **does not distinguish old vs new code** — it passes either way because the
  transport already neutralizes the traversal. It is documented as such inline; do not read
  it as proof the fix works.

## Test inventory (13 tests, all passing)

`resolveSafe` (direct):
- normal in-root asset `/assets/app.js` → resolves inside root
- bare `/` → resolves to root dir itself
- `/index.html` → resolves to root index
- sibling-prefix bypass `/../ui-private/secret` → **null** (the fix)
- ordinary out-of-tree `/../../etc/passwd` → null
- encoded out-of-tree `/%2e%2e/%2e%2e/etc/passwd` → null
- NUL-byte `/app%00.js` → null
- malformed percent-encoding `/%` → null
- invariant sweep: any accepted result never has `relative(root, result)` starting with `..`

`serveStatic` via `registerStaticMount` (Fastify `inject`, temp root + sibling fixture):
- in-root asset served (200, correct mime, body)
- bare `/` serves `index.html` (200)
- unknown HTML route → SPA `index.html` fallback (200)
- traversal URLs (literal + encoded) never serve sibling content (no-leak boundary check)

## Suggested reviewer follow-ups (not blocking)

- Cross-drive Windows escape (`C:` root, `D:`-rooted target) relies on `isAbsolute(rel)` but
  has no explicit test — hard to write portably without a real second volume. Consider whether
  a mocked/parametrized check is worth adding.
- If any non-HTTP caller ever resolves user-influenced paths against a root in this package,
  it should route through `resolveSafe` too — worth a quick grep for other `startsWith`-style
  containment checks elsewhere in the repo.

## Validation performed

- `yarn workspace @serfab/cadre-host test` → 44 files, 346 passed / 4 pre-existing skips.
- `yarn workspace @serfab/cadre-host build` → `tsc -p tsconfig.build.json` (no type errors)
  then vite UI build, both clean.
