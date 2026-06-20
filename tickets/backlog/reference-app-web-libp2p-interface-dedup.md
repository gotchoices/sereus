----
description: The web reference app's type checker fails because two copies of a libp2p package at different versions disagree about a type; the duplicate copy needs to be de-duplicated.
files: packages/reference-app-web/src/lib/cadre-web.ts, packages/reference-app-web/package.json, package.json, ../optimystic/packages/db-p2p-storage-web/package.json
difficulty: medium
----

### Symptom

`svelte-check` fails at HEAD with 2 type errors:

**Command:** `cd packages/reference-app-web && yarn exec svelte-check`

**File:** `src/lib/cadre-web.ts` — errors at `286:3` and `323:34`.

**Error (286:3, 323:34 share the same root):**
```
Type 'PrivateKey' is not assignable to type 'PrivateKey | undefined'.
  Type 'RSAPrivateKey' is not assignable to type 'PrivateKey | undefined'.
    Type 'import("C:/projects/optimystic/packages/db-p2p-storage-web/node_modules/@libp2p/interface/.../keys").RSAPrivateKey'
      is not assignable to type
    'import("C:/projects/sereus/node_modules/@libp2p/interface/.../keys").RSAPrivateKey'.
      The types of 'publicKey.verify' are incompatible ...
        Type 'Uint8ArrayList' is not assignable to type 'Uint8ArrayList<ArrayBufferLike>'.
          Property '[symbol]' is missing in type 'Uint8ArrayList' but required in type 'Uint8ArrayList<ArrayBufferLike>'.
```

### Root cause

Two different copies of `@libp2p/interface` are resolved in the same type graph:

- `C:/projects/sereus/node_modules/@libp2p/interface` (top-level, used by
  `reference-app-web`)
- `C:/projects/optimystic/packages/db-p2p-storage-web/node_modules/@libp2p/interface`
  (nested inside the linked optimystic workspace package)

The two versions disagree on the `Uint8ArrayList` generic: the newer one is
`Uint8ArrayList<ArrayBufferLike>` (carries a required `[symbol]` brand) while the
nested copy is the un-parameterized `Uint8ArrayList`. A `PrivateKey` produced by
the nested copy (via `db-p2p-storage-web`) is therefore not assignable to the
`PrivateKey` parameter typed by the top-level copy, which is what `cadre-web.ts`
references at lines 286 and 323.

This is a dependency-deduplication / version-alignment problem in the linked
workspace, not a logic bug in `cadre-web.ts`.

### Why this is not a tightly-scoped triage fix

The mismatch lives in `node_modules` layout across two linked repos, not in
Sereus source. Resolving it means aligning `@libp2p/interface` versions so a
single copy is hoisted — e.g. adjusting `resolutions` in the root
`package.json`, bumping/aligning `@libp2p/interface` in
`../optimystic/packages/db-p2p-storage-web`, or de-duping the install. That is a
dependency-management change with install-graph-wide consequences (and a
re-install), out of scope for an in-place test triage. A source-level cast in
`cadre-web.ts` would only paper over a genuine version skew and is the wrong
layer to fix it.

### Ruled out

- **Not** caused by the `svelte-check-gate` ticket that surfaced it — that ticket
  touches no files under `reference-app-web`.
- **Not** a `cadre-web.ts` logic error: the values are correct at runtime; the
  failure is purely the type checker seeing two `@libp2p/interface` identities.
- Reproduces deterministically at HEAD (`6d79439`): `svelte-check` reports
  exactly these 2 errors in 1 file out of 839 checked.

### Suggested approach (for the implementer)

1. `yarn why @libp2p/interface` in both `sereus` and
   `../optimystic/packages/db-p2p-storage-web` to identify the divergent versions.
2. Align the versions (root `resolutions` and/or the optimystic package's dep)
   so a single `@libp2p/interface` is shared, then re-install and re-run
   `svelte-check`.
