---
description: unwrap the keytar CJS-via-ESM default export in createSecretsStore so OS keychain storage actually works on dev machines (was silently falling through to unencrypted file store)
files: packages/cadre-host/src/nat/secrets/index.ts, packages/cadre-host/src/nat/secrets/keytar-store.ts, packages/cadre-host/src/nat/__tests__/secrets.test.ts
---

## Problem

`packages/cadre-host/src/nat/secrets/index.ts:37` does:

```ts
keytarMod = await import('keytar');
```

`keytar@7.9.0` is a CommonJS package — `node_modules/keytar/lib/keytar.js` ends with `module.exports = { getPassword, setPassword, ... }`. Under Node's ESM interop, `await import('cjs-pkg')` yields a Module Namespace Object whose `default` export is the CJS `module.exports`. So `keytarMod` here is shaped roughly as:

```
{ default: { setPassword, getPassword, deletePassword, findCredentials, ... }, [Symbol.toStringTag]: 'Module' }
```

Node also synthesises named exports for CJS packages where it can statically detect them, but for keytar that's unreliable across Node versions; on every Node we currently target, `keytarMod.setPassword` is `undefined` and only `keytarMod.default.setPassword` is callable.

The probe at lines 47-48 immediately throws `setPassword is not a function`, which is caught and rerouted to `FileSecretsStore`, which silently writes DDNS tokens unencrypted at `<dataDir>/nat-secrets.json` (mode 600). The fallback warning misleads users into thinking keytar is uninstalled.

## Fix

Add a small interop-unwrap helper in `secrets/index.ts` that, given the dynamic-import result, returns whichever object satisfies the `KeytarLike` shape — i.e. the first object in `[mod, mod.default]` whose `setPassword`, `getPassword`, `deletePassword`, and `findCredentials` are all functions. If neither matches, fail explicitly (treat as if keytar were unavailable) so we don't silently push junk into `KeytarSecretsStore`.

Sketch:

```ts
function resolveKeytarLike(mod: unknown): KeytarLike | null {
  const candidates: unknown[] = [mod, (mod as { default?: unknown } | null)?.default];
  for (const c of candidates) {
    if (
      c &&
      typeof (c as KeytarLike).setPassword === 'function' &&
      typeof (c as KeytarLike).getPassword === 'function' &&
      typeof (c as KeytarLike).deletePassword === 'function' &&
      typeof (c as KeytarLike).findCredentials === 'function'
    ) {
      return c as KeytarLike;
    }
  }
  return null;
}
```

Wire it into `createSecretsStore`:

```ts
const keytar = resolveKeytarLike(keytarMod);
if (!keytar) {
  return makeFileFallback(rootDir, 'keytar module loaded but API surface missing');
}
const ks = new KeytarSecretsStore(KEYTAR_SERVICE, keytar);
```

Keep the existing probe — runtime probes still matter for headless Linux / missing libsecret.

## Tests

Existing tests in `packages/cadre-host/src/nat/__tests__/secrets.test.ts` inject `KeytarLike` directly into `KeytarSecretsStore` and bypass the import path entirely — that's why the bug went undetected. Add coverage at the `createSecretsStore` boundary:

- Export `resolveKeytarLike` (or expose it for tests via the same module) and assert that:
  - `resolveKeytarLike({ default: fakeKeytar })` returns `fakeKeytar`.
  - `resolveKeytarLike(fakeKeytar)` returns `fakeKeytar` (direct named-export shape).
  - `resolveKeytarLike({})` returns `null`.
  - `resolveKeytarLike({ default: {} })` returns `null`.
  - `resolveKeytarLike(null)` returns `null` (don't crash on weird inputs).
- Optional: a higher-level test that calls `createSecretsStore` with a fixture rootDir and a monkey-patched dynamic import so we can prove a `{ default: stub }` shape produces a working `KeytarSecretsStore` that round-trips a value through the stub. If that requires more plumbing than it's worth (e.g. needs DI of the importer), the four `resolveKeytarLike` unit tests above are sufficient — they cover the interop shape directly.

## Verification

Per the original ticket's acceptance criteria:

- `yarn workspace @serfab/cadre-host test` passes, including the new tests.
- `yarn workspace @serfab/cadre-host build` passes.
- On the dev machine, `node scripts/smoke-cadre-host.mjs` no longer prints the `keytar runtime error: ... setPassword is not a function` warning. (If the smoke script doesn't exist or doesn't exercise secrets, fall back to a tiny repl: `import { createSecretsStore } from '@serfab/cadre-host/...'; const s = await createSecretsStore(tmpDir); await s.set('ddns:test', 'value'); console.log(await s.get('ddns:test'));` and confirm `nat-secrets.json` is **not** created.)
- The fallback path is preserved: when `resolveKeytarLike` returns `null` (or when the probe still throws on a libsecret-less box), `FileSecretsStore` is selected and the warning fires.

## TODO

- Add `resolveKeytarLike` (or equivalent) helper in `packages/cadre-host/src/nat/secrets/index.ts` and route `createSecretsStore` through it before constructing `KeytarSecretsStore`.
- Update `createSecretsStore` so it returns `makeFileFallback` with a clear reason if the unwrap returns `null` (distinct from "import threw" so the warning is honest).
- Export `resolveKeytarLike` from the module (or via an internal-only export) so tests can target it.
- Add `resolveKeytarLike` unit tests covering the four shape cases listed above.
- Run `yarn workspace @serfab/cadre-host test` and confirm it passes.
- Run `yarn workspace @serfab/cadre-host build` and confirm it passes (or whatever typecheck command the package uses).
- Smoke-check on the dev machine: confirm `nat-secrets.json` is no longer created when keytar is healthy, and that it **is** created (with the existing warning) when keytar is forced to fail.
