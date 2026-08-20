----
description: The self-hosted manager silently rewrites an older version of its settings file into the current layout when it starts. No such old file exists anywhere, so the rewrite should go and an unrecognised file should simply fail with a clear message.
files: packages/cadre-host/src/installer/config.ts, packages/cadre-host/src/installer/__tests__/config.test.ts
difficulty: easy
----

# Collapse `host.config.json` to v2-only

## What exists today

`packages/cadre-host/src/installer/config.ts` supports two on-disk shapes of `host.config.json`.
`readHostConfig` branches on `obj.version === 1` and calls `upgradeV1`, which validates the v1
field set (`isV1Shape`), stamps `updates: { autoApply: false }`, bumps the version, and **writes
the file back in place** before returning. The module header documents the two versions and says
"v1 files are silently upgraded on read".

v1 is the layout installer 6.4.1 wrote. No v1 file exists — there is no live install to have
produced one. The upgrade path is a migration we are carrying for nobody.

## What changes

Delete `upgradeV1` and `isV1Shape`, and delete the `obj.version === 1` branch from
`readHostConfig`. A file whose `version` is anything other than `CURRENT_VERSION` then falls
straight through to the existing unsupported-version error. Rewrite the module header's "Schema
versions" block to describe one shape, not a history.

**Keep the `version` field.** It is a forward guard — it is what lets a future build recognise a
file it does not understand and refuse it, which is why the unsupported-version error above is the
desired end state rather than an accident. The same is true of the `version: 1` stamps on
`grants.json`, `donations.json`, `nat.json`, `trust-circle.json`, and `update-state.json`: none of
them has migration code behind it, none of them is in scope here, and all of them stay exactly as
they are.

## The error path is the real deliverable

Removing the branch changes what an operator sees when they point the host at a file it cannot
read. Today a v1 file is repaired silently; afterwards it must **fail loudly and usefully**. The
existing message is:

```
host.config.json at <path> has unsupported version=<n> (this build expects 2)
```

That names the file, the path, the value found, and the value wanted, which is the bar. What must
not happen is a shape error thrown from deep inside `isHostConfigShape` or the JSON parse — a v1
file must be rejected by the version check *before* the field-shape check, so the operator is told
"wrong version", not "missing required fields". Confirm the ordering in `readHostConfig` survives
the edit; the version check already runs first today and must keep doing so.

## Edge cases & interactions

- **`readHostConfig` currently has a write side-effect.** The v1 branch calls `writeHostConfig`.
  After this change `readHostConfig` is pure — reads never write. That is a strictly better
  contract; make sure nothing was relying on the read-repair (grep call sites of `readHostConfig`
  in `installer/`, `server/`, and `cadre-host start`).
- **`updateHostConfig` also stamps `version: 2`.** It builds `{...current, ...patch, version: 2}`.
  That is a write path, not a migration; leave it. Consider whether it should reference
  `CURRENT_VERSION` rather than the literal, and if so change it — but do not turn that into a
  refactor of the module.
- **A v1 file is now a `version=1` rejection, and the test must say so.** The existing case
  `'upgrades v1 files in place on read'` in `installer/__tests__/config.test.ts` asserts the
  behaviour being removed. Replace it — do not delete it — with a case that writes the same v1
  fixture and expects `readHostConfig` to throw `/unsupported version=1/`, and additionally assert
  the file on disk is **unchanged** after the failed read (that is the read-purity guarantee, and
  it is the assertion that catches a partial removal that leaves a write behind).
- **Keep the existing `version: 99`, malformed-JSON, and missing-required-fields cases green.**
  They cover the three other rejection routes and must not shift.
- **`hostOwnsCadre` and the `ownCadre` optional field are untouched.** They are current design.

## TODO

- Delete `upgradeV1`, `isV1Shape`, and the `version === 1` branch in `readHostConfig`.
- Rewrite the module header's "Schema versions" comment for a single current shape, keeping the
  statement that `version` is a forward guard.
- Verify the version check still precedes `isHostConfigShape` so a v1 file reports the version,
  not a missing field.
- Replace the `'upgrades v1 files in place on read'` test with a v1-is-rejected test that also
  asserts the on-disk bytes are unchanged.
- Grep `readHostConfig` call sites for anything depending on the read-repair write.
- Run `yarn workspace @serfab/cadre-host test` and its type-check.
- Run `yarn lint`.
