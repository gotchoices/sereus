description: sApp signed-write RBAC integration coverage (authorized accepted / unauthorized rejected on a real two-node strand) plus the repaired+collapsed simple-sapp fixture. Reviewed and completed.
prereq:
files: packages/integration-tests/src/scenarios/rbac-signed-write.integration.ts, packages/integration-tests/fixtures/simple-sapp.qsql, packages/integration-tests/src/fixtures/index.ts, packages/integration-tests/src/scenarios/happy-path.integration.ts, tickets/.pre-existing-error.md

# Summary

Adds the missing sApp-level RBAC integration coverage and repairs/collapses the
`verify()`-gated fixture. A new scenario drives a signed write through a real
two-`CadreNode` strand (formed over libp2p) and asserts authorized writes are accepted
while unauthorized ones are rejected. The malformed fixture was repaired so it actually
verifies signatures, and the dead fixture surface (`SIMPLE_SAPP_LOGIC`, `wrapSAppSchema`)
was retired so `simple-sapp.qsql` is the single source of truth.

**Status: reviewed; typecheck green; rbac-signed-write + happy-path pass.**

# What changed (implement stage, commit f594228)

- `fixtures/simple-sapp.qsql` — repaired: `AuthorizedWrite` now digests the concatenated
  authenticated payload `Id||'|'||Name||'|'||coalesce(Value,'')` with `'sha256','utf8'`
  (was passing `Name`/`Value` as the digest *algorithm*/*encoding* args), all `verify()`
  calls pin the explicit `'ed25519'` curve (member keys are ed25519; default is
  secp256k1), both insert and update branches require a valid signature, update pins
  `new.CreatedBy = context.MemberKey`, and `Signature` is nullable so a missing signature
  reaches `verify()` rather than tripping a NOT-NULL context error.
- `src/fixtures/index.ts` — removed the inline `SIMPLE_SAPP_LOGIC` duplicate and the dead
  `wrapSAppSchema` helper; `loadSimpleSApp()` is the single source. `MINIMAL_SAPP_LOGIC`
  retained (used by multi-party-sync / strand-creation).
- `happy-path.integration.ts` — switched to `await loadSimpleSApp()`.
- `rbac-signed-write.integration.ts` — NEW scenario: two real `CadreNode`s, `formStrand`
  over libp2p, `addStrand({ strandRow, sAppConfig })` on each side, signed RBAC DML via
  `strand.database!.getDatabase().exec(... with context MemberKey=?, Signature=? ...)`.

# Review findings

Adversarial pass over the implement diff (read first, with fresh eyes, before the
handoff summary). Scrutinized for correctness, the signer↔constraint contract, DRY,
type safety, resource cleanup, error/edge paths, dead references, and doc staleness.

## Verified (no change needed)

- **Crypto contract holds.** Confirmed against `@optimystic/quereus-plugin-crypto`
  source: `verify(data, signature, publicKey, curve='secp256k1', inputEncoding='base64url',
  ...)` and `digest(data, algo='sha256', inputEncoding='base64url', outputEncoding='base64url')`.
  The fixture correctly pins `'ed25519'` (member keys are ed25519). Byte-equivalence is
  real: signer hashes to raw bytes and signs them; the constraint passes
  `digest(payload,'sha256','utf8')` (base64url of the *same* hash bytes) to `verify()`,
  whose default base64url `inputEncoding` decodes it back to those bytes. Signer and
  verifier operate on identical data.
- **Constraint semantics correct.** `AuthorizedWrite` (unqualified CHECK) fires on
  insert+update only; `AuthorizedDelete` (`check on delete`) fires on delete only —
  confirmed by the passing creator-delete case (a plain CHECK firing on delete would have
  rejected case 7, since `new.*` is null there). Update branch's ownership +
  no-reassignment clauses verified by cases 2/5.
- **Negative cases reject for the right reason, not spuriously.** Positives (1,2,7) accept
  using the same SQL shape the negatives use, so the rejections in 3–6 are genuine
  constraint failures, not parse/no-op artifacts (rows targeted by 5/6 exist, so the
  constraint is actually evaluated). Case 3 isolates wrong-*payload*; case 4 missing sig;
  case 5 wrong *member* (ownership clause); case 6 non-creator delete.
- **No dangling references.** `SIMPLE_SAPP_LOGIC` / `wrapSAppSchema` have zero remaining
  code references (only the ticket text). `multi-party-sync` and `strand-creation` use the
  retained `MINIMAL_SAPP_LOGIC`. Package typecheck green.
- **Resource cleanup.** `try/finally` stops both nodes; `node.stop()` cascades to the
  strand-instance libp2p nodes (confirmed by the "Stopping libp2p node: strand-…" output).
- **Docs.** No `docs/` file references the fixture, `loadSimpleSApp`, or sApp signed-write
  RBAC, and this is a test-only change with no production-behavior shift — so there is no
  doc staleness to repair. The fixture itself carries accurate inline contract docs.

## Minor — fixed inline this pass

- **Null-`Value` edge case was untested and, as written, impossible.** The handoff flagged
  that the `coalesce(Value,'')` / `${value ?? ''}` empty-segment equivalence was only
  exercised for non-null values. Investigating revealed the real reason: **Quereus follows
  Third Manifesto semantics and defaults unqualified columns to NOT NULL**
  (`quereus/.../schema/table.ts:150`, `default_column_nullability='not_null'`). The
  fixture's `Value text` was therefore NOT NULL, making the null-handling branch dead code
  and a null insert fail with `NOT NULL constraint failed: Items.Value`.
  - Fix: declared `Value text null` (with an explanatory comment) so the column matches the
    constraint's evident intent, and added **case 8** — an authorized insert with a null
    `Value`, asserting it is accepted and stored null. This makes the
    `coalesce`/`??` empty-segment branch genuinely reachable and exercised.

## Minor — noted, deliberately not changed

- **Helper duplication with `strand-formation-e2e`.** `wsTransports`,
  `createTestNodeConfig`, `createMockProvisioner`, and `createSignedSAppConfig` are
  re-declared locally, mirroring the e2e file (where they are file-local, not exported).
  Lifting them into the harness would touch and risk the e2e file for a pure-cosmetic gain;
  left as-is, consistent with the existing in-repo pattern. Not worth a ticket.

## Not asserted (owned elsewhere — not re-litigated here)

- **Cross-node replication is observed, not asserted.** The strand runs in `bootstrap`
  (local-transactor) mode because no `CadrePeer` rows exist yet (control-sync unwired), so
  writes stay node-local. The scenario logs `replication observed=false` as a best-effort
  observation and does not gate on it. This is the same gap as `strand-formation-e2e`
  Phase 2 (pre-existing-red; see `tickets/.pre-existing-error.md`) and is owned by ticket
  `2-integration-tests-real-control-sync-and-scenario-honesty`. Confirmed at HEAD; flagged,
  not chased, per the pre-existing-failure protocol.
- **Single effective writer / second node only proves schema-applies.** Because of
  bootstrap mode Bob never receives the writes; the "wrong member N" case exercises a
  different *MemberKey in context*, which is the correct unit of sApp RBAC (application
  identity, not peer identity). The two-node setup still earns its keep by proving the
  constrained fixture applies cleanly through the real `addStrand`/`executeSchema`
  (`declare schema App {…} apply schema App`) path on a second node — the open question
  from the source ticket, now resolved positively.

No major findings → no new fix/plan tickets filed.

# Validation performed (review stage)

- `yarn workspace @serfab/integration-tests typecheck` → exit 0
- `yarn workspace @serfab/integration-tests test rbac-signed-write` → **1 passed** (~3.4s),
  now including the null-`Value` case 8.
- `yarn workspace @serfab/integration-tests test happy-path` → **2 passed** (the handoff
  had skipped this despite changing its import; confirmed the `loadSimpleSApp()` switch
  works).
- No lint script exists in `@serfab/integration-tests` (scripts: clean/build/typecheck/
  test/test:watch/test:debug) — typecheck is the standing static gate and is green.
- Not run: the full integration suite (many heavy real-network scenarios, several
  slow/flaky independent of this change; the change is test-only and confined to the rbac
  scenario + fixture + fixtures/index, all of which are covered above).
