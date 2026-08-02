description: A check that a lent-out machine really does save its network credentials to disk was written but never actually run; it now has been run, twice, and it passed both times — closing out with no code changes.
files: packages/integration-tests/src/scenarios/cadre-host-node-donation.integration.ts
difficulty: easy
---

# Verification confirmed — no functional changes

## What this ticket was

`cadre-host-node-donation.integration.ts` step 6b (assertions that a donated node
persists its identity key + node-local trust stores to its workdir) existed in source
but had never actually been executed/confirmed passing. This ticket's job was to run it
and report the result — not to write new code.

## What was done

1. Rebuilt the three packages the scenario depends on, in order:
   `@serfab/cadre-core` → `@serfab/cadre-cli` → `@serfab/cadre-host`. All three build clean.
2. Ran the full scenario:
   ```
   cd packages/integration-tests && yarn vitest run --reporter=verbose src/scenarios/cadre-host-node-donation.integration.ts
   ```
   All 6 ordered steps pass, including step 6b. Confirmed twice now (once before this
   ticket, once during it) — no drift between runs.

Step 6b specifically verifies, after the donated node has synced into the requester's
cadre and written its state to disk:

- `identity.key` decodes to the same peer id the requester approved (so a re-spawn from
  this workdir rejoins as the same node, not a stranger),
- a `bootstrap-peers.<party>.json` file exists in the workdir,
- a `trusted-owners.<party>.json` file exists in the workdir.

## Result

No defect found. No code change made. The identity-key spawn wiring and the node's
own file-backed store creation both work as designed.

## Test coverage for reviewer

- Full command: `cd packages/integration-tests && yarn vitest run --reporter=verbose src/scenarios/cadre-host-node-donation.integration.ts`
- This is the only test this ticket touched. It is a real-process integration scenario
  (spawns actual `cadre-cli` processes), not a unit test — expect ~19s wall time
  (mostly module transform/import, not test execution).
- No other test suites were run as part of this ticket; this ticket made no source
  changes, so no other suite should be affected. If the reviewer wants broader
  confirmation, the relevant regression surface is just `@serfab/cadre-core`,
  `@serfab/cadre-cli`, `@serfab/cadre-host` — but again, nothing in this ticket touched
  their source.

## Known gaps

- None specific to this ticket — it was a run-and-confirm task with a pre-written
  assertion set. Any deeper coverage gaps in the donation flow itself are out of scope
  here (this ticket didn't audit the scenario file for missing cases, only ran what
  already existed).

## Review findings

(none — no defect found, no code changed)
