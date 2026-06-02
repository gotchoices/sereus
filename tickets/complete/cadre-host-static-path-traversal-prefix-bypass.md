description: Hardened cadre-host static-file containment guard against the startsWith prefix-bypass anti-pattern (reviewed)
files: packages/cadre-host/src/server/static.ts, packages/cadre-host/src/server/__tests__/static.test.ts
----

## Summary

`@serfab/cadre-host`'s hand-rolled SPA static mount validated resolved request targets
against the root directory with a bare `startsWith` prefix check — the classic prefix-bypass
anti-pattern. A sibling directory sharing the root's basename as a prefix (`dist/ui-private`
vs root `dist/ui`) passed the guard and its contents could be served.

`resolveSafe()` in `packages/cadre-host/src/server/static.ts` now uses a `path.relative`
based containment test: the target is accepted only when `relative(root, target)` is `''`
(root itself), or a descendant path that neither climbs out (`..` / `..` + separator) nor is
absolute (cross-drive on Windows). `resolveSafe` was made `export` (doc-commented) so it can
be unit-tested directly; it is **not** re-exported from the package `index` (`exports` still
points only at `dist/index.js`), so the published surface is unchanged.

## Review findings

### Scrutinized
- **Core containment logic** (`resolveSafe`) — re-derived old-vs-new behavior by hand and with
  a `node:path` probe on Windows separators: old `startsWith` guard returns the sibling target
  (bug), new `relative` guard returns `null`. Confirmed.
- **HTTP reachability** of the exploit — empirically probed Fastify/`find-my-way` URL handling.
- **Sibling anti-pattern elsewhere** — grepped the repo for other `startsWith`-based path
  containment checks. The only other `startsWith` uses are HTTP header (`Bearer `) and
  URL-route-prefix (`/api`, `/auth`, …) gates — not path containment. No sibling instances.
- **Decode/encoding bypasses** — single `decodeURIComponent` (no double-decode), NUL rejection,
  malformed-percent rejection, backslash handling on POSIX vs Windows.
- **Published surface** — confirmed `resolveSafe` is not re-exported from `src/index.ts` and
  `package.json#exports` is unchanged.
- **Docs** — grepped `docs/**` for any reference to the static-mount internals / containment
  behavior. None exist; the change is internal hardening with no documented behavior change, so
  no doc update was required.
- **Type safety / build** — `tsc -p tsconfig.build.json` clean.
- **Full regression suite** — `yarn workspace @serfab/cadre-host test`: 44 files,
  347 passed / 4 pre-existing skips.

### Found & fixed inline (minor)
1. **The handoff under-credited the bug as "not reachable over HTTP."** This is false for the
   **encoded-separator** vector class. Probing showed Fastify does **not** collapse `%2f`/`%5c`
   (or `%2e%2e%2f`): the handler receives the still-encoded `request.url`, and `decodeSafe`'s
   `decodeURIComponent` then reconstitutes `../`, delivering the escaping path to `resolveSafe`.
   Under the **old** `startsWith` guard, `GET /..%2fui-private%2fsecret.txt` served the sibling
   secret **over HTTP** — a genuine exploit, not a direct-caller-only theoretical one. The
   implementer's production fix already closes it; only the test coverage was missing.
   *Fix:* expanded the `serveStatic` HTTP test to include the `%2f`/`%5c`/`%2e%2e%2f` vectors and
   rewrote its comment. Verified it is now a **real** regression test by temporarily restoring
   the old guard and watching `never serves sibling-prefix directory content over HTTP` fail
   with `expected 'top secret' not to contain 'top secret'` (then restored the fix).
2. **The new guard still used a loose `rel.startsWith('..')`** — the same *class* of prefix
   check the ticket set out to eliminate. A legitimate in-root asset whose name merely begins
   with `..` (e.g. `..foo.js`) yields `relative()` → `..foo.js`, which `startsWith('..')`
   falsely rejects. Fail-safe (over-rejection, no leak) and such names don't occur in a Vite
   bundle, but leaving a loose prefix check inside a fix *about* loose prefix checks is poor
   form. *Fix:* tightened to `rel === '..' || rel.startsWith('..' + sep)` (imported `sep` from
   `node:path`), and added a positive regression test (`accepts an in-root asset whose name
   merely begins with ".."`). Updated the invariant-sweep test to use the precise predicate.

### Found, not actioned here
- **Cross-drive Windows escape** (`C:` root, `D:`-rooted target) relies on `isAbsolute(rel)`
  and still has no dedicated test — hard to write portably without a real second volume. The
  unit suite exercises `isAbsolute` indirectly via the invariant sweep; an explicit
  mocked/parametrized test would be marginal. Left as a noted gap, not a blocker. (Carried over
  from the implementer's follow-up note; still accurate.)

### Major findings → new tickets
None. The production fix was correct and complete; review work was confined to closing test
gaps and tightening one marginal edge — all minor, all fixed inline.

## Test inventory (14 unit + integration tests, all passing)

`resolveSafe` (direct): in-root asset; bare `/` → root; `/index.html`; **sibling-prefix bypass
→ null** (the fix); **`..`-prefixed in-root name accepted** (new); out-of-tree traversal → null;
encoded out-of-tree → null; NUL-byte → null; malformed percent → null; invariant sweep.

`serveStatic` via `registerStaticMount` (Fastify `inject`, temp root + sibling fixture): in-root
asset (200/mime/body); bare `/` → `index.html`; unknown HTML route → SPA fallback; **never serves
sibling content over HTTP across 5 traversal vectors incl. encoded separators** (now a genuine
old-vs-new regression test).

## Validation performed
- `yarn workspace @serfab/cadre-host test` → 44 files, 347 passed / 4 pre-existing skips.
- `yarn workspace @serfab/cadre-host build:server` (`tsc -p tsconfig.build.json`) → clean.
- No `lint` script exists for this package; type checking is performed by the `tsc` build step.

## End
