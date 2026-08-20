----
description: Removed the silent v1-to-v2 rewrite of the host manager's settings file — an old file layout now fails loudly with a clear error instead of being auto-repaired.
files: packages/cadre-host/src/installer/config.ts, packages/cadre-host/src/installer/__tests__/config.test.ts, packages/cadre-host/src/server/settings-store.ts, packages/cadre-host/src/server/__tests__/settings-route.test.ts
----

# Collapse `host.config.json` to v2-only — complete

## Outcome

`host.config.json` now has one supported on-disk shape. `readHostConfig` checks `version`
against `CURRENT_VERSION` and throws
`host.config.json at <path> has unsupported version=<n> (this build expects 2)` for anything
else, including the old v1 layout. The `upgradeV1` / `isV1Shape` migration pair and the
`version === 1` branch are gone, so `readHostConfig` is now pure — a read never writes.
`updateHostConfig` stamps `CURRENT_VERSION` rather than a bare `2`. The `version: 1` stamps on
`grants.json`, `donations.json`, `nat.json`, `trust-circle.json`, and `update-state.json` were
out of scope and are untouched.

The `version` field itself stays, framed in the module header as a forward guard: a file whose
version this build does not recognise is refused, not reinterpreted.

## Review findings

**Checked:** the implement diff read cold before the handoff summary; `installer/config.ts` in
full (version check ordering vs. `isHostConfigShape`, `writeHostConfig` guard, `updateHostConfig`
spread order); every `readHostConfig` call site (`bin/host.ts` ×7, `server/settings-store.ts`,
the `index.ts` re-exports) for a dependency on the removed read-repair write; both test files
touched; a repo-wide grep for surviving `upgradeV1` / `isV1Shape` / "v1→v2" / "silently upgraded"
text across `src/` and `docs/`; the `/api/settings` error path through `server/error-handler.ts`.

**Fixed in this pass (minor):**
- `server/settings-store.ts` — the doc comment on `read()` still said "(runs v1→v2 migration on
  first read)", describing behaviour this ticket deleted. The implementer's grep for stale docs
  covered `docs/` but not comments in adjacent source. Rewritten to state what `read()` now
  does: throws if the file is absent, malformed, or not version 2.
- `installer/__tests__/config.test.ts` — three gaps in the version guard's coverage, all now
  covered and green:
  - a config file with **no** `version` field at all (rejects with `unsupported version=undefined`
    — the version check, not a downstream missing-field error);
  - `updateHostConfig` had **zero** direct tests in the repo, yet the diff edited it. Added a case
    that a patch is applied and the result re-stamps version 2 and round-trips through disk;
  - `updateHostConfig` cannot be made to downgrade the version by a patch carrying `version: 1`
    (the spread order puts `version: CURRENT_VERSION` last — now pinned by a test, not by
    reading the source). The route layer also blocks `version` via `FORBIDDEN_KEYS` in
    `server/routes/settings.ts`, but that is a second line of defence, not this invariant.

**Verified, no change needed:**
- Version check precedes `isHostConfigShape`, so a v1 file reports the version, not a missing
  field — the ticket's stated bar. Both the unit test and the route test assert the message.
- No call site depended on the read-repair write; `readHostConfig` being pure is a strict
  improvement, and the two v1 tests assert the on-disk bytes are byte-identical after a failed
  read, which is what would catch a partial removal.
- The implementer's out-of-scope fix to `server/__tests__/settings-route.test.ts` (the second v1
  migration test, reached through `HostSettingsStore`) was correct to make and correctly made.
- `docs/cadre-host.md` and `docs/architecture.md` never documented the auto-upgrade; their "v1"
  hits are product-release language (loopback-only in v1, DuckDNS-only in v1) and unrelated. The
  only stale copies of the old comments are in `packages/cadre-host/dist/`, which is build output.

**Tripwire recorded (not a ticket):** a bad `host.config.json` throws a plain `Error`, so
`/api/settings` answers 500 with code `internal` via the generic fallback in
`server/error-handler.ts` — the message text does reach the client, and the server is
loopback-only, so nothing leaks. That is fine while the UI just surfaces the text; it only
becomes work if the UI needs to distinguish "your config file is unreadable" from a genuine
server bug. Parked as a `NOTE:` on `HostSettingsStore.read()` in
`packages/cadre-host/src/server/settings-store.ts`.

**No major findings, so no new tickets filed.** The diff is a deletion of a code path with no
live users, the error path it falls through to already existed and was already tested, and no
call site or document depended on the removed behaviour.

## Validation

- `yarn workspace @serfab/cadre-host typecheck` — clean.
- `yarn workspace @serfab/cadre-host test` — 66 files, 608 passed, 4 skipped, 0 failed
  (605 → 608 from the three tests added above).
- `yarn lint` (repo-wide) — clean.

## Known limits

Coverage is fixture-based: no live v1 install exists to test against, which is the same reason
the migration was safe to drop in the first place.
