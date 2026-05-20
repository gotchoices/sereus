---
description: review the keytar CJS-via-ESM unwrap helper in createSecretsStore — OS keychain storage now works on dev machines instead of silently falling through to unencrypted file storage
files: packages/cadre-host/src/nat/secrets/index.ts, packages/cadre-host/src/nat/__tests__/secrets.test.ts
---

## What changed

`packages/cadre-host/src/nat/secrets/index.ts`:

- Added an exported `resolveKeytarLike(mod: unknown): KeytarLike | null` helper that inspects `[mod, mod.default]` and returns whichever object exposes `setPassword`, `getPassword`, `deletePassword`, and `findCredentials` as functions. Returns `null` if neither matches.
- `createSecretsStore` now routes the dynamic-import result through `resolveKeytarLike` before instantiating `KeytarSecretsStore`. When the unwrap fails, it returns `makeFileFallback(rootDir, 'keytar module loaded but API surface missing')` with a distinct reason string (vs. the "keytar not installed" and "keytar runtime error" branches), so the operator-facing warning is honest about which failure mode hit.
- Behavior preserved: the sentinel-write probe still runs after a successful unwrap so libsecret-less Linux boxes still fall back cleanly.

`packages/cadre-host/src/nat/__tests__/secrets.test.ts`:

- Imports `resolveKeytarLike` and adds a new `describe('resolveKeytarLike()', …)` suite covering:
  - `{ default: keytar }` shape → returns `keytar` (the actual CJS-via-ESM case).
  - Direct named-export shape → returns `keytar`.
  - `{}` and `{ default: {} }` → returns `null` (incomplete surface).
  - `null` and `undefined` → returns `null` without throwing.
- Re-uses the existing `makeFakeKeytar()` fixture for the keytar surface.

## Why

`keytar@7.9.0` is CJS. Under Node's ESM interop, `await import('keytar')` returns a Module Namespace whose `default` is the real `module.exports`. On the Node versions we target, `keytarMod.setPassword` is `undefined`; only `keytarMod.default.setPassword` is callable. The pre-fix code passed the namespace object straight to `KeytarSecretsStore`, the probe threw `setPassword is not a function`, and the catch silently rerouted DDNS tokens to unencrypted `<dataDir>/nat-secrets.json`. The fallback warning blamed a missing native dep, which misled.

## Verification done

- `yarn workspace @serfab/cadre-host test` → 40 files, 285 passed (3 skipped, all pre-existing platform/integration skips). The `secrets.test.ts` file now reports 15 passed + 1 platform-skipped (`0600 mode` on Windows).
- `yarn workspace @serfab/cadre-host build` → `tsc -p tsconfig.build.json` + `vite build` both green.

## Test cases worth a reviewer's eye

1. **Round-trip through the unwrap path.** The new unit tests cover the helper directly. There is no end-to-end test that exercises `createSecretsStore` with a stubbed dynamic import — adding one would require DI of the importer (the ticket called this out as optional). If the reviewer thinks the four shape-only tests are insufficient, the suggested path is a higher-level test that monkey-patches the module loader and proves a `{ default: stub }` import produces a working store. Left out by design (per ticket) to avoid plumbing changes; flagging for the reviewer to weigh.
2. **Fallback reason strings.** Three distinct reasons now flow into `makeFileFallback`:
   - `keytar not installed: …` (import threw)
   - `keytar module loaded but API surface missing` (unwrap returned null)
   - `keytar runtime error: …` (probe threw)
   Confirm the operator-facing warning text reads sensibly for the new middle case.
3. **Probe still matters.** A reviewer should confirm the probe path (`await ks.set/delete(probeAccount)`) is still reached and still catches libsecret-less Linux. The unwrap only short-circuits when the API surface is missing, not when libsecret is broken.

## Known gaps / things I did not do

- **No live smoke check on the dev machine.** The ticket's verification step references `scripts/smoke-cadre-host.mjs`, which does not exist in this repo. I did not stand up the suggested REPL one-liner because I'm running headless on Windows where Anthropic's runner has no interactive desktop session; a human running this on a Mac or Linux dev box should confirm: with keytar healthy, `nat-secrets.json` is **not** created under the chosen `rootDir`; with keytar forced to fail, the warning fires and the file appears.
- **No regression test asserting `nat-secrets.json` is absent on the happy path.** The existing test surface stubs `KeytarLike` directly and never touches `createSecretsStore` — which is exactly why the original bug went undetected. The new tests narrow that gap at the unwrap boundary but do not exercise the full `createSecretsStore` → keytar selection path. A reviewer who wants belt-and-suspenders coverage should consider the DI-based test from item (1) above, or a Vitest module mock against `keytar`.
- **`KeytarLike` type cast in tests.** `resolveKeytarLike` accepts `unknown` and returns `KeytarLike | null`; the tests pass real `KeytarLike` fixtures, but the four shape-failure cases rely on TypeScript's structural duck-typing inside the helper rather than any new branded type. If the reviewer wants stricter typing they could narrow further, but it's not a correctness issue.

## How to validate manually (if you have a dev box)

```ts
import { createSecretsStore } from '@serfab/cadre-host/dist/nat/secrets/index.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'cadre-keytar-smoke-'));
const s = await createSecretsStore(dir);
await s.set('ddns:test', 'value');
console.log(await s.get('ddns:test')); // 'value'
// Then inspect `dir` — `nat-secrets.json` should NOT exist when keytar is healthy.
```
