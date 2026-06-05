description: Enforced fail-closed sApp schema-signature gate — an unsigned/tampered/wrong-key SAppConfig is rejected before strand bring-up under the default requireSignedSchemas policy. Reviewed and completed.
files: packages/cadre-core/src/schema-verification.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/test/schema-verification.spec.ts, packages/cadre-core/test/strand-instance-manager.spec.ts, packages/integration-tests/src/scenarios/strand-formation-e2e.integration.ts, packages/reference-app-rn/src/cadre-phone.ts, packages/reference-app-rn/src/chat-strand.ts, packages/reference-app-ns/src/cadre-phone.ts, packages/reference-app-ns/src/chat-strand.ts, docs/architecture.md
----

# Completed: enforce signed sApp schemas (fail-closed gate)

## Summary

The sApp schema-signature gate is now **fail-closed by default**. `assertSchemaSignature`
previously returned success whenever `SAppConfig.signature` was falsy, so an unsigned config
gate-passed strand formation/join unconditionally. A node-level policy `requireSignedSchemas`
(default `true`) now causes an absent signature to be rejected *before* any libp2p node or schema
DDL is brought up, with a diagnostic (`'missing signature'`) distinct from the tampering case
(`'invalid signature'`). Relaxation (`requireSignedSchemas: false`) excuses **absence only** — a
present-but-bad signature still throws regardless.

The single verification chokepoint is `StrandInstanceManager.startStrand`, reached by both
strand-formation paths via `CadreNode.launchStrand` (`addStrand` and the control-discovered path).
`resumeStrand` rebuilds a quiesced strand from its retained launch config without re-verifying —
acceptable, since the schema was already verified at initial launch and the retained config is
internal, not attacker-controlled.

## Review findings

### What was checked
- **Implement diff read first, fresh eyes**, before the handoff summary (commit `eeee104`).
- **Single-chokepoint analysis**: every strand bring-up path (`addStrand`, control-discovered
  `launchStrand` at `cadre-node.ts:657`, `addStrand`→`launchStrand` at `cadre-node.ts:929`) funnels
  through `startStrand` → `assertSchemaSignature`. The `resumeStrand`/hibernation rehydrate path
  (`buildStrandRuntime` direct) was examined and deemed correctly exempt (already-verified schema).
- **Error-path / edge coverage**: absent vs empty-string signature, tampered schema, wrong author
  key, relaxed-but-still-invalid, distinct reason strings — all covered by unit + integration tests.
- **Other strand-forming callers** swept for missed unsigned configs (the new regression surface):
  reference-app-rn (opted out — done by implementer), reference-app-web (correctly **signs** — no
  change needed), reference-app-ns (MISSED — see finding below), and all integration scenarios
  (`multi-party-workflows`, `convergence-stress`, `websocket-chat`, `rbac-signed-write`, the e2e
  Phase 1/2 fixtures) — all sign, so they inherit the enforcing default cleanly.
- **Docs**: `architecture.md` (updated, accurate). `reference-app-rn.md`/`reference-app-ns.md`
  mentions of "no signature verification" describe *app-level* permissionless schema write-rules — a
  different layer than the ed25519 author-signature gate — so they are not stale.
- **Lint + full test/typecheck run** (see Validation).

### Findings & disposition

- **MAJOR — scope leak (reconciled, no new ticket):** commit `eeee104` (this ticket) also bundled a
  **partial** implementation of the *separate* `cadre-provider-secure-default-auth` ticket (still in
  `implement/`): provider closed-by-default auth, `allowInsecureNoAuth` opt-in, `validateAuthConfig`,
  `permissions.ts` (`Scope`/`hasPermission`), `requireScope` route enforcement, README, and the
  `shutdown-after.test.ts` fix. Those **source/docs changes are correct and the provider build + 38
  vitest tests pass**, but **none of that ticket's required tests were committed** (scope/403/default-
  closed/`hasPermission` units). Disposition: the source is left in place (correct, and reverting
  committed history is worse); the existing `cadre-provider-secure-default-auth` implement ticket was
  **reconciled in-place** — landed items checked off with an explicit "do not re-apply" reconciliation
  note, remaining scope narrowed to the outstanding test additions. It flows forward normally; no new
  ticket needed.

- **MINOR — fixed inline: reference-app-ns regression.** The NativeScript reference app
  (`reference-app-ns`, twin of `reference-app-rn`) forms chat strands with the same unsigned,
  name-`id` demo config but was **not** opted out. Under the new fail-closed default its
  `createChatStrand` would throw `'missing signature'` at bring-up — a runtime regression directly
  caused by this ticket. Fixed by mirroring the reference-app-rn change: added
  `requireSignedSchemas: false` (with the same explanatory comment) in `cadre-phone.ts` and the
  unsigned-config doc comment on `getChatSAppConfig()` in `chat-strand.ts`. `reference-app-ns`
  typecheck passes.

- **Code quality (no findings):** SPP/DRY/type-safety/error-handling/resource-cleanup all sound.
  `requireSignature` defaulting in both `startStrand` and `assertSchemaSignature` is harmless
  defensive redundancy (both default `true`). `id ?? ''` in the error constructor is harmless
  defensive coding. Phase 3 integration tests clean up nodes in `finally`. No leaks.

- **Known gaps (acceptable, unchanged from handoff):** the full `strand-formation-e2e` Phases 1–2
  (real-network replication) were not run end-to-end here — only the new Phase 3 negative-path tests;
  Phases 1–2 sign and inherit the enforcing default, and exceed the 10-min idle window, so CI/human
  should run them out-of-band. Neither reference app has an automated test exercising relaxed-policy
  strand formation (covered by typecheck + the cadre-core relaxed-path unit test); a properly signed
  demo sApp with a real author keypair remains a possible `backlog/` follow-up, intentionally out of
  scope.

## Validation run (review pass)

- `yarn workspace @serfab/cadre-provider build` → exit 0 (verifies leaked provider changes compile).
- `yarn workspace @serfab/cadre-provider test` → **38 passed (7 files)**.
- `yarn workspace @serfab/cadre-core test` → **292 passed (21 files)**.
- `yarn lint` → **0 errors** (123 pre-existing backlogged warnings in unrelated packages; none in
  changed files).
- `yarn workspace @serfab/integration-tests test -t "fail-closed"` → **3 passed** (Phase 3:
  unsigned/tampered/wrong-key rejected before bring-up, `getStrand` undefined; ~10s, no real-network).
- `yarn workspace @serfab/reference-app-rn typecheck` → exit 0.
- `yarn workspace @serfab/reference-app-ns typecheck` → exit 0 (covers the inline fix).
- `yarn workspace @serfab/integration-tests typecheck` → exit 0.

## Implementation reference (as landed)

- `schema-verification.ts` — `assertSchemaSignature(sAppConfig, options?: { requireSignature?: boolean })`;
  `requireSignature` defaults `true`. Absent+required → `SchemaVerificationError(id, version, 'missing
  signature')`; absent+relaxed → log + return; present-but-bad → `'invalid signature'` always; missing
  author key → `'missing author public key'`. Three distinct reasons preserved.
- `types.ts` — `CadreNodeConfig.requireSignedSchemas?: boolean` (fail-closed default). `SAppConfig.signature`
  stays optional in the type (authoring/serialization) but documented as required under the default policy.
- `strand-instance-manager.ts` — `StartStrandConfig.requireSignedSchemas?: boolean`; `startStrand` resolves
  `requireSignature = config.requireSignedSchemas ?? true` and verifies **before** `instances.set(...)`.
- `cadre-node.ts` — `launchStrand` threads `requireSignedSchemas: this.config.requireSignedSchemas`.
- `reference-app-rn` + `reference-app-ns` — both opt out (`requireSignedSchemas: false`) with comments,
  since their demo chat configs are unsigned/name-`id`.
- `docs/architecture.md` — schema-verification status documents the enforced default and the
  `'missing'` vs `'invalid'` distinction.
