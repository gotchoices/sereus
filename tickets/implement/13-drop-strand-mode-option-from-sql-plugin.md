----
description: The SQL package still advertises a "bootstrap mode" for connecting to a workspace, a concept the rest of the codebase no longer has. Replace it with the plain low-level choice of storage engine it always was, so nobody learns the retired idea from the docs.
prereq: retire-strand-mode-in-cadre-core
files: packages/quereus-plugin-sereus/src/types.ts, packages/quereus-plugin-sereus/src/parse-config.ts, packages/quereus-plugin-sereus/src/compose-strand.ts, packages/quereus-plugin-sereus/src/connect-browser.ts, packages/quereus-plugin-sereus/README.md, packages/quereus-plugin-sereus/test/plugin.spec.ts, packages/quereus-plugin-sereus/test/e2e/bootstrap.e2e.spec.ts, packages/quereus-plugin-sereus/test/e2e/strand-schema.e2e.spec.ts
difficulty: medium
----

# Drop `mode` from `@serfab/quereus-plugin-sereus`; keep `transactor`

Third and last of the strand-mode retirement (after `strand-network-transactor-solo-parity` and
`retire-strand-mode-in-cadre-core`). Purely an API-surface and documentation change in the SQL
package — no behaviour changes for any caller that does not pass `mode`.

## The situation this leaves behind

`StrandConnectionOptions` carries two overlapping knobs for the same decision
(`packages/quereus-plugin-sereus/src/types.ts:36-52`):

- `mode?: 'bootstrap' | 'networked'` — the documented, public one. Described as a *lifecycle* mode.
- `transactor?: string` — marked `@internal`, "used by unit tests with `'test'`", and applied only
  when `mode` is unspecified.

`compose-strand.ts:153-163` resolves them: `mode === 'bootstrap'` → the `local` transactor,
`'networked'` → `network`; otherwise `transactor`; otherwise `network`.

After the previous ticket, no production code in this repo passes `mode` at all. What survives is a
genuine need — the ability to run a strand database in-process on local storage with no cohort, which
is what makes this package's own e2e specs and `cadre-core`'s membership specs runnable without a
mesh. That need is a **choice of storage engine**, and `transactor` already names it. `mode` names a
lifecycle stage that no longer exists, teaches an outside reader that "solo" is a mode a strand can
be in, and is the last place in the repo advertising that idea.

## What to do

**Delete `mode`.** Remove it from `StrandConnectionOptions` (`types.ts:33-41`), from `parse-config.ts`
(`:26-32`, `:52`), and from the resolution and log line in `compose-strand.ts` (`:139-167`).

**Promote `transactor` to a documented option.** Type it as
`transactor?: 'local' | 'network' | 'test'` (the values `collection-factory.ts` in
`@optimystic/quereus-plugin-optimystic` actually switches on; it also falls through to a custom
transactor name, so if you widen it to `| (string & {})` say why in the doc comment). Default
`'network'`. Document what each value means in one sentence each, without lifecycle vocabulary:

- `network` — transactions go through the strand's libp2p cohort. A node that is alone coordinates
  for itself; this is the only value any application should use.
- `local` — transactions go straight to this process's raw storage, no peers consulted. For
  in-process tests and tooling.
- `test` — Optimystic's in-memory fake; no libp2p node is created (`compose-strand.ts:211`).

**Keep the storage wiring keyed on the transactor.** `pluginConfig.rawStorageFactory` is still set
only for `local` (`compose-strand.ts:190-192`), and `connect-browser.ts:41` still skips IndexedDB for
`test`. Both already read `resolvedTransactor`, so they need no logic change — only comment edits
that stop referring to "bootstrap mode".

**Update the README** (`:135`, `:231-242`, `:285` — the options table row). The example under "no
peer round trips" becomes `transactor: 'local'`, and the framing changes from "solo-node startup" to
"in-process, no cohort" so it does not read as a recommendation for real apps.

**Update the tests.** `test/plugin.spec.ts:129-130` (parse-config cases) become `transactor` cases —
including one asserting an unknown value is rejected or passed through, matching whatever
`parse-config` ends up doing. `test/e2e/strand-schema.e2e.spec.ts` (`:97`, `:118`, `:137`, `:156`,
`:172`, `:200`, `:265`, `:312`) and `test/e2e/bootstrap.e2e.spec.ts` (`:18`, `:62`, `:100`, `:118`,
`:152`, `:173`, `:200`, `:221`) switch `mode: 'bootstrap'` → `transactor: 'local'`. **Rename
`bootstrap.e2e.spec.ts`** to `local-transactor.e2e.spec.ts` and rewrite its header — the filename is
itself the retired vocabulary. Leave `strand-transactor-handover.spec.ts` (added by the first ticket,
in `cadre-core`) alone: it was written against `transactor` for exactly this reason.

## Edge cases & interactions

- **`cadre-core` must not regress.** After the previous ticket its production path passes no
  transactor at all (defaulting to `network`), while its test helpers pass `transactor: 'local'`.
  Both keep working; run `cadre-core`'s suite as well as this package's.
- **`default_transactor` in the Optimystic plugin config is a different name** in a different
  package's option map (`compose-strand.ts:185`). It stays; only the Sereus-level option changes.
- **Do not repurpose the retired name.** No alias, no deprecation shim — this repo carries no
  backwards compatibility yet, and a shim would keep the concept alive in exactly the place this
  ticket exists to clear.
- **Type-only breakage is silent for JS callers.** A JavaScript consumer passing `{ mode:
  'bootstrap' }` would now get the network transactor with no error. `parse-config.ts` validates a
  config map, so if it is reachable from a SQL-level or JSON-level caller, reject an unknown `mode`
  key there loudly rather than ignoring it — check whether `parseConfig`'s contract already rejects
  unknown keys, and if it silently ignores them, say so in the handoff rather than changing that
  policy here.
- **Both node factories still omit `clusterPolicy`** (`connect.ts:28-35`,
  `connect-browser.ts:45-55`), which matters more now that the e2e specs exercise the network
  transactor. Filed as `backlog/debt-plugin-strand-node-omits-cluster-policy` — out of scope here;
  do not fix it in this pass, and do not let an e2e spec depend on the current defaults.

## Validation

```
packages/quereus-plugin-sereus: yarn typecheck && yarn vitest run 2>&1 | tee /tmp/plugin.log
packages/cadre-core:            yarn typecheck && yarn vitest run 2>&1 | tee /tmp/cadre-core.log
repo root:                      yarn lint
repo root:                      yarn build
```

The e2e specs in this package create real libp2p nodes; if any is gated behind an environment flag,
say which ones you ran and which you did not.

## TODO

- Delete `mode` from `types.ts`, `parse-config.ts` and `compose-strand.ts`.
- Type and document `transactor?: 'local' | 'network' | 'test'`, default `network`.
- Rewrite the comments in `compose-strand.ts` and `connect-browser.ts` that name "bootstrap mode".
- Update the README's prose, example and options table.
- Convert `plugin.spec.ts`'s parse-config cases; convert both e2e specs' call sites.
- Rename `bootstrap.e2e.spec.ts` → `local-transactor.e2e.spec.ts` and rewrite its header.
- Run both packages' suites plus root lint and build; report any e2e spec skipped and why.
- Grep the repo one final time for `bootstrap` used to mean a transactor choice, and for
  `StrandMode` — both should return nothing outside `tickets/complete/`.
