---
description: The new tests for invitations that need outside sign-off are written but have not been run yet, because running them first needs a sibling project rebuilt.
files: packages/integration-tests/src/scenarios/strand-formation-e2e.integration.ts, packages/integration-tests/src/harness/fixtures/approval-hook-server.ts, test-harness/build-freshness.ts, docs/api.md
difficulty: easy
---

# Validate the three new Phase 5 cases

## What already landed (do not redo)

The code half of `debt-approval-gated-redemption-remaining-e2e` is written and
`yarn workspace @serfab/integration-tests typecheck` passes clean:

- `packages/integration-tests/src/harness/fixtures/approval-hook-server.ts` — `decide` may now
  return `'unavailable'`, answering HTTP 503 ("the hook is up but broken"). Additive; the existing
  `'approve' | 'refuse' | FormationApproval` callers are unchanged.
- `strand-formation-e2e.integration.ts` Phase 5 — three new cases:
  - **(vi)** approver cannot be asked. Arm A publishes `http://127.0.0.1:1/hook` (privileged port,
    connect refused) and asserts `Formation approval unavailable, retry`, zero usage rows, a
    standby hook at `requestCount === 0`, and `ControlFormationUsageRecorder.isTokenUsed === false`.
    Arm B publishes a LIVE hook that answers 503, asserts the same reason, then flips the verdict
    to approve and re-redeems the SAME token — the proof the seat survived.
  - **(vii)** `misconfigured` via an `ftp://127.0.0.1:9/hook` `ValidationUrl`, with a live standby
    hook asserted at `requestCount === 0` (the scheme check runs before any HTTP).
  - **(viii)** the bound invitation shape: a closed strand inserted owner-signed up front, an
    invite naming it, and assertions that the joiner is seated on the pre-existing strand, receives
    that strand's `memberPrivateKey`, and that the approver was still posted only the five signed
    fields.
- `publishGatedInvite` gained an optional trailing `strandId` (unbound stays the default).
- The Phase 5 block comment and the file's top-of-file `wc -l` NOTE (now 1742) are updated.
- `docs/api.md` — the coverage paragraph after the reason table now says all five reasons and both
  invitation shapes run end to end, keeping the pointer to the real-fetch spec for transport.

## Why this is a separate ticket

The suite could not be run. `packages/integration-tests/test/global-setup.ts` calls
`assertBuildFresh`, which fails the run up front:

```
Stale build detected: these tests run real compiled output.
  - @quereus/quereus: dist is stale — src was edited after the last build.
    Run in C:\projects\quereus: yarn workspace @quereus/quereus build
```

`C:\projects\quereus` is a sibling working copy linked in through the root `package.json`'s
`resolutions`, outside this repository. The agent's shell could not change directory into it (the
harness resets the working directory), so the remedy the guard prints could not be carried out.
This is unrelated to the ticket's changes — it is the linked sibling's build being older than its
own sources.

## TODO

- Run `yarn workspace @quereus/quereus build` from `C:\projects\quereus` (or whatever it takes to
  make `assertBuildFresh` pass) before anything else. If other linked targets are also reported
  stale, build those too.
- `yarn workspace @serfab/integration-tests test 2>&1 | tee <scratch>/it.log` — stream it, do not
  silently redirect. Note that a plain vitest path filter of
  `src/scenarios/strand-formation-e2e.integration.ts` reported "No test files found"; filter by the
  bare name (`strand-formation-e2e`) if a single-file run is wanted.
- Run the scenario at least twice and record, for the review handoff, how many consecutive runs
  were green and how long case (vi) arm A took. Arm A is expected to be fast (connect refused
  immediately). If it instead takes ~10 s, the environment is silently DROPPING the connection to
  port 1 rather than refusing it, and the approval client's own 10 s budget is what fires — same
  `unavailable` category, so the case still passes, but say so in the handoff, and confirm it did
  NOT surface as `Formation conflict, retry` or as an abort (the responder's provisioning budget is
  12 s by default, so a 10 s approval wait must still fit inside it).
- `yarn lint`.
- Hand off to `review/` with the summary above plus the measured results.
