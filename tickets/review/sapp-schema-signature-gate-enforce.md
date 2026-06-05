description: Review the fail-closed sApp schema-signature gate — an unsigned/tampered/wrong-key SAppConfig must be rejected before strand bring-up under the default requireSignedSchemas policy
files: packages/cadre-core/src/schema-verification.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/test/schema-verification.spec.ts, packages/cadre-core/test/strand-instance-manager.spec.ts, packages/integration-tests/src/scenarios/strand-formation-e2e.integration.ts, packages/reference-app-rn/src/cadre-phone.ts, packages/reference-app-rn/src/chat-strand.ts, docs/architecture.md
----

# Review: enforce signed sApp schemas (fail-closed gate)

## What changed

The sApp schema-signature gate is now **fail-closed by default**. Previously
`assertSchemaSignature` returned success whenever `SAppConfig.signature` was
falsy, so an unsigned config gate-passed strand formation/join unconditionally.
A new node-level policy `requireSignedSchemas` (default `true`) now causes an
absent signature to be rejected *before* any libp2p node or schema DDL is brought
up, with a diagnostic distinct from the tampering case.

### Implementation

- **`schema-verification.ts`** — `assertSchemaSignature(sAppConfig, options?: { requireSignature?: boolean })`.
  `requireSignature` defaults to `true`. When a signature is absent and required →
  throws `SchemaVerificationError(id, version, 'missing signature')`. When absent
  and relaxed → logs and returns (old behavior). A *present-but-bad* signature
  still throws `'invalid signature'` regardless of the relaxation — relaxation
  excuses absence only. Missing author key still throws `'missing author public key'`.
  Three distinct reasons preserved so operators can tell absence from tampering.
- **`types.ts`** — added `CadreNodeConfig.requireSignedSchemas?: boolean` (fail-closed
  doc). Reconciled `SAppConfig.signature` doc: still optional in the type (authoring/
  serialization needs to represent unsigned configs) but documented as required under
  the default policy; omission honored only when the node relaxes the policy.
- **`strand-instance-manager.ts`** — added `StartStrandConfig.requireSignedSchemas?: boolean`.
  `startStrand` resolves `const requireSignature = config.requireSignedSchemas ?? true`
  and passes `{ requireSignature }` into `assertSchemaSignature`. The verify call is
  ahead of `this.instances.set(...)`, so a rejection leaves no instance.
- **`cadre-node.ts`** — `launchStrand` threads `requireSignedSchemas: this.config.requireSignedSchemas`
  into the `startStrand` config (covers both `addStrand` and the control-discovered path).
- **`reference-app-rn`** — `cadre-phone.ts` sets `requireSignedSchemas: false` (demo opt-out,
  with a comment) because `getChatSAppConfig()` returns an unsigned config whose `id`
  is a name, not an ed25519 key. `chat-strand.ts` documents the config is unsigned/dev-only.
- **`docs/architecture.md`** — schema-verification status now states the gate is enforced
  by default via `requireSignedSchemas`, distinguishing `'missing'` vs `'invalid'`.

## Use cases / behavior to validate

- **Fail-closed default:** an unsigned `SAppConfig` (no/empty `signature`) rejects with
  `'missing signature'` and no strand instance is created — this is the core security guarantee.
- **Tampering still caught:** signature over original schema + mutated `schema` → `'invalid signature'`.
- **Wrong key still caught:** signature by a different private key than `id` → `'invalid signature'`.
- **Explicit relaxation:** `requireSignedSchemas: false` lets an *unsigned* config through
  (strand reaches `active`) but does NOT excuse a *bad* signature.
- **No `NODE_ENV`/env sniffing** — relaxation is always explicit via the flag (per AGENTS.md).
- **Existing signed callers unchanged:** all integration scenarios and unit fixtures sign,
  so they inherit the enforcing default without modification.

## Tests added/updated (all passing)

- `schema-verification.spec.ts`: omitted/empty signature under default → throws `'missing signature'`;
  under `{ requireSignature: false }` → no throw; invalid sig under relaxed → still throws `'invalid signature'`.
- `strand-instance-manager.spec.ts`: unsigned config under default → rejects with `'missing signature'`,
  `getInstance` undefined; unsigned config with `requireSignedSchemas: false` → reaches `active`.
- `strand-formation-e2e.integration.ts`: new **Phase 3** describe drives unsigned / tampered / wrong-key
  through the real `addStrand` path and asserts rejection + `node.getStrand(strandId)` undefined.
  Local helpers `createUnsignedSAppConfig` / `createTamperedSAppConfig` / `createWrongKeySAppConfig`.

## Validation run

- `yarn workspace @serfab/cadre-core build` → exit 0.
- `yarn workspace @serfab/cadre-core test` → **292 passed (21 files)**.
- `yarn workspace @serfab/reference-app-rn typecheck` → exit 0.
- `yarn workspace @serfab/integration-tests typecheck` → exit 0.
- `yarn workspace @serfab/integration-tests test -t "fail-closed"` → **3 passed** (Phase 3 only;
  the gate rejects before bring-up so these run solo in ~150ms, no real-network dependency).

## Known gaps / reviewer attention

- The **full** `strand-formation-e2e` suite (Phases 1–2, real-network replication) was NOT run
  end-to-end here — only the new Phase 3 negative-path tests were executed. Phases 1–2 use signed
  configs and inherit the enforcing default; they construct `CadreNodeConfig` without setting the
  flag, which resolves to `true` and passes because they sign. A reviewer/CI should still run the
  full suite to confirm no regression in the real-network paths (it can exceed the 10-min idle window).
- `reference-app-rn` has no automated test exercising the relaxed-policy strand formation; the
  opt-out is covered only by typecheck + the unit-level relaxed-path test in cadre-core. A properly
  signed demo sApp with a real author keypair was intentionally left out of scope (would be a
  `backlog/` follow-up if desired).
- The RBAC unsigned-write coverage that `1-integration-tests-rbac-signed-write-coverage` defers to
  this ticket is satisfied by the Phase 3 unsigned case at the strand-formation seam; if the reviewer
  expects unsigned coverage specifically inside the RBAC write scenario, flag it.
