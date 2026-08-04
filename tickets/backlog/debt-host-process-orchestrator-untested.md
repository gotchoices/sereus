---
description: The component that starts, stops, and cleans up the node processes on a self-hosted machine has no tests of its own — everything that checks it is checked against a hand-written imitation instead.
files: packages/cadre-host/src/orchestrator/host-process-orchestrator.ts, packages/cadre-host/src/donation/__tests__/fake-orchestrator.ts, packages/cadre-host/src/orchestrator/__tests__/node-identity.test.ts
difficulty: medium
---

# `HostProcessOrchestrator` has no tests

`packages/cadre-host/src/orchestrator/host-process-orchestrator.ts` is the class that starts a node
as a child process, remembers it, hands out its network ports, stops it, and deletes its working
directory. It is roughly 1,000 lines and there is no test file for it. The only test in
`src/orchestrator/__tests__/` is `node-identity.test.ts`, which covers one helper it calls.

Everything that exercises the class's behaviour today does so against `FakeOrchestrator`, a
hand-written stand-in used by the donated-node unit tests. That stand-in has been deliberately shaped
to imitate the real class (see the completed ticket `debt-fake-orchestrator-handle-fidelity`), which
makes it a *model* of the real behaviour with nothing anchoring the model. If the real class's rules
change, or if they were never quite what we believe, no test notices.

## The rules currently modelled but never verified

- A second start of the same node forgets the first one's record and frees its four ports
  (`dropStaleHandle`).
- If that second start then fails, the first one's record and ports come back exactly as they were
  (`restoreDroppedHandles`) — so a failed restart does not lose the node that is still there.
- Asking to stop or delete a node the class no longer knows about is an error, not a silent success
  (`requireHandle`).
- Deleting a node frees its ports and removes its working directory; stopping one does not.
- After a manager restart, records are read back off disk and their ports re-held even for nodes that
  turned out to be dead (`init`).

## Why this is worth doing

The self-hosted manager hands out ports from a bounded range and deletes directories that hold the
identity key a borrower's network has approved. A mistake in this bookkeeping either strands a
directory forever or deletes one that was supposed to survive — both already the subject of their own
tickets (`debt-failed-provision-strands-workdir`, and the completed
`debt-failed-respawn-strands-donated-workdir`). Neither of those could be verified against the real
class when they were written.

## What is wanted

A test suite that drives the real class. The obvious objection is that it spawns real node processes
and would be slow — but the class already lets a caller supply the program it runs
(`HostProcessConfig.spawn.entrypoint`). Pointing that at a small stub script, rather than the real
`cadre-cli`, would exercise the genuine start/stop/port/state machinery against a child that starts
instantly. The stub would need to do the one thing the real child does that the class watches for:
write its startup token to the file it is handed.

Worth settling as part of the work:

- Whether the stub-entrypoint approach is enough, or whether some cases need the real `cadre-cli`
  child and therefore belong in a slower suite (and where this package keeps such a suite — it does
  not have one today).
- Whether these tests are safe to run in parallel with other suites, given they bind real ports and
  send real signals. Windows process teardown in particular is asynchronous, and the class already
  carries retry logic for it.
- Whether the cross-checks against `FakeOrchestrator` should be explicit — the fake's contract suite
  and the real suite asserting the same rules side by side, so a future divergence is visible.

## Status note (added while reviewing `debt-failed-provision-strands-workdir`)

Most of this has since landed, unremarked, in
`packages/cadre-host/src/__tests__/orchestrator.test.ts` — 951 lines driving the real class against a
stub entrypoint, which is exactly the approach proposed above. The premise "there is no test file for
it" no longer holds, and of the five rules listed as unverified, four now are: `dropStaleHandle`,
`restoreDroppedHandles`, "deleting frees ports and removes the working directory, stopping does not",
and the restart re-attach. The class is now ~1,130 lines.

What is still open:

- The `requireHandle` rule — stopping or deleting a node the class no longer knows about must be an
  error, not a silent success — is asserted only against `FakeOrchestrator`, never against the real
  class.
- The explicit fake-versus-real cross-check (the last bullet above) was never done. The two suites
  assert overlapping rules independently, so a divergence between the model and the real class is
  still invisible.
- Whether any case needs a real `cadre-cli` child, and where a slower suite would live, was never
  settled — the stub-entrypoint suite simply grew instead.

Whoever triages this should decide whether the remainder is worth its own smaller ticket or whether
this one should be rewritten down to the two open items.
