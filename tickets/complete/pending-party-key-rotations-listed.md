description: A membership key replacement that waits on another party, or on an owner device that is not running, leaves a pending record behind. Apps can now list these waiting replacements, with who can move each one forward and which key to name.
prereq: party-key-rotation-redeems-an-invitation-under-the-pending-key
architecture: docs/architecture.md#removing-a-machine
files: packages/cadre-core/src/control-database.ts (`queryPendingStrandPartyKeys`, `PENDING_PARTY_KEY_COLUMNS`), packages/cadre-core/src/cadre-node.ts (`listPendingPartyKeyRotations`, `pendingRotationStrandState`, `closedStrandState`, `heldStrandRows`), packages/cadre-core/src/machine-removal.ts (`pendingRotationWaitingOn`, `PendingRotationStrandState`), packages/cadre-core/src/types.ts (`PendingPartyKeyRotation`), packages/cadre-core/test/cadre-node-remove-machine.spec.ts, docs/architecture.md (Removing a machine), docs/strands.md (Replacing the party's key)
----
# Listing the party key replacements still pending

A `PendingStrandPartyKey` row outlives the `removeMachine` call that wrote it whenever the replacement cannot finish on the removing machine. `MachineRemovalResult.strands` reports that once, to the caller. `CadreNode.listPendingPartyKeyRotations(): Promise<PendingPartyKeyRotation[]>` is the durable read an app shows until the swap.

```ts
interface PendingPartyKeyRotation {
  strandId: string;
  publicKey: string;     // what another party's manager admits by hand
  superseded: string[];  // earlier pending keys this one replaced, public halves
  waitingOn: 'another-party' | 'sealed' | 'owner-machine';
}
```

- **Which rows.** Every live row (retired stamps hidden, through `ControlDatabase.queryPendingStrandPartyKeys()`) whose strand has a `Strand` or `JoinedStrand` row here. A machine removed from the cadre gets `[]`; a stopped node throws.
- **`waitingOn`.** The pure `pendingRotationWaitingOn` in `machine-removal.ts`. A seated key wins over `sealed`: members can still leave a sealed strand, so the driver finishes there. Anything unreadable answers `owner-machine`.
- **No new event and no withdrawal.** An app reads the list with its machines list, after its own `removeMachine`, and on `strand:party-key-rotation-blocked` and `strand:party-key-rotated`.

The reference apps' use of this is `reference-apps-show-pending-party-key-rotations`. The real-network proof is `scenario-party-key-rotation-across-parties`.

## Review findings

### Validation

The implement handoff could not run vitest because `../quereus` had a stale build. This review got the runs it owed:

| Run | Engine | Result |
|---|---|---|
| Full `@serfab/cadre-core` suite, final source (01:28) | linked siblings | 195 of 195 files, 2617 passed, 1 skipped |
| Full suite with the temporary real-read assertion (01:25) | linked siblings | 194 of 195 files; `cadre-node-remove-machine` passed with the assertion; 1 failure elsewhere (below) |
| Full suite, final source, with the assertion and the probes below | registry copies, `@quereus/quereus` 4.25.0, `@optimystic/*` 1.25.0 | 195 of 195 files, 2620 passed, 1 skipped |
| `yarn workspace @serfab/cadre-core typecheck`, `yarn lint`, `yarn check:test-file-typecheck-coverage` | | all exit 0 |

- **The guard changed state during this review.** It refused at first, passed, refused again and passed again, as Quereus was rebuilt and edited by its own agent. Nothing in `../quereus` or `../optimystic` was built or written from here. The registry runs used `yarn check:published --skip-gates --keep`, a scratch worktree at `HEAD` with no sibling links, now removed (links unlinked first; `git worktree list` shows only the main tree).
- **The linked runs used an in-progress Quereus.** `../quereus` had uncommitted edits in `planner/analysis/change-scope.ts` and `types/comparison-coercion.ts`, covered by a 01:16 build the guard accepted. The registry runs are the check against released code.
- **The real read has now run against a database, on both engines.** `listPendingPartyKeyRotations()` returned the expected entry after the spec's second removal, and `[]` before any removal (registry run). The temporary lines are gone: the spec has no diff from `HEAD`. This confirms the new SQL, the stamp filter on a replaced row, and the held-strand filter's positive side.
- **Not run:** integration scenarios, since the listing has no caller there yet and `scenario-party-key-rotation-across-parties` is what asserts it on a real network. The `another-party` and `sealed` answers through `CadreNode` itself are still unexercised, because the spec's strand does not run on the node. The probes below cover the function over real strand reads, not the method end to end. The branches filtering a retired stamp with its row still present, and a left joined strand, were checked by reading only.

### The implementer's flagged call: confirmed

A seated key beating `sealed` is correct. A temporary probe on a real strand engine (registry run, since removed) sealed a strand another party hosted:

- New key admitted before the seal: `waitingOn` answers `owner-machine`, and the real driver reports `rotated`, with the old key gone and every remaining machine bound under the new key.
- New key not admitted: `waitingOn` answers `sealed`, and the driver reports `needs-another-party`.
- Not sealed: `another-party`, then `owner-machine` once the host admits the key.

### Fixed in this pass

- **Wrong documentation of a public type.** The `PendingPartyKeyRotation.waitingOn` comment said `owner-machine` covers "this machine holds no owner key". The function never looks at that: a non-owner machine with the strand live and no seat answers `another-party`, which is what the reference apps' ticket expects. It also left out the manager-seat case and the "not a member" condition on the other two states. Rewritten to match the function and `docs/architecture.md`.
- **Undocumented disagreement on a sealed strand.** The removal's result says `needs-another-party` where the listing says `sealed`, because the result has no sealed outcome. Stated in `docs/architecture.md`, and added to `reference-apps-show-pending-party-key-rotations`, whose edge case claimed the two always agree after the removal returns.
- **Duplicated read.** The "own plus joined strands" read appeared twice in `cadre-node.ts`; both now use `heldStrandRows`.

### Tripwires

- **A row nobody can open still lists as actionable.** `waitingOn` ignores who the key is sealed to. After the recovery in `docs/strands.md` ("The old key when the party cannot leave"), it answers `owner-machine`, then `another-party`, though no machine can finish it. This also covers the handoff's "held strand with no `StrandPartyKey` row" limit, which is that recovery's middle step. Parked as a `NOTE:` on `listPendingPartyKeyRotations`.

### Checked, nothing to change

- **Local view:** a seat or seal not yet replicated can briefly show as `another-party`, and so can a machine that has just launched the strand. `docs/architecture.md` says the answer is judged from this machine's view; it corrects on the next read.
- **Raw held-strand reads:** `queryStrands` and `queryJoinedStrands` apply no retired-stamp filter, the same as the removal plan's read, so the two agree.
- **Secrets:** the result carries public columns only; `sealedKey` and `stampId` do not leave the method.
- **Error handling:** a failed strand read logs and answers `unknown`, so one strand does not lose the rest of the list. A failed control database read throws, as `listMachines` does.
- **Performance:** one party-key read and up to three strand scans per pending row, in series. I did not measure it; pending rows only exist for strands mid-replacement, so the count is expected to be small.
- **Resource cleanup:** nothing is held open; no listener or timer was added.
- **Exports:** `PendingPartyKeyRotation` reaches `index.ts` through `export *`. `pendingRotationWaitingOn` stays internal, like `planMachineRemoval`.
- **Tests:** the six-row `pendingRotationWaitingOn` table stays, as it pins the specified precedence on real branching. No test was added: the method's real read belongs to the downstream scenario, as the ticket specifies, and the fixes above are comments, docs and a helper.
- **Docs:** `docs/architecture.md` and `docs/strands.md` were read against the code. `docs/reference-app-rn.md` and the web README belong to the reference apps' ticket.
- **File size:** this adds about 70 lines to `cadre-node.ts` (12,211 lines by `wc -l`), already tracked by `debt-cadre-node-single-file-size`.

### Failure outside this ticket

`strand-instance-manager.spec.ts`, `should allow a retry after a failed launch to reach active`, failed once under the full suite on the linked engine, and passed in every other run: three runs of the file alone and the next full suite on the linked engine, and one run of the file alone and two full suites on registry copies. This diff does not touch that code. The error's received value was lost because the output was cut with `tail`, so the cause is unknown. Reported in `tickets/.pre-existing-error.md`.

### No new tickets

Nothing here passed the filing bar: the only remaining concern is conditional, and is the `NOTE:` above.
