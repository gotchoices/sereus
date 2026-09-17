----
description: A joiner device that writes its own participant row and first message immediately after joining a chat no longer loses that write; the underlying storage bug this was blocked on has been fixed upstream and confirmed here.
files:
  - packages/integration-tests/src/scenarios/strand-chat-participants-converge.integration.ts (test "a joiner that writes IMMEDIATELY after addStrand resolves still converges — nothing is lost (the device shape)")
  - packages/cadre-core/src/strand-first-sync-gate.ts (the gate: Header held AND every App table read once)
  - docs/strands.md ("Joining: no writes before the first sync" — the now-resolved residual removed)
----

# What was true, and what changed

The device-shape scenario (joiner writes its participant row and a message the instant `addStrand` resolves) was intermittent below the sereus gate: the joiner could not read a row it had just committed, so its message insert failed `_fk_Message_ParticipantId` even though the participant commit had reported success. Sereus's first-sync gate was not at fault — it already held the joiner back until it had the Header and had read every app table — the defect was in optimystic's storage layer.

Optimystic (`optimystic-4e`) diagnosed the cause: in a two-member strand the host stored the log block but the joiner refused it, so the commit reported "not durable" and the data-block changes were rolled back on both machines; on retry the joiner found its own log entry and reported success even though the row existed nowhere. The fix (`3416d5a8` implement, `ab67fa47` review, on top of diagnosis `7cd71341`) makes a write count as saved only when every block its log entry names holds that revision, and has the writer re-send a kept attempt under the same action id and revision when it finds its own entry. A new `TornActionError` (`reason: rival-holds-revision | completion-refused | transforms-not-held`) surfaces the cases it still can't complete.

# Testing

Rebuilt `db-core`, `db-p2p`, and `quereus-plugin-optimystic` from the linked `../optimystic` checkout, then ran the device-shape scenario alone, one process at a time (not parallel — shared machine, tight memory):

```
cd packages/integration-tests
npx vitest run --reporter=verbose src/scenarios/strand-chat-participants-converge.integration.ts -t "IMMEDIATELY"
```

**10 runs, 10 passes.** No foreign-key failures, no 30 s convergence timeouts, no `TornActionError`. Logs in `tickets/.logs/device-shape-rerun-{01..10}.log` (self-pruning).

# What is still open, elsewhere

- Optimystic's own backlog still carries a case where the joiner checks the log block before the host finishes storing it, which can surface as a loud `completion-refused` `TornActionError` or an extra retry instead of a silent loss. Not reproduced in these 10 runs; nothing to do here unless it shows up.
- Separately, optimystic flagged (`fix/2`, not yet landed) that a transaction spanning several collections can be reported as not-saved even though one collection's part already saved, which would double-apply on a naive whole-transaction retry. Worth remembering if a future control-path retry ever spans collections, but no code here currently does that.
- The other residual in `docs/strands.md` ("no writes before the first sync") — a table nobody has written yet can still be invented twice by two machines racing its first write — is untouched by this fix and remains tracked via `tickets/blocked/forked-control-collection-sync-livelocks.md`.

# Review findings

Not a review-stage ticket — this closes out a `blocked/` ticket once its upstream dependency landed, per the ticket's own "what to do when optimystic reports the fix" instructions (rebuild, rerun ≥5×, and on passing remove the `docs/strands.md` residual). Ran 10× rather than the ticket's minimum 5 at the reporting peer session's request. No code changes were needed on the sereus side; the gate's existing behavior (Header + every App table read before publish) was already correct and is now demonstrated end to end.
