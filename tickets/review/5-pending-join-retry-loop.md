description: An app can now ask to join through an invitation and have the party keep trying in the background, across restarts and from any of its owner machines, until the join works, the invitation is used up or expires, or the user cancels; the app can read and follow the status. Review the retry policy, the concurrent-writer handling and the "written while cut off" decision.
architecture: docs/strands.md#joining-while-the-inviter-is-offline
files: packages/cadre-core/src/pending-join-runner.ts (new), packages/cadre-core/src/cadre-node.ts (requestJoin / listPendingJoins / dismissPendingJoin / recordJoinRequest / startPendingJoinRunner / stageMembershipInvitesFromPendingJoins after formStrand; runner start at the end of start(), stop in cleanup(), kick in initializeSeedBootstrap, step 5 of runDrainControlReplication; FormationPostApprovalError in rememberFormedStrand and adoptFormationMembershipInvite), packages/cadre-core/src/strand-formation-rejection.ts (FormationPostApprovalError), packages/cadre-core/src/types.ts (PendingJoinStatus, 'pendingJoin:changed'), packages/cadre-core/src/index.ts, packages/cadre-core/test/pending-join-runner.spec.ts (new), packages/integration-tests/src/scenarios/pending-join-survives-restart.integration.ts (new), docs/strands.md, docs/api.md, docs/architecture.md, .release-notes.pending.md
----
# Pending join: request, retry, status — review handoff

Part of gotchoices/sereus#25. Builds on `pending-join-control-table` (the `PendingJoin` table and its `ControlDatabase` methods) and `formation-rejection-codes` (typed `FormationRejectedError` / `FormationUnreachableError`).

## What landed

**API on `CadreNode`:**

- `requestJoin(invitation, disclosure = {})` throws on a machine that is not an enrolled owner (naming `formStrand` as the one-shot alternative) and on an invitation with an invalid or past expiration. Otherwise it writes the `PendingJoin` row (`ExpiresAt = min(invitation.expiration, now + 30 days)`), runs one attempt at once and returns the status after it.
  - If the party already holds a row for the invitation, a pending one is adopted as it is and a finished one is replaced by a fresh pending row.
  - If the insert conflicts with a row this machine still holds under a retired stamp (dismissed elsewhere, not reaped yet), it throws a "try again once connected" error.
- `listPendingJoins()` returns every row, with this machine's `trying`/`waiting` laid over a pending row.
- `dismissPendingJoin(id)` is an owner-signed delete with a tombstone, and stops this machine's tracking.
- Event `'pendingJoin:changed'`, emitted by the runner on owner machines.
- `formStrand`'s two "approved, then a local step failed" throws are now `FormationPostApprovalError` (exported, carries `strandId`).

**`PendingJoinRunner` (`pending-join-runner.ts`)** runs the policy behind a seam `CadreNode` fills: read rows/row, attempt (`formStrand`), replace, remove, `isOwner`, `isAlone`, `sAppIdOf`, `observeRows`, `emit`, plus clock, random and scheduler.

- **Passes.** One at start, then every 30 s. Each pass checks owner status first; a non-owner pass cancels every row timer, so there is no retry storm.
- **Schedule.**
  - A row seen for the first time gets a stagger in `[0, base)` from an FNV hash of (peer id, row id). `base = 2 × formationDeadlines(L).dialMs`.
  - Backoff is `min(base·2^(n−1), 10 min)` ±20 %.
  - At most 2 background attempts run at once. The explicit `requestJoin` attempt does not wait for a slot.
  - A scheduled time is clamped to `ExpiresAt`.
- **Classification.** Exactly as the ticket specified (the `docs/strands.md` section lists it).
  - `token-spent`: re-read the row and adopt an outcome if it has one. Otherwise run one confirming attempt after `2 × sessionMs`; a second `token-spent` on a still-pending row fails it.
  - A join that landed but whose outcome write failed is kept in memory (`joinedHere`). The next attempt or pass re-writes `joined` instead of dialling a spent token.
- **Concurrent writes.** `resolveLostWrite`:
  - row gone → do not recreate;
  - live row `joined` → adopt it;
  - our outcome is `joined` → rewrite over whatever is live;
  - otherwise adopt the live row.
  - Rewrite rounds are capped at 3, after which the next pass decides.
- **Age-out.** A finished row is removed 7 days after `OutcomeAt`, only while this machine has a control connection.
- **Staging from rows.** Each owner pass calls `stageMembershipInvitesFromPendingJoins`:
  - it stages a `joined` row's `MembershipInvite` (younger than 7 days, invite key not yet staged in this process) when no invitation is staged for that strand;
  - it records the invite key;
  - `adoptFormationMembershipInvite` also records its own key, so the runner never re-stages an invitation this machine's own formation already settled.

## Decisions a reviewer should weigh

- **Writing while cut off from the party (the open edge case in the ticket).** `requestJoin` and outcome writes go ahead with no control connection: keeping the request across a restart is the feature. The runner remembers, in memory, each row whose latest write by this machine committed alone. On the next 0→≥1 control-connection edge (new step 5 of `runDrainControlReplication`), it re-writes that row with identical content under a fresh stamp, if the live stamp is still the one it wrote. The tombstones of those replaces already go through the existing `noteGuardedDelete` queue.
  - **Not covered:** a process that stops before reconnecting. That row reaches the party only with its next write. The first-growth sweep that would cover it costs one permanent `Revocation` tombstone per row per process start; this is recorded as a `NOTE:` on `reissueWritesMadeAlone`.
  - The alone test is the existing proxy (zero control connections). A formation dial to the inviter is itself a control connection, so it counts as "not alone" and fires the growth edge. That is the same imprecision every other write here has.
- **Kick on `initializeSeedBootstrap`.** Apps wire the owner key after `start()` (`runOwnerGenesis`, cadre-cli), so the start pass usually finds the machine not yet an owner. Without the kick, a restarted phone would wait 30 s before its first attempt. This was not in the ticket.
- **`lastError.code` gained `'local'`** beyond the ticket's union. It is used when an attempt threw something that is not a formation error, or an outcome write failed. `failure.code` uses `'local'` for `FormationPostApprovalError`, as specified.
- **No events and no staging on non-owner machines.** The ticket says to skip the pass there. Staging is read-only and could run on a donated machine that launches the strand first. That belongs with `blocked/decide-non-owner-machine-completes-a-pending-join`.
- **Two machines redeeming the same staged invitation** (ticket's verify-by-reading item). `strand-membership-reconciler.ts` already handles it. The loser's `consumeInvite` fails on `ConsumedInvite`'s primary key → `dead-invite` → it drops the invitation and keeps running. A later pass sees the `Member` row and writes its own `MemberPeer` binding. If it sees the member row first, the burn arm drops the dead invitation and goes on to the binding. No code change.

## Tests added

- `packages/cadre-core/test/pending-join-runner.spec.ts`, driven through the seam with an in-memory table (real stamp check, `PendingJoinChangedError`), scripted attempts and a hand-cranked clock:
  - table case: `token-spent` twice → `failed: token-spent`, 2 attempts;
  - table case: `token-spent` while another machine wrote `joined` → that join is adopted, 1 attempt;
  - table case: final rejection → `failed` with its code and reason;
  - table case: `FormationPostApprovalError` → `failed: local`;
  - table case: a sibling writes `failed` during a successful attempt → `joined` replaces it (`PendingJoinChangedError` path);
  - unreachable / busy / unreachable then approval → `waiting` gaps grow strictly, and the final status is `joined`;
  - a row past `ExpiresAt` → `failed: expired` with no attempt.
- `packages/integration-tests/src/scenarios/pending-join-survives-restart.integration.ts`, the ticket's scenario with a **closed** strand:
  1. The host founds a strand and publishes a single-use bound invitation, then stops.
  2. The joiner (an owner) calls `requestJoin` and gets `waiting` with `unreachable`, then stops.
  3. The joiner restarts as a new `CadreNode` on the same key and raw stores.
  4. The host restarts on the same key, stores **and port**, and relaunches its strand.
  5. The joiner's loop records `joined` (`pendingJoin:changed`, row `joined` with `MembershipInvite`), the strand is claimed from `strand:discovered`, and the joiner's party becomes a `Strand.Member`.
  - Both parties declare `linkRoundTripMs: 100`, so retries come in seconds.
  - A debug run confirmed the approving attempt ran in the restarted process, after the host came back.

## Validation

- `yarn lint`: exit 0.
- `yarn workspace @serfab/cadre-core test`: 149 files, 2362 passed, 1 skipped.
- New scenario: 5 of 5 runs green, 4–8 s each.
- Also green on the rebuilt dist: `strand-formation-e2e` (22 passed; its 4 skipped belong to `relay-round-trip-measure`, which skips itself), `strand-formation-concurrent-redemption`, `strand-always-on-replica-hosts-cross-party-join` and `strand-formation-cross-party-seed`. The rest of the integration suite was not run.
- Typecheck still fails, all on the tracked `@libp2p/interface` 3.1/3.3 split (`fix/typecheck-fails-on-libp2p-interface-3-1-against-linked-optimystic-3-3`). Counts are unchanged and none of the errors is in a file this ticket added or changed:
  - `cadre-core`: 36 errors;
  - `integration-tests`: 8 errors.
- `@serfab/cadre-core` dist was rebuilt for the integration runs. No sibling repo was built or touched.

## Known gaps

- **The cross-machine membership-invitation staging has no test.** That is the path where one owner machine finishes a closed join and another launches the strand. The scenario covers only the same-machine path (formStrand's own staging). A two-owner-machine scenario would cost about a minute of integration time; `backlog/debt-join-through-a-sibling-machine-unscenarioed` is the nearest existing ticket (on the inviter side).
- **The other untested branches:**
  - the re-issue of rows written alone (`reissueWritesMadeAlone`);
  - age-out;
  - `requestJoin`'s adopt and replace of an existing row;
  - the non-owner pause.

  Each has a few lines of branching. They were judged below the test bar; a reviewer may disagree about the re-issue.
- **The scenario rebinds the host's loopback port after stopping it**, so the invitation's address works again. Another process could take the port in between; I did not see this in 5 runs.
- **Logs.** The runner logs row ids, codes and strand ids. Errors from decoding a stored invitation are replaced by a message that names only the row, because a JSON parse error can quote the input, which includes the token.
- **Cost of a pass.** Every owner node now reads `PendingJoin` (and the owner key) every 30 s. For a party that never asked for a join, that reads a never-written block, which consults the cohort. The same cost exists for `JoinedStrand`. Recorded as a `NOTE:` at the `readRows` dep.
- **The reference apps still call `formStrand`.** `backlog/feat-reference-apps-show-pending-joins` owns switching them.
