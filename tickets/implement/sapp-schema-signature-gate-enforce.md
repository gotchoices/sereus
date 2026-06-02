description: Make the sApp schema-signature gate fail-closed under an explicit requireSignedSchemas policy so an unsigned/tampered/wrong-key SAppConfig cannot gate-pass strand join
files: packages/cadre-core/src/schema-verification.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/test/schema-verification.spec.ts, packages/cadre-core/test/strand-instance-manager.spec.ts, packages/integration-tests/src/scenarios/strand-formation-e2e.integration.ts, packages/reference-app-rn/src/cadre-phone.ts, packages/reference-app-rn/src/chat-strand.ts, docs/architecture.md
effort: medium
----

# Enforce signed sApp schemas (fail-closed gate)

## Problem

The `3-app-schema-verification` work wired `assertSchemaSignature(sAppConfig)` into
`StrandInstanceManager.startStrand()` ahead of resource allocation, intending that an ed25519
author signature gates strand formation/join. The gate does not deliver that guarantee because it
is **opt-in**: `assertSchemaSignature` returns success when `sAppConfig.signature` is falsy
(`schema-verification.ts:73-76` logs "skipping verification" and returns), and `SAppConfig.signature`
is declared optional with the documented semantics "omit to skip verification" (`types.ts:257`). A
config with no signature — malicious or carelessly assembled — passes unconditionally. There is no
configuration under which the step can be relied on to reject an unsigned schema, so the gate
protects only against tampering of configs that *happen* to be signed, not against absence of a
signature.

## Goal

Introduce an explicit, node-level policy controlling whether a signed schema is **required**.
Under the enforcing policy the gate must **fail closed**: a config whose `signature` is absent is
rejected before any libp2p node or schema DDL is brought up, with a diagnostic distinct from the
"invalid signature" case. The policy defaults to enforcing; it may be relaxed only by explicit
opt-out for dev/test. The policy name `requireSignedSchemas` is already referenced as the owner of
the unsigned case by `tickets/implement/1-integration-tests-rbac-signed-write-coverage.md:101-103` —
keep that name.

## Design

### Policy surface

Add an optional flag to `CadreNodeConfig` (`types.ts:159-183`):

```ts
/**
 * Require a valid author signature on every sApp schema before a strand is
 * formed or joined. Defaults to true (fail closed): an unsigned schema is
 * rejected. Set false ONLY for dev/test where unsigned demo schemas are used.
 */
requireSignedSchemas?: boolean;
```

Default semantics are **fail-closed**: an omitted flag means "require". This is the secure default
and means every currently-signed caller (all integration scenarios, unit fixtures) keeps passing
unchanged. Do **not** sniff `NODE_ENV` / `process.env` to infer "dev" — it is brittle and not
cross-platform (AGENTS.md). Relaxation is always explicit via the flag.

### Verification function

Extend `assertSchemaSignature` to take the policy (`schema-verification.ts:70-85`):

```ts
export function assertSchemaSignature(
  sAppConfig: SAppConfig,
  options?: { requireSignature?: boolean }   // default requireSignature = true
): void
```

Behavior:

- `signature` absent (falsy):
  - if `requireSignature !== false` → throw `SchemaVerificationError(id, version, 'missing signature')`
  - else → log "skipping verification" and return (current behavior, dev/test only)
- `signature` present: unchanged — missing author key throws `'missing author public key'`;
  failed `verifySchema` throws `'invalid signature'`.

Keep the three reasons distinct in the error surface (`'missing signature'` vs `'invalid signature'`
vs `'missing author public key'`) so the operator can tell absence from tampering. `SchemaVerificationError`
already carries `sAppId`/`version` — reuse it as-is.

### Wiring (policy flow)

```
CadreNodeConfig.requireSignedSchemas
  └─ CadreNode.launchStrand()  (cadre-node.ts:535-558)
       └─ StartStrandConfig.requireSignedSchemas   (new field, strand-instance-manager.ts:34-51)
            └─ StrandInstanceManager.startStrand()  (strand-instance-manager.ts:154-156)
                 └─ assertSchemaSignature(sAppConfig, { requireSignature: <resolved> })
```

- Add `requireSignedSchemas?: boolean` to `StartStrandConfig`. Threading it through `StartStrandConfig`
  (rather than the manager constructor) keeps the manager's existing no-arg constructor and lets the
  unit tests drive both enforcing and relaxed paths directly at the manager seam. Resolve the default
  to `true` at the call site: `const requireSignature = config.requireSignedSchemas ?? true;`.
- In `launchStrand`, pass `requireSignedSchemas: this.config.requireSignedSchemas` into the
  `startStrand(...)` config object (alongside the existing `storage`/`network`/`profile` passthrough).

### Type/doc reconciliation

Update the `SAppConfig.signature` doc (`types.ts:257`) so it no longer implies skipping is a safe
default. Keep the field optional (authoring/serialization still needs to represent an as-yet-unsigned
config), but document that it is **required under the default `requireSignedSchemas` policy** and that
omitting it is honored only when the node explicitly relaxes the policy. Update `docs/architecture.md:807`
(Implementation Status, schema verification) to state the gate is now enforced by default via
`requireSignedSchemas`.

### Reference-app-rn (notable tradeoff — must address)

`reference-app-rn` builds an **unsigned** demo config: `getChatSAppConfig()` returns no `signature`
and uses `id: 'sereus-chat-simple'`, which is not even an ed25519 public key
(`chat-strand.ts:34-41`). Under the new fail-closed default this app would stop forming strands.

Because the demo `id` is a name and not a keypair, signing it properly is out of scope. Instead, set
the explicit dev relaxation in the demo node config: add `requireSignedSchemas: false` to the
`CadreNodeConfig` in `cadre-phone.ts:90-106`, and add a comment on `getChatSAppConfig` noting the
config is unsigned and only usable with the relaxed policy (dev/demo). This both keeps the app working
and serves as the canonical example of explicit opt-out. (If a follow-up wants a properly-signed demo
sApp with a real author keypair, park it in `backlog/` — do not grow this ticket.)

## Tests

### Unit — `schema-verification.spec.ts`

The two existing tests "should skip verification when signature is omitted/empty"
(`:83-100`) assert the now-removed default. Update them to the new contract:

- omitted/empty signature **with default policy** → `toThrow(SchemaVerificationError)` and
  `toThrow('missing signature')`.
- omitted/empty signature **with `{ requireSignature: false }`** → `not.toThrow()`.
- valid signature with default policy → `not.toThrow()` (already covered, keep).
- invalid signature with `{ requireSignature: false }` → still `toThrow('invalid signature')`
  (relaxation only excuses *absence*, never a *bad* signature).

### Unit — `strand-instance-manager.spec.ts`

`createSAppConfig()` always signs, so existing tests stay green under the default. Add:

- unsigned `SAppConfig` with default policy → `startStrand` rejects with `SchemaVerificationError`
  (`'missing signature'`), and `getInstance(strandId)` is `undefined` (no libp2p node / DB created).
  Mirror the existing "should reject config with invalid signature" assertions (`:151-166`).
- unsigned `SAppConfig` with `requireSignedSchemas: false` in the start config → reaches
  `status: 'active'` (relaxed path). Use a minimal unsigned config (drop the `signature` from
  `createSAppConfig`). Clean up with `stopAll()`; mark `30000` timeout like the siblings.

### Integration — `strand-formation-e2e.integration.ts`

Add a negative-path block (a new `describe`/`it` near the existing signed-config setup at `:76-110`,
`:357-365`) that drives **each of the three cases through the real `addStrand` creation/join path and
asserts rejection before bring-up**, under the enforcing default policy:

- **unsigned**: `SAppConfig` with `signature` omitted → `addStrand(...)` rejects.
- **tampered**: valid signature over the original schema, but `schema` mutated (append `' -- injected'`)
  → rejects (`'invalid signature'`).
- **wrong-key**: `signature` produced by a different author private key than `id` → rejects.

Assert the strand instance never reaches `active` (e.g. `node.getStrand(strandId)` is `undefined`
after the rejection). Existing scenarios already pass signed configs and inherit the enforcing
default, so they need no change — but verify they still construct `CadreNodeConfig` without tripping
the new default (they sign, so they will not). Reuse the `createSignedSAppConfig` helper and add a
sibling `createUnsignedSAppConfig` / wrong-key / tamper variants local to the scenario.

Note: the RBAC unsigned-write coverage is explicitly owned here, not in
`1-integration-tests-rbac-signed-write-coverage` — that ticket defers the unsigned case to this one.

## Validation

- `yarn workspace @serfab/cadre-core test 2>&1 | tee /tmp/cadre-core-test.log` (unit suites above).
- Typecheck: `yarn workspace @serfab/cadre-core build 2>&1 | tee /tmp/cadre-core-build.log` (and the
  reference-app-rn package if it has its own typecheck, since `cadre-phone.ts`/`chat-strand.ts` change).
- Integration: `strand-formation-e2e` is a real-network suite and may exceed the 10-min idle window;
  run the single negative-path file/test with streamed output if feasible
  (`yarn workspace @serfab/integration-tests test -t "<negative path name>" 2>&1 | tee /tmp/it.log`),
  otherwise document the deferral to CI per the stage rules and rely on the unit-level coverage.

## TODO

- [ ] Add `requireSignedSchemas?: boolean` to `CadreNodeConfig` with fail-closed doc (`types.ts`).
- [ ] Reconcile `SAppConfig.signature` doc to drop "omit to skip verification" safe-default implication.
- [ ] Extend `assertSchemaSignature(sAppConfig, { requireSignature })`; throw `'missing signature'` when required and absent (`schema-verification.ts`).
- [ ] Add `requireSignedSchemas?: boolean` to `StartStrandConfig`; resolve default `true` and pass `{ requireSignature }` into `assertSchemaSignature` (`strand-instance-manager.ts`).
- [ ] Thread `this.config.requireSignedSchemas` through `CadreNode.launchStrand` into `startStrand` (`cadre-node.ts`).
- [ ] Set `requireSignedSchemas: false` in `reference-app-rn` demo node config and note the unsigned demo config (`cadre-phone.ts`, `chat-strand.ts`).
- [ ] Update `docs/architecture.md:807` to state the gate is enforced by default.
- [ ] Update/extend `schema-verification.spec.ts` per the new contract (missing → throw; explicit relax → allow; bad sig still throws).
- [ ] Add `strand-instance-manager.spec.ts` cases: unsigned rejected by default (no instance); unsigned allowed when relaxed (active).
- [ ] Add `strand-formation-e2e` negative-path coverage: unsigned / tampered / wrong-key rejected through `addStrand` before bring-up.
