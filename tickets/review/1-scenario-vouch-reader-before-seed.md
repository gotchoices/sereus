description: Fixed two connection tests that skipped a required onboarding step, so a reader node was refused when it tried to join — now both tests vouch the reader first, like real onboarding does, and both pass.
files: packages/integration-tests/src/scenarios/control-write-while-alone-convergence.integration.ts, packages/integration-tests/src/scenarios/control-cohort-auto-convergence.integration.ts
---

# Reader node now vouched before it dials/seeds the owner

## What changed

Both scenarios booted owner **A** and reader **B**, then expected B to connect to A
and read replicated rows — but neither ever added B to A's member list first. A's
inbound connection gate (`admitInboundControlConnection`,
`packages/cadre-core/src/cadre-node.ts:841`) only admits an unvouched dialer while A
has zero authorized members (the cold-start carve-out). The moment either scenario
called `A.authorizePeer(X)` for its unrelated third-party row, that carve-out closed
and B's connection/dial was refused — deterministically, not flakily.

Fix mirrors production onboarding (`addDrone` / `acceptPhone` / `addPhoneWithRelay`
in `packages/cadre-core/src/seed-bootstrap.ts`, which all vouch before minting a
seed) and the pattern already used by the passing sibling scenario
`control-db-two-node-convergence.integration.ts`:

- **`control-write-while-alone-convergence.integration.ts`** — `bootPair` now calls
  `await A.authorizePeer(B.peerId!.toString())` right after `B.start()`, before the
  pair is ever connected.
- **`control-cohort-auto-convergence.integration.ts`** — the test now calls the same
  vouch immediately before `A.createSeed()`, so B's cold-start seed dial lands after
  A's authorized set already contains B.

Both files' header doc comments were updated to explain the vouch and why it doesn't
weaken what the scenario proves (it's a control-DB write, not a dial — the "zero
manual control dials" / "A genuinely alone at write time" claims each scenario makes
are unaffected).

## Test results

`npx vitest run src/scenarios/control-write-while-alone-convergence.integration.ts src/scenarios/control-cohort-auto-convergence.integration.ts --reporter=verbose` (from `packages/integration-tests`):

```
✓ control-cohort-auto-convergence.integration.ts > B converges on an owner-written CadrePeer row via in-node reconcile (production cold-start only)  1864ms
✓ control-write-while-alone-convergence.integration.ts > re-replicates an owner CadrePeer row written while alone, once the cohort forms  664ms
✓ control-write-while-alone-convergence.integration.ts > converges a DeviceToken self-registered while alone, once the cohort forms  714ms

Test Files  2 passed (2)
     Tests  3 passed (3)
```

All three pass, and fast — matching the ticket's fix-stage numbers (cohort-auto was a
45s timeout before, write-while-alone a 15s timeout).

Full integration suite (`npx vitest run` from `packages/integration-tests`): **27
passed, 1 failed** (28 files total). The one failure —
`push-wake-e2e.integration.ts > wakes a member whose authorization and address were
learned by control-DB replication, not local seeding` — is a pre-existing, already-
tracked intermittent failure (`bug-control-db-stale-revision-not-retryable`, listed
in `tickets/.pre-existing-known.md`, in-flight). It is unrelated to this ticket's
diff (a `NetworkTransactor` stale-revision/stream-reset race in the optimystic
transactor, not the connection gate touched here). Not re-reported.

`strand-formation-e2e.integration.ts > should form a strand with three parties`
(tracked as `bug-strand-three-party-replication`, also in `.pre-existing-known.md`)
passed in this run — that ticket's own fix has apparently already landed or the
failure is intermittent; not this ticket's concern either way.

Lint (`yarn eslint` on both changed files) and typecheck (`npx tsc --noEmit -p .`
in `packages/integration-tests`) are both clean.

## Suggested review focus

- Confirm the vouch placement in each file doesn't accidentally weaken the
  property each scenario claims to prove (see the updated header comments — both
  scenarios' "no manual dial" / "genuinely alone at write time" claims are
  reasoned through explicitly).
- `control-write-while-alone-convergence.integration.ts`'s `bootPair` is now
  near-identical to `control-db-two-node-convergence.integration.ts`'s `bootPair`
  (both vouch B right after `B.start()`) — worth a glance for whether that's worth
  extracting into a shared helper, though the ticket scope was explicitly "the
  two-line scenario correction plus comments," so this reviewer left it duplicated.
- Not touched, out of scope per the implement ticket: the production cold-start
  gap (`cold-start-control-redial`) and `bug-strand-three-party-replication`.

## Known gaps / not covered

- Did not re-run the full suite multiple times to confirm `push-wake-e2e`'s
  intermittency rate matches the ~3/10 figure already recorded against
  `bug-control-db-stale-revision-not-retryable` — took the existing tracking at
  face value since the failure signature (stale-revision/stream-reset in the
  optimystic transactor) matches exactly and the diff here never touches that
  code path.
