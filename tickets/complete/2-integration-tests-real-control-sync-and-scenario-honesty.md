description: Honesty pass on integration scenarios — real waitForControlSync poll + control-DB/connectivity assertions replacing fabricated strand.parties state. Implemented for happy-path + multi-party-sync (prereq + this ticket); reviewer extended the same fix to strand-creation and pruned the misleading harness `parties` field. Suite green (11/11 across the 3 scenarios), typecheck + lint green.
files: packages/integration-tests/src/scenarios/multi-party-sync.integration.ts, packages/integration-tests/src/scenarios/happy-path.integration.ts, packages/integration-tests/src/scenarios/strand-creation.integration.ts, packages/integration-tests/src/harness/test-network.ts, packages/integration-tests/src/harness/types.ts, packages/cadre-core/src/control-database.ts
----

## What this ticket delivered

The integration scenarios no longer assert on harness-fabricated state. `waitForControlSync`
is a real poll (`waitForCount` over `ControlDatabase.countRows`) and every scenario assertion
now reflects a real control-DB read or real libp2p connectivity. Cross-party formation is
explicitly delegated to `strand-formation-e2e.integration.ts` in the file headers.

Landed across the prereq commit (`71cfcb0`: `countRows`/`ControlTable`, real
`waitForControlSync`, honest `happy-path`), the implement commit (`a35a201`: honest
`multi-party-sync`), and this review pass (honest `strand-creation` + harness cleanup).

## Review findings

**Implement diff reviewed first, with fresh eyes** (`git show a35a201` — the `multi-party-sync`
rewrite), then cross-checked against the harness (`test-network.ts`), the control-DB primitives
(`control-database.ts`), and the sibling scenarios.

### Checked — what was verified
- **The rewritten `multi-party-sync.integration.ts` is honest and real.** All four tests assert
  either a real control-DB read (`waitForControlSync` → `countRows`, `queryStrands`,
  `countFormationUsage`) or real libp2p connectivity (`getConnections()`). No `strand.parties`
  assertion survives. Verified each assertion's backing primitive exists and is real:
  `countRows` validates the table against `CONTROL_TABLES` and runs `select count(1)`
  (`control-database.ts:276`); `countFormationUsage` filters by token (`:739`); `queryStrands`
  reads `CadreControl.Strand` (`:252`). Confirmed.
- **Prereq pieces the assertions depend on** — `waitForControlSync` is a genuine poll scoped to
  the authority DB with the single-DB caveat documented in-code (`test-network.ts:200-231`,
  `control-database.ts:266-285`). Confirmed, not a `sleep` stub.
- **`happy-path.integration.ts`** — already honest (header delegates cross-party formation, real
  reads, zero `strand.parties`). Confirmed.
- **Tests run and pass in this environment** (real libp2p): `strand-creation` +
  `multi-party-sync` + `happy-path` → **3 files, 11 tests passed** (~7s). The prereq review's
  "integration suite not agent-runnable" caveat is discharged for these three scenarios here.
- **Typecheck** (`yarn workspace @serfab/integration-tests typecheck`) → green (whole package).
- **Lint** (`eslint` on all four touched files) → 0 errors.
- **Docs** — read the in-code scope docs the change relies on (`test-network.ts` `waitForControlSync`
  doc, `control-database.ts` `countRows`/`ControlTable` doc). They accurately describe the
  authority-only convergence scope. No separate doc file references `strand.parties` assertions
  (grep across `docs/` and the package), so nothing was left stale.

### Found & fixed inline (minor)
- **`strand-creation.integration.ts` carried the SAME fabricated `strand.parties` pattern** that the
  implementer explicitly flagged out-of-scope (old lines 35, 88-89). Fixed it as a mechanical mirror
  of the honest pattern:
  - "create a strand record" now asserts the row really landed via
    `waitForControlSync(alice,'Strand',1)` + `queryStrands().some(Id === strandId)`.
  - "join a strand via invitation" now asserts the real consent row via
    `waitForControlSync(dave,'FormationUsage',1)` + `countFormationUsage(token) === 1`, instead of
    `expect(strand.parties).toContain(...)`.
  - Dropped now-unused `waitUntil`/`sleep` imports.
- **Misleading harness `parties` field + dead write.** With no test reading `strand.parties` anymore,
  `strand.parties.push(joiner.partyId)` (`test-network.ts:196`) was a dead write, and the
  `parties: string[]` field name implied a membership roster the harness never honestly maintained.
  Renamed `TestStrand.parties` → `inviterPartyId: string` (the only real fact the harness tracks and
  the only thing `joinStrand` actually reads, formerly `parties[0]`), removed the dead push, and
  documented that joiner membership is the real `FormationUsage` row, not local bookkeeping. Touched
  `types.ts`, `test-network.ts` (createStrand init + joinStrand inviter lookup). Retypechecked + retested.

### Found & filed (major)
- None. The remaining honesty parallels were small and mechanical, so they were fixed inline rather
  than deferred.

### Not changed (with reason)
- **`waitForControlSync` proves the authority/inviter DB view only**, not drone-side convergence —
  one `ControlDatabase` per party on the authority node. This is a deliberate harness design,
  documented in `test-network.ts:200-211` and `control-database.ts:266-285`, and sufficient for these
  scenarios. Proving drone-side convergence would require standing up a `ControlDatabase` on a drone
  node — out of scope and not a defect.
- **Pre-existing lint warning** `QueryResult` unused import (`test-network.ts:21`, warn-level) — present
  before this ticket, untouched by these edits, non-blocking (build exits 0). Left as-is; not part of
  the honesty theme.
- **Full integration suite** (`strand-formation-e2e`, etc.) was not run in this pass — only the three
  touched scenarios + full-package typecheck/lint. The changes are confined to those three test files
  plus harness type/routing internals (`inviterPartyId`), and `strand-formation-e2e` does not reference
  `.parties` (grep-confirmed), so cross-suite breakage risk is nil.

## Net

The ticket's requirements are met and extended: `waitForControlSync` is a real poll, and **no**
scenario (`happy-path`, `multi-party-sync`, **or** `strand-creation`) asserts on stub-mutated
state — every assertion reflects a real control-DB read or real connectivity. The harness no longer
carries a misleading membership field. 3 scenarios / 11 tests green, typecheck green, lint clean.
