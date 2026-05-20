---
description: keytar CJS-via-ESM unwrap in createSecretsStore — OS keychain storage now works on dev machines instead of silently falling through to unencrypted file storage
files: packages/cadre-host/src/nat/secrets/index.ts, packages/cadre-host/src/nat/__tests__/secrets.test.ts
---

## Summary

`createSecretsStore` was passing the raw dynamic-import namespace object to `KeytarSecretsStore`. For CJS packages under Node's ESM interop, the real surface lives at `.default`, so every keytar call threw `setPassword is not a function`, the probe caught it, and DDNS tokens silently routed to an unencrypted `<dataDir>/nat-secrets.json`. The fix adds `resolveKeytarLike(mod)` which probes `[mod, mod.default]` for the four-method `KeytarLike` shape and returns the first match (or `null`). `createSecretsStore` routes through it before constructing the keytar store, with a distinct fallback reason string for the unwrap-failed case so the operator-facing warning is honest about which failure mode hit. Behavior preserved: the sentinel-write probe still runs after a successful unwrap, so libsecret-less Linux boxes still fall back cleanly.

Files touched:

- `packages/cadre-host/src/nat/secrets/index.ts` — new `resolveKeytarLike` helper + wired into `createSecretsStore`.
- `packages/cadre-host/src/nat/__tests__/secrets.test.ts` — new `describe('resolveKeytarLike()', …)` suite covering the four shape cases (`{default: keytar}`, direct, missing-methods, nullish).

## Review findings

### Code review (SPP / DRY / modular / type safety / cleanup / errors)

- **Unwrap order `[mod, mod.default]`** — correct. Tries the namespace first (handles future Node versions that fully synthesize named exports for CJS) and falls back to `default` (today's keytar reality). For real keytar both candidates may satisfy the shape; returning either is functionally equivalent because synthesized named exports forward to `module.exports`. **No issue.**
- **Type discipline** — `resolveKeytarLike(mod: unknown): KeytarLike | null` keeps the `any` out at the boundary; the internal `as KeytarLike` casts are gated behind real `typeof === 'function'` checks for all four methods. Matches the project's "don't be type lazy" rule. **No issue.**
- **Safety against weird inputs** — `(mod as {default?: unknown} | null)?.default` is null-safe; the `c &&` guard rejects `null`/`undefined`/`0`/`""`. Primitives like strings or numbers would fall through to `null` via the `typeof` checks without throwing. **No issue.**
- **Fallback reason strings** — three distinct messages now flow into `makeFileFallback`: `keytar not installed: <err>`, `keytar module loaded but API surface missing`, `keytar runtime error: <err>`. Each is logged via `debug` and surfaced in the `console.warn` operator-facing text. Reads sensibly for all three branches. **No issue.**
- **Probe path preserved** — the sentinel-write probe is still reached after a successful unwrap, so libsecret-less Linux still fails over cleanly. Confirmed by tracing `index.ts:52-63`. **No issue.**
- **Resource cleanup / exceptions / control flow** — no resources held in the new helper; no `try/catch` swallowing; helper is purely shape inspection. **No issue.**
- **DRY / modularity** — `resolveKeytarLike` is a single-purpose function, small, easily testable, and exported. Aligns with AGENTS.md's "small, single-purpose functions" rule. **No issue.**

### Test coverage

- **What's covered:** the helper's four happy/error shapes via direct unit tests.
- **What's not covered:** the full `createSecretsStore` → keytar selection path with a stubbed dynamic import. This was called out as optional in the implement ticket (would require DI of the importer or Vitest module mock). I considered adding a Vitest `vi.mock('keytar', …)` test to assert a `{default: stub}` shape produces a working store, but it would change the import surface only for the test and the helper-level tests already cover the regression boundary. Documenting as a deferred minor gap rather than filing a separate ticket — if a future regression hits the wrapper code in `createSecretsStore` itself (not the helper), the existing `nat-service.test.ts:putDdns persists secrets and updates status` test exercises that path with its own stubbed `secretsStoreFactory`, so the integration is not totally bare.
- **No new regression test for "nat-secrets.json absent on happy path"** — same reason. The existing test surface stubs `secretsStoreFactory` directly. Acceptable; the helper-level tests narrow the gap at the actual interop boundary.

### Docs

- `docs/cadre-host.md:149-157` — describes keytar + file-fallback storage with one example warning text `(keytar not installed)`. The new "API surface missing" reason adds a third possible warning variant, but the doc explicitly uses the warning as an example (with "etc." for the failure modes) rather than enumerating all reasons. **No update required.**
- No other docs reference the affected internals (`createSecretsStore`, `KeytarLike`, secret-store fallback).

### Build + tests

- `yarn workspace @serfab/cadre-host build` → tsc + vite both green (194 modules, 869ms).
- `yarn workspace @serfab/cadre-host test` → 40 files, 285 passed, 3 platform-skipped (Windows-only POSIX mode skip + 2 pre-existing). `secrets.test.ts` reports 15 passed + 1 skipped (platform `0600 mode` on Windows). No regressions elsewhere.
- No `lint` script is defined for `@serfab/cadre-host`; tsc strict mode is the type/lint gate and passes. Confirmed by reading `packages/cadre-host/package.json`.

### Disposition

All findings minor or non-findings; nothing required inline fixes during this review. No new tickets filed. The two deferred coverage items (full `createSecretsStore` round-trip test, live dev-machine smoke check) are documented in the implementation handoff and remain known-and-accepted gaps rather than blockers.
