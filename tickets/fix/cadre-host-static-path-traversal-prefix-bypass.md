----
description: Static-file path guard uses prefix check vulnerable to sibling-directory bypass
files: packages/cadre-host/src/server/static.ts
----
The static-file mount in cadre-host validates resolved request targets against the configured root directory using a plain string prefix check, which is the classic prefix-bypass anti-pattern.

In `registerStaticMount`, the helper `resolveSafe()` resolves a request path with `normalize(join(rootDir, cleaned))` and then validates it with `target.startsWith(normalize(rootDir))`, using no trailing path separator (`packages/cadre-host/src/server/static.ts:121-128`). Because the comparison is a bare string prefix with no separator boundary, a sibling directory whose name shares the `rootDir` basename prefix is accepted. For example, if `rootDir` is `/pkg/dist/ui`, a request resolving to `/pkg/dist/ui-private/secret` passes the guard because the string starts with `/pkg/dist/ui`, even though it is outside the intended root.

In-tree `../` escape is already blocked by the `normalize(join(rootDir, cleaned))` collapse, so the residual hole is specifically the sibling-directory-prefix case rather than ordinary directory traversal. This diverges from the intended guarantee documented for the static mount (path-traversal containment within `dist/ui/`): the guard is meant to confine all served assets strictly to `rootDir` and its descendants.

Exploitability is low in practice. The server's origin guard restricts callers to the same machine, and the SPA root is a fixed install location, so an attacker cannot freely choose sibling directory names at runtime. Nonetheless this is a genuine correctness defect in a security-relevant guard and should be hardened so the containment property holds unconditionally.

Expected behavior: the guard must accept `rootDir` itself and any path strictly beneath it, and reject everything else. A correct containment check compares the resolved target against `normalize(rootDir) + path.sep` (while still allowing the `rootDir` path itself), or equivalently verifies that `path.relative(rootDir, target)` neither starts with `..` nor is an absolute path. The fix should remain cross-platform (correct on both POSIX and Windows separators) consistent with the repo's cross-platform expectations.

Key reference: `packages/cadre-host/src/server/static.ts` (`resolveSafe`, lines 121-128).
