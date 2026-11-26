description: This machine's local copies of the Optimystic and Quereus libraries are older than the versions Sereus requires, so the build fails and several invitation tests fail. Somebody who owns those copies needs to update and rebuild them.
files:
  - ../optimystic (sibling checkout; `main` at 76239355, version 1.28.0)
  - ../quereus (sibling checkout; `main` at 83d52e2f0, version 5.6.0)
  - package.json (root `resolutions` link `@optimystic/*` to `../optimystic/packages/*`)
  - packages/cadre-core/package.json (declares `@optimystic/db-core` `^1.29.0`)
  - packages/cadre-core/src/control-write-retry.ts (imports `PeersIncompleteError`, reads `.phase`)
  - scripts/check-dep-ranges.mjs (the gate that already reports this drift)
  - test-harness/build-freshness.ts (the stale-build guard, which does not catch this)
difficulty: easy
repro: verified
----

# Dependency outside this repo: the `../optimystic` and `../quereus` checkouts are older than the versions sereus requires

**Blocked category:** a dependency outside this repo. **Unblocks when:** the owner of the sibling checkouts on this machine fast-forwards `../optimystic` (to at least `v1.29.0`) and `../quereus` (to at least `v5.6.1`) to `origin/main` and rebuilds both.

## What fails

The root `package.json` `resolutions` link every `@optimystic/*` package to `../optimystic/packages/*`, so sereus builds and tests against whatever that checkout last built. That checkout is on `main` at `76239355` ("tickets: garden report, runner stopped to move machines"), where `packages/db-core/package.json` says `1.28.0`. The tree is clean and the commit is an ancestor of `origin/main` (`18a5277d`, release `1.29.1`), 162 commits behind it.

sereus declares `@optimystic/db-core` `^1.29.0` (commit `7f32848a6`, "deps: require Optimystic ^1.29.0"). `v1.29.0` (`0584e74c`) is the first release that exports `PeersIncompleteError` and puts `phase` on it (`packages/db-core/src/transactor/peers-incomplete-error.ts`). sereus has used both since `cd9e4978` (`debt-control-retry-matches-the-transactor-aggregate-by-phase`). The sereus code matches the version it declares. The checkout it is linked to is the problem.

`../quereus` has the same problem on a smaller scale. It is on `main` at `83d52e2f0` (version `5.6.0`) with a clean tree, 7 commits behind `origin/main` (`09871b755`, "chore: release v5.6.1"), and a fast-forward reaches it. sereus declares `@quereus/quereus` `^5.6.1`. No failure has been traced to the quereus gap yet, but it violates the same declared range and should be fixed in the same pass.

Each checkout's `dist` matches its own `src`, so the stale-build guard (`test-harness/build-freshness.ts`, which compares modification times only) passes. `node scripts/check-dep-ranges.mjs` (see `docs/contributing/gates.md` → "Declared dependency ranges") does catch it. It reports 33 declared ranges that do not admit the linked version, all with the note "declared range is newer than the linked workspace — local development is behind what is promised".

Observed at HEAD `768b10f0`:

- `yarn workspace @serfab/cadre-core typecheck`:
  ```
  src/control-write-retry.ts(1,41): error TS2305: Module '"@optimystic/db-core"' has no exported member 'PeersIncompleteError'.
  src/control-write-retry.ts(225,12): error TS2339: Property 'phase' does not exist on type 'Error'.
  src/control-write-retry.ts(252,73): error TS2339: Property 'phase' does not exist on type 'Error'.
  test/control-read-retry.spec.ts, test/control-write-lock.spec.ts, test/control-write-retry.spec.ts: same TS2305
  ```
  `yarn build` fails in `@serfab/cadre-core` the same way, and the dependents are skipped.
- At runtime the import is `undefined`, so `link instanceof PeersIncompleteError` throws `TypeError: Right-hand side of 'instanceof' is not an object` whenever a failed control read or write is classified (`isUncommittedTransactorAggregate`, `reportsIndeterminateCommit`). A member then answers a refusable cadre-invitation redemption with a retryable `internal` refusal instead of its real code. Failing integration scenarios (reported by the `invitations-lead-with-stable-machines` implement run):
  - `enrollment-e2e.integration.ts` › "negative cases › should refuse an expired cadre invitation with invite-spent": `expected CadreInviteUnreachableError … to be an instance of CadreInviteRejectedError`.
  - `cadre-invite-any-member.integration.ts` › "A mints a grant and an invitation, stops; …": the same assertion.
  - `cadre-host-join-by-invitation.integration.ts` › steps 1–2: `Timeout waiting for hosted node … joins or fails after 90000ms`, and step 3 fails as a result. This one was attributed to the same throw without a debug trace.

## Why an agent here does not fix it

Fixing it means changing the sibling repositories' working trees (`git pull --ff-only` plus `yarn build` in each). Triage rules for this repo forbid editing sibling `src/`. The checkout was also left parked when its runner was stopped to move machines, so whether to update it here is the call of whoever runs Optimystic's pipeline. Changing sereus would be wrong. Lowering the declared floors (the gate's "suggested edit") or removing the phase-based classifier would undo `7f32848a6` and `cd9e4978` to match out-of-date checkouts, and `^1.28.0` would advertise a range that cannot run this code.

## Proposed action

Recommended: in `../quereus` and then `../optimystic`, run `git pull --ff-only` on `main` (a fast-forward, since both trees are clean), then `yarn build`. Then re-run `node scripts/check-dep-ranges.mjs` (expect no drift), `yarn workspace @serfab/cadre-core typecheck`, and the three scenarios above from `packages/integration-tests`. The change can be undone by moving the checkouts back.

Alternative considered: pin the sibling to the `v1.29.1` tag instead of `main`. That is not needed, because sereus already tracks Optimystic's head.

If nothing is done: the `cadre-core` build stays red on this machine, every dependent package's build is skipped, and every scenario that classifies a failed control operation reports a misleading error.

## Why the drift was misdiagnosed

The report that found this read it as a code defect because the stale-build guard passed. The range gate above already answers the question in one command. Whoever triages a missing-export or `instanceof` error from an `@optimystic/*` or `@quereus/*` import should run it before reading the code.
