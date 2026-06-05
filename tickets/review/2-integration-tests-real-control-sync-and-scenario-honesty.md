description: Review honesty pass on the integration scenarios. Real waitForControlSync (countRows poll) + happy-path honesty already landed via the prereq commit; THIS ticket only rewrote multi-party-sync to drop fabricated strand.parties assertions and assert real intra-cadre control-DB convergence / real libp2p connectivity. Suite green (6/6), typecheck green.
files: packages/integration-tests/src/scenarios/multi-party-sync.integration.ts, packages/integration-tests/src/scenarios/happy-path.integration.ts, packages/integration-tests/src/harness/test-network.ts, packages/cadre-core/src/control-database.ts, packages/integration-tests/src/scenarios/strand-creation.integration.ts
----

## What landed

The source ticket assumed two gaps remained after `formationinvite-fix-curve-and-wire-consent`:
(1) `waitForControlSync` was still a `sleep(100)` placeholder, and (2) both `happy-path` and
`multi-party-sync` asserted on stub-mutated `strand.parties`. **That premise was partly stale** —
the prereq commit (`71cfcb0`, reviewed in `15f009b`) had already:

- added `ControlDatabase.countRows(table)` + the `ControlTable` union (`control-database.ts:97-119,266-285`),
- replaced `waitForControlSync` with a **real poll** (`waitForCount` over `countRows`), scoped to the
  authority DB with the single-DB caveat documented in-code (`test-network.ts:200-231`),
- and rewritten `happy-path.integration.ts` to be honest (header delegating cross-party formation to
  `strand-formation-e2e`, real `waitForControlSync`/`queryStrands` reads, zero `strand.parties` asserts).

So Phase 1 and the happy-path half of Phase 2 were **already done and committed** before this ticket.
This ticket verified them (typecheck + a live run, see below) and closed the remaining gap:
**`multi-party-sync.integration.ts`**, which still carried the fabricated `strand.parties` assertions
(old lines 50-52, 113-116, 142-145).

## Change made by this ticket (the thing to review)

`multi-party-sync.integration.ts` fully rewritten for honesty, mirroring `happy-path`'s style:

- **No `strand.parties` assertions remain** anywhere in the file. Every surviving assertion is either a
  real control-DB read or real libp2p connectivity.
- Header comment explains the intra-cadre consent model and **delegates real cross-party formation to
  `strand-formation-e2e.integration.ts`**; `describe`/`it` titles renamed to say what is actually verified.
- Four tests, each with real signal:
  1. *two-party invite flow* — `createStrand`→`waitForControlSync(alice,'Strand',1)`+`queryStrands`;
     `createInvitation`→`waitForControlSync(...,'FormationInvite',1)`; `joinStrand(bob)`→
     `waitForControlSync(...,'FormationUsage',1)` + `countFormationUsage(token)===1`.
  2. *two independent cadres connect internally* — connectivity-only, `getConnections()` via
     `waitForCount` for both Carol's and Dave's separate cadres (distinct from happy-path, which only
     checks one cadre).
  3. *one open invite, two redemptions* — Frank + Grace each redeem the same unlimited-use invite;
     asserts `waitForControlSync(eve,'FormationUsage',2)` + `countFormationUsage===2` (the real signal
     is two distinct usage rows in the inviter's DB, not membership).
  4. *multiple distinct strands in one cadre* — two strands/invites, Ivy redeems both; asserts
     `Strand`/`FormationInvite`/`FormationUsage` each reach 2, plus distinct `strandId`/`sAppId` (real
     returned identifiers, not stub state).
- Dropped the now-unused `sleep` import.

`test-network.ts`/`control-database.ts` were **not modified by this ticket** — they are listed only so
the reviewer can confirm the prereq-landed pieces the assertions depend on.

## Validation performed

- `yarn workspace @serfab/cadre-core build` → clean (tsc silent-success; dist `.d.ts` exposes
  `countFormationUsage`/`ControlTable`).
- `yarn workspace @serfab/integration-tests typecheck` → **green** (whole package).
- `yarn workspace @serfab/integration-tests test multi-party-sync happy-path` →
  **2 files, 6 tests passed** in ~11s (real libp2p). Notably, the prereq's review had recorded the
  integration suite as "not agent-runnable (needs real networks)" — in THIS environment it **runs and
  passes**, so the prereq's unverified-harness caveat is now discharged for these two scenarios.

## Known gaps / honest flags for the reviewer

- **`strand-creation.integration.ts` still has the SAME fabricated pattern** — `expect(strand.parties)
  .toContain(...)` at `strand-creation.integration.ts:35,88-89`. It was **out of this ticket's named
  scope** (the ticket titled only happy-path + multi-party-sync), so I deliberately did not touch it.
  It is the same "asserts harness bookkeeping, not the system" issue. Reviewer's call: fix inline
  (it's a small, mechanical mirror of what was done here) or file a fix ticket. Flagging rather than
  silently leaving it.
- **`strand.parties` is still live harness state.** `test-network.ts:186` legitimately reads
  `strand.parties[0]` in `joinStrand` to locate the inviting party's control DB, so the field stays in
  `TestStrand`. After this change the `strand.parties.push(joiner.partyId)` at `test-network.ts:196` is
  no longer read by any test (only `[0]`, set at creation, matters) — it's now harmless bookkeeping that
  a reviewer could prune, but I left it to avoid behavior churn outside the ticket's intent.
- **`waitForControlSync` proves the authority/inviter DB view only**, not drone-side convergence (one
  `ControlDatabase` per party, on the authority node). This is documented in `test-network.ts:200-211`
  and `control-database.ts:266-285`, and is sufficient for these scenarios. Proving drone-side
  convergence would require standing up a `ControlDatabase` on a drone node.
- **Scope of the test run:** only the two touched scenarios + the full-package typecheck were run here,
  not the entire integration suite (e.g. `strand-formation-e2e`, `strand-creation`). My change is
  confined to one test file, so cross-suite breakage risk is nil, but the full suite was not executed in
  this pass.

## Net

The ticket's two requirements are met: `waitForControlSync` is a real poll (already landed; verified),
and neither `happy-path` nor `multi-party-sync` asserts on stub-mutated state — every assertion reflects
a real control-DB read or real connectivity, with cross-party formation explicitly delegated to
`strand-formation-e2e`. Suite green. The one parallel honesty issue left open
(`strand-creation.integration.ts`) is flagged above for the reviewer to triage.
