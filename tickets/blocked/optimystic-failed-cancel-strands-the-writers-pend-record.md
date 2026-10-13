description: When a storage-group member answers a write's first step and then goes silent, the write fails, its cancellation cannot reach the full group either, and the writing machine keeps the half-finished write's marker in its own storage. After the member recovers, that machine refuses every later write to the same table for as long as it runs. The fix belongs in Optimystic; Sereus has no workaround.
files: packages/integration-tests/src/scenarios/control-write-degraded-cohort-member.integration.ts, ../optimystic/packages/db-core/src/transactor/network-transactor.ts (dischargeCancel), ../optimystic/packages/db-p2p/src/repo/coordinator-repo.ts (cancel), ../optimystic/packages/db-p2p/src/cluster/cluster-repo.ts (validatePendOperations), ../optimystic/tickets/backlog/debt-unpromotable-pending-records-need-a-sweep.md
----
# Upstream: a cancel that misses the unanimity bar strands the writer's pend record

**Blocked on:** a dependency outside this repo (Optimystic). Unblocks when Optimystic releases a fix and Sereus adopts it.

## The defect

On a three-member cohort the super-majority bar is 3 (`ceil(3 × 0.75)`), so one silent member decides every cluster transaction. Consider a member that answers a write's pend and then stops answering:

1. The pend succeeds: all three members promise and A and B apply it (`finalCommits: [A, B]`, retry pending for C).
2. The commit fails with `Failed to get super-majority: 2/3 approvals (needed 3, 0 rejections)`, twice (one-round commit, then `commitTailThenSweep`).
3. `dischargeCancel` runs three cancel rounds. Each fails with the same shortfall (`coordinator-repo:cancel-error`), so no member applies the cancel.
4. The member recovers. Nothing re-sends the cancel. The writer's own storage (here the coordinator, A) keeps the pending record, and `ClusterMember.validatePendOperations` votes `held` on every later pend of that block (`validation-pending-conflict … rivals: [<action>]`). Every later write to the table fails with `Pend blocks held: 1/3 member(s) hold an unresolved rival action` or, after the collection sync's ten retries, `SyncRetryExhaustedError: … pending conflict: block(s) held by unresolved rival action(s) <action>`.

In the run below the record was still refusing writes 9 min 16 s after the last cancel round failed, when the run ended. Nothing indicates it would ever clear.

This is the class Optimystic already tracks as `backlog/debt-unpromotable-pending-records-need-a-sweep` ("the background cancel it fired off simply failed"). This instance adds two facts: the writer is still running and connected, so it is not the crashed-client case; and the record that stays is in the writer's own storage.

### Regression or latent?

Not established. 1.13.0 did not change the cancel path. Its prepared streams (#29) only changed how the Sereus scenario's fault injection behaved, which is how this path was first reached (see "How it was found"). Whether 1.12.1 strands the record the same way has not been run.

## Evidence

Run: `control-write-degraded-cohort-member.integration.ts`, full file, Sereus `c1e302d8` + linked Optimystic 1.13.0 (`8492061b`), with `DEBUG='optimystic:db-p2p:cluster*,optimystic:db-p2p:protocol-client*,optimystic:db-core:network-transactor*,optimystic:db-p2p:coordinator-repo*,sereus:cadre:control-db*'`. Peers: A = `12D3KooWLVHL…` (writer and pinned coordinator), B = `12D3KooWHz7G…`, C = `12D3KooWRW1z…` (silent). The write is A's background `[revocation-ledger-open]`, action `Spxt2Y33t2wfNe6vvDsH6g`, on Revocation block `8Z0Jn6ZB0ASMCGcl7PZ5ybUjYLdBqOJiDEscbtRSU9g`.

| Time (UTC) | Event |
|---|---|
| 02:00:11.531 | `pend actionId=Spxt2Y33…` |
| 02:00:11.534 | promise request to C goes out on `prepared=true`; C answers in 16 ms |
| 02:00:43.078 | `pend:done ms=31547`, `finalCommits: [A, B]`, `retry.pending: [C]` |
| 02:01:04.112 | one-round commit throws `2/3 approvals (needed 3, 0 rejections)` |
| 02:01:25.126 | tail commit fails the same way; `cancel actionId=Spxt2Y33… blockIds=2` |
| 02:01:46 / 02:02:07 / 02:02:28 | `cancel-error` × 3, each `2/3 approvals (needed 3, 0 rejections)` |
| 02:02:28.329 | Sereus: `Control write [revocation-ledger-open] failed non-transiently` |
| later | C restored at the end of its test case |
| 02:03:52 → 02:11:44 | 38 pend votes `heldBy: { A: 'Spxt2Y33…' }`; every Revocation write in the rest of the file fails on it, including the healthy "recovers" case (`peer-remove … Pend failed for collection default/cadrecontrol/Revocation: pending conflict: block(s) held by unresolved rival action(s) Spxt2Y33t2wfNe6vvDsH6g`) |

The same wedge appears in the release gate log of 2026-10-12 (`check-release.log`, rival `iiYkuFEivz2rQKdYHo8ZvQ`: it refused writes from 01:43 through the last case of the file, about ten minutes later). It appeared twice more, in two of three runs of an intermediate version of the scenario fix that aborted only C's end of those streams, so a write issued straight after the swap could still take the writer's end before C's reset reached it: in "does not queue a failed DELETE", A's `removePeer` (rivals `tx:YHjnoQKBh35AMbXpsz9QfZeDc7rvO43ELtDa0jmTFSw` and `tx:p2aweyJafrn-up1i3kLOU-uSnGiWhc6a8KQMyDseX9w`) took 148–150 s instead of 84 s, and the next case's write failed with `pending conflict: block(s) held by unresolved rival action(s)` naming it. That write is a multi-collection transaction, so the defect is not specific to one table.

## How it was found

The scenario degrades C by re-registering C's cluster protocol handler. Since 1.13.0 the writer keeps one negotiated stream per peer and protocol ready for its next request (`PreparedStreams`). A stream is dispatched to its handler when it is negotiated, so a stream prepared before the swap was still served by C's original handler: the first request after the swap, the pend's promise, was answered, and the write failed in its commit instead of its pend. The scenario now aborts, at both ends, every cluster stream opened to C before it swaps the handler, so every write it measures fails in the pend again and the file is green. The path that strands the record is therefore no longer exercised by any Sereus test.

## Proposed resolution (for the Optimystic maintainers to accept or edit)

The writer knows exactly which action it failed to cancel. Two candidate sites, either of which closes this instance:

- **Writer side:** a cancel that fails for want of a super-majority stays owed. The coordinator applies the cancel to its own storage at once (a cancel removes only its own action's pending records; `cancelling-a-refused-write-blocks-another-writers-commit` already established that a cancel conflicts with nothing), and keeps the cancel in the owed-delivery records it already carries to recovering members (`takeOwedRecords`), so B and C drop the record when they are next reached.
- **Member side:** the sweep `debt-unpromotable-pending-records-need-a-sweep` asks for, with an expiry derived from the pend message's `expiration`.

## What Sereus does when it lands

- Adopt the release.
- Add a case to `control-write-degraded-cohort-member.integration.ts` where C answers the pend and goes silent before the commit (degrade C's handler after its promise vote, for example by holding only streams whose first message is a commit). Assert that the write fails with the named shortfall and that a write to the same table commits after C is restored.
- Remove the paragraph about this ticket from that file's header.

## Upstream status

Fixed on optimystic main (`fix/4.6-a-cancel-that-misses-the-bar-strands-the-writers-pending-record`, ed98ef15; notes 20ed393f), not yet released. A cancel that misses the bar stays owed by the writer's transactor and is re-sent on a timer, and any new pend of the same blocks re-sends it first. New API: `NetworkTransactor.stop()`, called by `CollectionFactory.shutdown()`.

When adopting:

- Do not call `stop()` on the `dispose()` path in `compose-strand.ts` `releaseOptimysticPlugin` (an injected node kept across a rebuild). The old transactor's owed cancel is the only thing that clears a stuck pending record on live members. Its timer is unref'd, re-arms only while a cancel is owed, and holds at most 256 owed actions (`cancel:owed-evicted`). Keep `shutdown()` on the created-node path.
- If a cancel that never lands keeps an old transactor alive while the node runs, report it to Optimystic. The fix there is to hand the owed set to the next transactor or to give up after a deadline, not a Sereus `stop()` call.
- A writer that exits before its cancel lands is still `debt-unpromotable-pending-records-need-a-sweep`'s case.
