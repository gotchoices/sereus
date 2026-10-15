description: A control-schema change currently forces every party to be recreated, and phones, which update one at a time from the app store, cannot follow that. Decided (maintainer, 2026-10-15, GitHub #46): versioned migrations. A store records its schema version, and `loadSchema` runs each migration from that version up to the build's own before applying the schema.
architecture: docs/architecture.md
prereq: control-store-from-an-older-release-fails-with-an-untyped-error
files: packages/cadre-core/src/control-database.ts (`initialize` ~1005-1040, `loadSchema` ~1047-1137; the NOTE ~1098-1102 names this as the migration site), packages/cadre-core/src/control-schema.ts, packages/cadre-core/src/control-write-retry.ts, docs/architecture.md (~53, the recreate policy)
----

# Versioned migrations for the control schema

GitHub #46 (risavian): both the 1.13→1.14 and the 1.14→1.15 control-schema changes broke every warm start, and an app-store update reaches each phone separately, so "upgrade every machine of a party together" is not something a phone app can do. The maintainer chose versioned migrations over recreate-and-rejoin and over additive-only changes.

## What the plan stage needs to settle

- **Where the version lives.** It needs to be a replicated singleton row in the control schema, because the control store is replicated and a machine that migrates writes blocks other machines read. A node-local record alongside it would not be enough on its own. The prereq ticket's schema fingerprint becomes this version, or sits beside it.
- **What a migration can do through Optimystic.** `alter table … drop constraint`, `add column` and `drop table` are refused today, so the 1.14 and 1.15 changes could not have been written as in-place DDL. Options: Optimystic support for those alterations; create-new-table, copy, swap; or a dual-read period. Find out what the optimystic module would need, and file it there.
- **Mixed versions in one party.** A migrated machine and an unmigrated one share replicated control blocks. Decide whether the first machine to start on the new build migrates for the party, whether an old build refuses a store whose version is newer than its own (a typed error from the prereq), and what an old build does with rows written under the new schema.
- **Signed rows.** Many control rows are signed over their contents (peer records, approvals, owner keys). A migration that changes a signed row's shape has to keep its signature verifiable, or re-sign it, which only some machines can do.
- **Tests.** For each pair of consecutive versions: a store written by the old build starts on the new one, and two machines on different versions converge.

## Timing

`implement/1.03-owner-key-label-and-founder-machine` edits control constraint text, so it is the next control-schema break. Either this lands first and 1.03 ships as the first migration, or 1.03's release still says to recreate. Settle that ordering when planning.
