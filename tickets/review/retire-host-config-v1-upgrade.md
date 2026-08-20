description: Removed the silent v1-to-v2 rewrite of the host manager's settings file — an old file layout now fails loudly with a clear error instead of being auto-repaired.
files: packages/cadre-host/src/installer/config.ts, packages/cadre-host/src/installer/__tests__/config.test.ts, packages/cadre-host/src/server/__tests__/settings-route.test.ts
difficulty: easy
---

# Collapse `host.config.json` to v2-only — done

## What changed

`packages/cadre-host/src/installer/config.ts`:
- Deleted `upgradeV1`, `isV1Shape`, and the `obj.version === 1` branch in `readHostConfig`. A
  `version !== CURRENT_VERSION` file (including v1) now falls straight into the existing
  unsupported-version error — confirmed the version check still runs *before*
  `isHostConfigShape`, so a v1 file reports `unsupported version=1`, not a missing-field error.
- `readHostConfig` is now pure (no write side effect). Grepped every call site
  (`bin/host.ts`, `server/settings-store.ts`, `installer/index.ts`, `installer/config.ts`
  itself) — none depended on the read-repair write.
- Rewrote the module header's "Schema versions" comment: one shape, `version` framed as a
  forward guard (a mismatched value is rejected, not reinterpreted).
- `updateHostConfig` now stamps `version: CURRENT_VERSION` instead of the literal `2` (ticket
  flagged this as optional; did it since it was a one-line change adjacent to the edit, not a
  broader refactor).
- `version`, and the `version: 1` stamps on `grants.json`, `donations.json`, `nat.json`,
  `trust-circle.json`, `update-state.json` are untouched, as specified.

## Tests

`packages/cadre-host/src/installer/__tests__/config.test.ts`:
- Replaced `'upgrades v1 files in place on read'` with `'rejects v1 files without rewriting
  them'`: writes a v1 fixture, asserts `readHostConfig` throws `/unsupported version=1/`, and
  asserts the on-disk bytes are byte-identical after the failed read (the read-purity
  guarantee).
- `version: 99`, malformed-JSON, missing-required-fields, and the `ownCadre` cases are
  untouched and still green.

**Found a second v1-migration test outside the ticket's listed files** —
`packages/cadre-host/src/server/__tests__/settings-route.test.ts` had
`'reads v1 host.config.json and migrates to v2 on first read'`, exercising the same removed
path through the `/api/settings` GET route (`HostSettingsStore` → `readHostConfig`). Fixed it
in the same spirit: renamed to `'rejects a v1 host.config.json without rewriting it'`, now
asserts the route returns 500 with an error message matching `/unsupported version=1/`, and
that the file on disk is unchanged. This file was not in the ticket's `files:` header — flagging
in case the reviewer wants to double check the route-level error shape (500/`internal`, via the
generic fallback in `server/error-handler.ts` — a plain `Error` from `readHostConfig` isn't one
of the typed error classes the handler special-cases).

## Validation run

- `yarn workspace @serfab/cadre-host test` — 66 files, 605 passed, 4 skipped, 0 failed.
  (Had to `yarn workspace @serfab/cadre-core build` first — its `dist` was stale going in,
  unrelated to this ticket's diff, the global-setup build-freshness guard just caught it.)
- `yarn workspace @serfab/cadre-host typecheck` — clean.
- `yarn lint` (repo-wide) — clean.

## Gaps / things the reviewer should know

- No live v1 install exists to test against (per the ticket, this is exactly why the migration
  was safe to drop) — coverage is fixture-based only, same as before.
- Grepped `docs/cadre-host.md` for "v1" mentions of the old auto-upgrade behavior — none found;
  its existing "v1" hits are product-release language (loopback-only in v1, DuckDNS-only in v1),
  unrelated to the `host.config.json` schema version, so left as-is.
