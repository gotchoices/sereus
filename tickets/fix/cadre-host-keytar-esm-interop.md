---
description: cadre-host keytar dynamic import returns the ESM namespace wrapper instead of the keytar API surface, so the probe always fails and DDNS credentials silently fall back to UNENCRYPTED on-disk storage
files: packages/cadre-host/src/nat/secrets/index.ts, packages/cadre-host/src/nat/secrets/keytar-store.ts, packages/cadre-host/src/nat/__tests__/secrets.test.ts
---

## Repro

Run cadre-host on a fresh data dir on Windows (and likely macOS / Linux too — see "Hypothesis" below):

```
node scripts/smoke-cadre-host.mjs
```

stderr contains:

```
[cadre-host] DDNS credentials will be stored UNENCRYPTED at
<dataDir>/nat-secrets.json (keytar runtime error: keytar setPassword failed:
this.keytar.setPassword is not a function). Install keytar's native
dependencies for OS keychain protection.
```

The user "install keytar's native dependencies" hint is a red herring: `keytar` *is* installed (it imports successfully on line 37 of `packages/cadre-host/src/nat/secrets/index.ts`) and its native `.node` binding loads. The probe fails one line later because the value passed to `KeytarSecretsStore` is the ESM-namespace wrapper around CommonJS's `module.exports`, not the keytar API.

## Hypothesis

`packages/cadre-host/src/nat/secrets/index.ts:37`:

```ts
keytarMod = await import('keytar');
```

`keytar` is a CommonJS package. Under Node's ESM interop, `await import('cjs-pkg')` resolves to a Module Namespace Object whose `default` export is the CJS `module.exports`. The keytar methods live on `keytarMod.default.setPassword`, not `keytarMod.setPassword`. So when `KeytarSecretsStore` calls `this.keytar.setPassword(...)` at line 24 of `keytar-store.ts`, `this.keytar.setPassword` is `undefined` — hence the `setPassword is not a function` runtime error.

The probe at lines 47-48 catches that error and routes the user to `FileSecretsStore`, which then writes DDNS tokens unencrypted to `<dataDir>/nat-secrets.json` (mode 600). The fallback works as designed; the bug is that the keytar path is **never** reachable from a real `await import('keytar')`.

This is consistent with: (a) unit tests in `packages/cadre-host/src/nat/__tests__/secrets.test.ts` injecting a `KeytarLike` stub directly into `KeytarSecretsStore` (bypassing the `createSecretsStore` import code path entirely), so the bug never surfaces there; and (b) all platforms behaving identically — the bug isn't OS-specific.

## Expected behaviour

On a developer machine where `keytar` installs cleanly and the OS keychain is reachable (Windows Credential Manager, macOS Keychain, libsecret on Linux desktops), `createSecretsStore` should return a `KeytarSecretsStore` that successfully reads/writes credentials to the OS keychain. The UNENCRYPTED-fallback warning should appear **only** when keytar genuinely cannot be loaded or its native binding cannot reach the OS service.

## Acceptance

- `createSecretsStore` unwraps the CJS-via-ESM default export defensively, so it picks the object that actually has `setPassword`/`getPassword`/`deletePassword`/`findCredentials` callable, whichever the runtime hands back.
- A new unit/integration test in `packages/cadre-host/src/nat/__tests__/secrets.test.ts` covers the interop shape directly — e.g. by passing a faux module namespace `{ default: stub }` through the import path and asserting the resulting store calls `stub.setPassword`. This is what was missing originally.
- The `keytar runtime error` warning no longer fires during `node scripts/smoke-cadre-host.mjs` on the dev machine. Verify by adding a DDNS token via the local UI's Connectivity page (or by calling `secretsStore.set('ddns:test', 'value')` from a quick repl), then confirming the value round-trips via `secretsStore.get` and is **not** present in `<dataDir>/nat-secrets.json`.
- The fallback path stays intact: if keytar's native module legitimately fails to load (CI containers without libsecret, headless Linux), the file store is still selected and the warning still fires. Don't regress that.

## Out of scope

- Encrypting `nat-secrets.json` itself as a defense-in-depth measure. Today the file is mode 600; that's the v1 contract per `docs/cadre-host.md`. Tracked separately if/when desired.
- Replacing keytar with a different secrets library (e.g. `@napi-rs/keyring`). Worth considering once we confirm the interop fix is small; if it isn't, this ticket should be retitled.
