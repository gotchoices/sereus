description: Every app now states which version of its shared tables it runs, as a whole number it raises with each change, and the app author's signature covers that number, so later work can use it to stop older apps opening a workspace that has moved on.
architecture: docs/strands.md#until-then-every-member-on-the-same-schema-version
files: packages/cadre-core/src/schema-verification.ts, packages/cadre-core/src/types.ts (`SAppConfig`, `SAppInfo`), packages/cadre-core/src/strand-instance-manager.ts (`verifiedSAppInfo`), packages/cadre-core/src/strand-membership-writer.ts (`headerRow`), packages/cadre-core/src/index.ts, schemas/strand.qsql, packages/quereus-plugin-sereus/src/strand-schema.ts, packages/cadre-core/test/schema-verification.spec.ts, packages/cadre-core/test/strand-membership-writer.spec.ts, packages/reference-app-{web,rn,ns}/src/…/chat-strand.ts and README.md, packages/integration-tests/src/harness/node-fixtures.ts, docs/strands.md, docs/architecture.md, .release-notes.pending.md
----

# An app declares its `App` schema version, and the author signs it

First of three tickets for gotchoices/sereus#59. The other two are `app-schema-version-gates-strand-open` and `app-schema-version-stops-a-running-member`.

## What landed

- `SAppConfig.schemaVersion: number` is required, and `SAppInfo` carries it. It is separate from `version`, the release string.
- `signSchema(sApp, privateKey)` and `verifySchema(sApp, signature, publicKey)` take `SignedSAppFields` (`{ schema, version, schemaVersion }`, exported). The signed digest is `JSON.stringify({ schema, schemaVersion, version })`. Signatures minted before this change no longer verify.
- `assertSchemaSignature` refuses a `schemaVersion` that is not a safe integer ≥ 1 with `SchemaVerificationError` (`invalid schemaVersion`), under either signing policy.
- `Strand.Header.sAppSchemaVersion integer null`, written by the founder's Header insert. Nullable because Optimystic can add a column to an existing table only if it is nullable.
- Every call site, the reference apps (`CHAT_SCHEMA_VERSION = 1`), docs/strands.md, docs/architecture.md and the release note.

## Review findings

Read the diff of `ticket(implement): app-schema-version-declared-and-signed` before the handoff.

**Correctness, checked.** The digest includes only the three named fields, even when a whole `SAppConfig` is passed in, so `latencyHint` and the other fields do not affect it. `JSON.stringify` writes an integer the same way on every platform. The number is validated before the missing-signature check, so `requireSignedSchemas: false` does not let a malformed one through. Both places a config enters a strand (`startStrand` and `attachSApp`) go through `verifiedSAppInfo` → `assertSchemaSignature`. Nothing deserializes an `SAppConfig` from storage or the wire; the reference apps build theirs in code, so the field being required in the type is enough. No problems found.

**Fixed in this pass (minor):**
- `createSignedSAppConfig` in `packages/integration-tests/src/harness/node-fixtures.ts` always signed `schemaVersion: 1`, so `strand-app-schema-change-while-partner-offline` signed its changed schema (v2) with the same number as v1, against the rule the ticket sets. The helper now takes an optional `schemaVersion` (default 1), and that scenario passes 2 for v2. Checked by typecheck only; the scenario is a long real-network run and was not run here. Until the gates ticket lands the number only feeds the signature.
- `strand-membership-writer.spec.ts`: the founder Header test already checks every Header column; it now also checks `sAppSchemaVersion`. Because the column is nullable, an insert that passed `undefined` would have written null silently, and a misspelled column name was the only mistake the existing specs would catch.
- `packages/reference-app-web/README.md`: the paragraph next to the new sentence said any `ALTER TABLE` on an existing chat table is refused. Optimystic now saves an added nullable column (no default, not generated, no inline constraint) and a dropped column that no key or index uses (Optimystic `packages/quereus-plugin-optimystic/README.md`). The paragraph now says this. The handoff flagged it.

**Handed to `app-schema-version-gates-strand-open` (appended to its Docs section):** the `SAppConfig.schemaVersion` doc comment, the three `CHAT_SCHEMA_VERSION` comments and the README sentences say a strand refuses an app whose number is lower, which only the gates ticket makes true. The release-note sentence "Nothing refuses an older schema version yet" needs rewriting there too. That ticket already release-notes the constraint for members on 1.23.0 or earlier, including the dropped `Header.sAppSchemaVersion`.

**Tests.** The two added tests pass the bar. The signature-bound-to-the-number test pins the signing rule, and the malformed-number test pins a branch that runs under the relaxed policy. Neither just repeats the implementation. No tests were cut.

**Source hygiene.** `isValidSchemaVersion` takes `unknown` and casts to `number` after `Number.isSafeInteger`. That is harmless, so it was left as is. `SchemaVerificationError`'s new positional parameter has one call site. Comments say why, not what. There were no file-size concerns: the changes are small edits to existing files.

**Docs.** I read docs/strands.md ("Until then"), the docs/architecture.md Schema Verification bullet, the three READMEs and the release note; they match the code apart from the gates-ticket wording above. `docs/strand-contracts.md` lists only some Header columns (it already left out `sAppVersion`) and was left alone. docs/schema-guide.md is the gates ticket's to update.

**Tripwires, accepted tradeoffs.** No tripwires were added and no accepted-tradeoff `NOTE:`s apply at these sites.

**Validation.** `yarn typecheck` and `yarn lint` are clean. `strand-membership-writer.spec.ts` and `schema-verification.spec.ts` pass (33 tests). The implementer's full runs (cadre-core, quereus-plugin-sereus, the reference apps, `strand-formation-e2e`) were not repeated, because this pass changed only one test assertion, one test helper's parameter and docs.
