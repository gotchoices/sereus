description: Every app now states which version of its shared tables it runs, as a whole number it raises with each change, and the app author's signature covers that number; this review checks that change before later work uses the number to stop older apps opening a workspace that has moved on.
architecture: docs/strands.md#until-then-every-member-on-the-same-schema-version
files: packages/cadre-core/src/schema-verification.ts, packages/cadre-core/src/types.ts (`SAppConfig`, `SAppInfo`), packages/cadre-core/src/strand-instance-manager.ts (`verifiedSAppInfo`), packages/cadre-core/src/strand-membership-writer.ts (`headerRow`), packages/cadre-core/src/index.ts, schemas/strand.qsql, packages/quereus-plugin-sereus/src/strand-schema.ts, packages/cadre-core/test/schema-verification.spec.ts, packages/cadre-core/test/signed-sapp.ts, packages/reference-app-{web,rn,ns}/src/…/chat-strand.ts and README.md, packages/integration-tests/src/harness/node-fixtures.ts, docs/strands.md, docs/architecture.md, .release-notes.pending.md
----

# Review: an app declares its `App` schema version, and the author signs it

First of three tickets for gotchoices/sereus#59. The other two, `app-schema-version-gates-strand-open` and `app-schema-version-stops-a-running-member`, are in `implement/` and build on this one.

## What changed

- **`SAppConfig.schemaVersion: number` is required** (types.ts), with a doc comment saying the app raises it with every change to `schema` and that it is separate from `version`, the release string. `SAppInfo` carries it, and `verifiedSAppInfo` copies it over.
- **The signature covers it.** In schema-verification.ts, `schemaDigest` signs `JSON.stringify({ schema, schemaVersion, version })`, keys in that order. `signSchema(sApp, privateKey)` and `verifySchema(sApp, signature, publicKey)` take a `SignedSAppFields` (`Pick<SAppConfig, 'schema' | 'version' | 'schemaVersion'>`, exported from the package index) in place of the two separate schema and version arguments. A whole `SAppConfig` can be passed directly, and `assertSchemaSignature` does that. Signatures minted before this change no longer verify, as intended (no backwards compatibility).
- **A malformed number is refused.** `assertSchemaSignature` first throws `SchemaVerificationError` with reason `'invalid schemaVersion'` unless `Number.isSafeInteger(v) && v >= 1`. This runs before the missing-signature check, so `requireSignedSchemas: false` does not excuse it.
- **`SchemaVerificationError`** gains a third constructor parameter, `schemaVersion`, between `version` and `reason`. It appears in the message (`… v1.0.0 (schema version 1): reason`) but is not a public field. There is only one constructor call site, inside schema-verification.ts.
- **`Strand.Header.sAppSchemaVersion integer null`** is added in `schemas/strand.qsql` and in the `STRAND_SCHEMA` copy, placed right after `sAppVersion`. The founder's `headerRow` insert writes `params.sApp.schemaVersion`. The column is nullable because a column added to an existing table has to be: Optimystic adds it to the catalog only and never writes it into rows already stored. Quereus's schema diff matches columns by name, so on an existing strand the column ends up last in the catalog, while on a new strand it is in its declared position. Nothing reads Header with `select *`.
- **Call sites.** Every `signSchema(` call and every `SAppConfig`/`SAppInfo` literal in cadre-core tests, cadre-rn tests, integration-tests and the reference apps now carries `schemaVersion` (1 everywhere). Specs that had a `testVersion` const got a `testSchemaVersion = 1` next to it. Where a literal and its signature share fields, the fields are built once as an object that is spread into the config and passed to `signSchema` (`signed-sapp.ts`, the web chat config, both integration chat configs), so the signed values and the config values cannot drift apart.
- **Reference apps.** Each `chat-strand.ts` declares `CHAT_SCHEMA_VERSION = 1`, with a comment saying to raise it with every `CHAT_SCHEMA` change. The RN and NS configs are still unsigned, since they run under `requireSignedSchemas: false`. Each README has one sentence saying to raise the number with every change to `CHAT_SCHEMA`. The NS README had no prose about the chat schema, so its sentence is a new paragraph below the Layout block.
- **Docs.** docs/strands.md → "Until then" now describes what is built (the number is required, it is signed and why, the refusal of a malformed number, the Header column) and names the two follow-up tickets for what is not built yet. docs/architecture.md's Schema Verification bullet says what the signature covers. `.release-notes.pending.md` has an entry.

## Tests added

Both are in `packages/cadre-core/test/schema-verification.spec.ts`:

- `should reject a signature presented with a different schema version`: a signature minted over `schemaVersion: 1` fails to verify with `schemaVersion: 2` and the same schema text. This shows the signature is bound to the number.
- `should refuse schemaVersion %s even when policy relaxed` (`it.each([0, 1.5])`): `assertSchemaSignature(..., { requireSignature: false })` throws `'invalid schemaVersion'`.

No test covers the Header column write; it is wiring. The founder-bootstrap and membership-writer specs run the real insert against `STRAND_SCHEMA`, so a misspelled column name would fail them.

## Validation run

- `yarn typecheck` (all workspaces plus the coverage checks): clean.
- `yarn lint`: clean.
- cadre-core `yarn test`: 197 files, 2632 passed, 1 skipped. The skip was already there.
- quereus-plugin-sereus `yarn test` (unit + e2e, `strand-schema-drift.spec.ts` included): 14 files, 165 passed, 1 todo.
- reference-app-web, reference-app-rn and reference-app-ns `yarn test`: pass. cadre-rn `test/phone-node/node.spec.ts`: pass.
- integration-tests `src/scenarios/strand-formation-e2e.integration.ts` (tampered, wrong-key and unsigned configs): 22 passed. The other integration scenarios I touched (`websocket-chat`, `convergence-stress`) typecheck but I did not run them.
- cadre-core and quereus-plugin-sereus `dist` were rebuilt, so the stale-build guard sees fresh builds.

## Known gaps / things to look at

- **The README sentences and the `SAppConfig.schemaVersion` doc comment say "a strand refuses an app whose number is below the highest it has seen".** The ticket asked for that wording, but nothing does this until `app-schema-version-gates-strand-open` lands. docs/strands.md and the release note say it is not built yet. If the gates ticket slips, these sentences are ahead of the code.
- **The release note says "Nothing refuses an older schema version yet; that comes next."** The gates ticket should rewrite or drop that sentence when it adds its own entry.
- **The web README paragraph just above my sentence** says an `ALTER TABLE` on an existing chat table is refused by the Optimystic table module. Optimystic now supports adding a nullable column through the catalog only, so that paragraph may be out of date. I did not touch it; it is outside this ticket.
- **Members on Sereus 1.23.0 or earlier** apply a `Strand` declaration without `sAppSchemaVersion` and would drop the column. The gates ticket already plans to release-note that every member must run the new release. This ticket's release note does not say it.
- `docs/strand-contracts.md` lists a subset of Header's columns (it already left out `sAppVersion`). I left it as it is.
