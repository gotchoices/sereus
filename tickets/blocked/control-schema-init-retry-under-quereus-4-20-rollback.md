description: Quereus 4.20.0 changed what a failed schema setup leaves behind, which may break the way Sereus retries setting up its shared settings database, and every fresh install of Sereus 1.4.0 already picks up 4.20.0.
files:
  - packages/cadre-core/src/control-write-retry.ts (SCHEMA_INIT_RETRY_POLICY and the safety argument above it)
  - packages/cadre-core/src/control-database.ts (`loadSchema`, the comment near line 627)
  - packages/quereus-plugin-sereus/src/compose-strand.ts (`apply schema Strand` / `apply schema App`)
----

# Does the control-schema retry still hold under Quereus 4.20.0?

## Why this is blocked

**Category: waiting on a sibling project's finding.** optimystic's `yarn check` against `@quereus/quereus` 4.20.0 failed 3 tests in its plugin's `schema-batch.spec.ts` (optimystic-59, 2026-09-25). **Unblock when** optimystic has decided whether it changes its plugin for 4.20.0, and has published or ruled out a release that does.

## The concern

4.20.0 (`apply-schema-all-or-nothing`) makes a failed `apply schema` restore the whole in-memory catalog. Before 4.20.0, steps that finished before the failure stayed. Optimystic's plugin commits each DDL step to the network as it goes. So after a failed apply, the network can hold tables that the in-memory catalog no longer lists.

`ControlDatabase.loadSchema` retries a failed `apply schema CadreControl` (`SCHEMA_INIT_RETRY_POLICY`). Its stated safety argument is that `apply schema` is a diff and a failed step leaves the catalog clean, "so a re-run emits only the tables that did not land". Under 4.20.0 a re-run diffs against the restored catalog. It may re-create tables that already exist in storage, which would error or bind a second collection.

Not measured. Sereus's full `yarn check` passed against the linked Quereus main (same code as 4.20.0) on 2026-09-24. But the retry only fires after a refused DDL commit, and nothing in the suite forces a refusal partway through schema setup. That is why the pass says nothing either way.

## Exposure

Every `@quereus/quereus` range in sereus 1.4.0 is `^4.19.4`, and so is `@optimystic/quereus-plugin-optimystic` 1.5.0's. A fresh install resolves 4.20.0 today.

## Do, once unblocked

1. Add a test that forces a refusal after the first table of `apply schema CadreControl` has committed. Then check that the retry reaches a complete schema, with the in-memory catalog matching storage.
2. If it does not, fix it here, or bump to an optimystic release that fixes it. Correct the safety argument in `control-write-retry.ts` and `control-database.ts` either way.
3. Check `compose-strand.ts`'s strand and app schema applies against the same behaviour.
4. If a sereus release must cap Quereus below 4.20.0 in the meantime, that is the maintainer's call. Write it up; don't do it.
