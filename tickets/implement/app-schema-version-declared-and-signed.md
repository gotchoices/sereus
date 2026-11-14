description: Have every app state which version of its shared tables it runs, as a whole number it raises with each change, and make the app author's signature cover that number, so a later change can stop older apps from opening a workspace that has moved on.
architecture: docs/strands.md#until-then-every-member-on-the-same-schema-version
files: packages/cadre-core/src/types.ts (`SAppConfig`), packages/cadre-core/src/strand-instance-manager.ts (`SAppInfo`, `verifiedSAppInfo`), packages/cadre-core/src/schema-verification.ts, packages/cadre-core/src/strand-membership-writer.ts (Header insert ~474-492), schemas/strand.qsql (`Header`), packages/quereus-plugin-sereus/src/strand-schema.ts (`STRAND_SCHEMA`, mirror of strand.qsql), packages/cadre-core/test/signed-sapp.ts, packages/cadre-core/test/schema-verification.spec.ts, the `signSchema(` call sites in packages/cadre-core/test/*.spec.ts and packages/integration-tests/src (list below), packages/reference-app-web/src/lib/chat-strand.ts, packages/reference-app-rn/src/chat-strand.ts, packages/reference-app-ns/src/chat-strand.ts, the three reference apps' README.md, .release-notes.pending.md
----

# An app declares its `App` schema version, and the author signs it

First of three tickets for gotchoices/sereus#59 (the stop-gap in docs/strands.md → "Until then: every member on the same schema version"). This one only adds the number and its signature. `app-schema-version-gates-strand-open` records it in the strand and refuses a lower one at connect; `app-schema-version-stops-a-running-member` handles a member already running.

## Decisions

**`SAppConfig.schemaVersion: number` is required.** A positive safe integer (1, 2, 3, …) the app raises with every change to its `App` schema text. Required rather than defaulted: a default hides a forgotten bump, and the project takes no backwards compatibility yet. It is distinct from `version` (the app's release string, which may change without a schema change).

```ts
export interface SAppConfig {
  id: string;
  version: string;
  /** Version of `schema`: a positive integer the app raises with every change to it. A strand refuses an app whose number is below the highest it has seen (docs/strands.md). */
  schemaVersion: number;
  schema: string;
  signature?: string;
  latencyHint?: LatencyHint;
}
```

`SAppInfo` (the instance's projection, `verifiedSAppInfo` in strand-instance-manager.ts) carries `schemaVersion` too.

**The author's signature covers `schemaVersion`.** Otherwise any host could hand a signed schema any number, including one higher than the author ever shipped, which would lock every other member out of the strand. The signed digest becomes the deterministic JSON `{"schema":…,"schemaVersion":…,"version":…}` (keys in that order, `JSON.stringify` of an object literal written in that order). No compatibility with signatures over the old payload: every signature is re-minted, and the test fixtures and reference web app sign at runtime anyway.

API shape (replaces the positional `(schema, version, …)` pair, so the three signed fields travel together and a call site cannot drop one):

```ts
type SignedSAppFields = Pick<SAppConfig, 'schema' | 'version' | 'schemaVersion'>;
export function signSchema(sApp: SignedSAppFields, authorPrivateKey: string): string;
export function verifySchema(sApp: SignedSAppFields, signature: string, authorPublicKey: string): boolean;
```

`assertSchemaSignature` keeps its shape and passes the config through. `SchemaVerificationError` keeps `version`; add `schemaVersion` to its message.

**Malformed `schemaVersion` is refused where the signature is checked.** `assertSchemaSignature` (it already runs before every launch and claim, under both signature policies) throws `SchemaVerificationError` with reason `'invalid schemaVersion'` when the value is not a safe integer ≥ 1. This runs even under `requireSignedSchemas: false`, which only excuses a missing signature.

**`Strand.Header` records the founding schema version.** Header stores the founding app's `sAppSchema`, `sAppVersion` and `sAppSignature`; once the signature covers `schemaVersion`, the stored signature cannot be checked without it. Add `sAppSchemaVersion integer null` to `Header` in `schemas/strand.qsql` and the `STRAND_SCHEMA` mirror (`strand-schema-drift.spec.ts` enforces the mirror), and have the founder's Header insert (`strand-membership-writer.ts`, the `headerSAppSignature` builder) write it. Nullable because a column added to an existing table must be (Optimystic's catalog-only `add column`); every new Header carries it.

**Reference apps.** Each `getChatSAppConfig()` declares `schemaVersion: 1`. Each reference app README gets one sentence where it describes the chat schema: raise `schemaVersion` with every change to `CHAT_SCHEMA`, and a strand refuses an app whose number is below the highest it has seen.

## Call sites of `signSchema(`

From `grep -rn "signSchema(" packages --include=*.ts`: cadre-core tests `cadre-node.spec.ts`, `schema-verification.spec.ts` (7), `signed-sapp.ts`, `strand-first-sync-gate.spec.ts`, `strand-instance-manager-backfill.spec.ts`, `-cluster-size.spec.ts`, `-hibernation.spec.ts`, `-membership.spec.ts`, `-network-addrs.spec.ts`, `-relay.spec.ts`, `-revocation.spec.ts`, `-storage-ownership.spec.ts`, `strand-instance-manager.spec.ts` (2), `strand-scope-key-validation.spec.ts`, `strand-unpublish.spec.ts`; integration-tests `harness/node-fixtures.ts`, `scenarios/convergence-stress.integration.ts`, `scenarios/strand-formation-e2e.integration.ts` (2), `scenarios/websocket-chat.integration.ts`; `reference-app-web/src/lib/chat-strand.ts`. Every `SAppConfig` literal in tests needs `schemaVersion` too; `yarn typecheck` (or each package's `tsc`) finds them.

## Edge cases & interactions

- `schemaVersion` of `0`, negative, fractional, `NaN`, a string, or above `Number.MAX_SAFE_INTEGER` → `SchemaVerificationError('invalid schemaVersion')`. One case in `schema-verification.spec.ts` (it already pins the missing/invalid split; add `0` and `1.5` as one table-driven case, nothing more).
- A signature minted over `schemaVersion: 1` presented with `schemaVersion: 2` and the same schema text → `'invalid signature'`. This is the one new behaviour worth a test: add it to `schema-verification.spec.ts`.
- The tampered-config path in `reference-app-web/src/lib/chat-strand.ts` (a valid signature over a mutated schema) must still fail; it does if it signs through the new API.
- Header's new column on a strand founded before this change: the Strand apply adds it as null to existing records; nothing reads it yet. By inspection.
- No runtime path reads `SAppConfig.schemaVersion` yet beyond verification. The plugin's connect options do not take it in this ticket; `app-schema-version-gates-strand-open` threads it.

## Docs

- docs/strands.md → "Until then": change "Not yet built (`plan/app-schema-version-gates-strand-open`)" to name the two follow-up tickets; state that `schemaVersion` is required and covered by the author's signature, with the reason (a host must not choose the number).
- `.release-notes.pending.md`: `SAppConfig.schemaVersion` is required; signatures from earlier releases no longer verify and must be re-minted (`signSchema` takes `{ schema, version, schemaVersion }`).

## TODO

- Add `schemaVersion` to `SAppConfig` and `SAppInfo`, project it in `verifiedSAppInfo`.
- Change `schemaDigest`, `signSchema`, `verifySchema`, `assertSchemaSignature` in schema-verification.ts; add the `'invalid schemaVersion'` refusal.
- Add `Header.sAppSchemaVersion integer null` to strand.qsql and `STRAND_SCHEMA`; write it in the founder's Header insert.
- Update every `signSchema(` call site and `SAppConfig` literal; reference apps declare `schemaVersion: 1`; README sentences.
- Two cases in `schema-verification.spec.ts` (signature bound to the number; malformed number refused).
- Docs and release notes as above.
- `yarn lint`, typecheck, and the cadre-core + quereus-plugin-sereus suites (`strand-schema-drift.spec.ts` included).
