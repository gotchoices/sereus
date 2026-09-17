description: The phone chat screens re-read the message list every two seconds without waiting for the previous read to finish, so on a slow relayed connection reads piled up and messages arrived minutes late. Both phone apps now skip a poll while a read of the same conversation is still running, the way the web app already did.
files:
  - packages/reference-app-rn/src/use-chat.ts (`inFlightRef`, `refresh`)
  - packages/reference-app-rn/test/react/use-chat.spec.ts (new)
  - packages/reference-app-rn/vitest.config.ts (react project comment only)
  - packages/reference-app-ns/src/chat-vm.ts (`readsInFlight`, `refresh`)
  - tickets/backlog/debt-ns-chat-vm-unit-tests.md (added a coverage arm)
  - packages/reference-app-web/src/lib/messages.svelte.ts (`refreshInFlight`, reference only — unchanged)
----

# Chat poll no longer overlaps itself on a slow link

## Background

Each strand read refreshes every table's tree over the network (2–9 block requests per read, see `tickets/blocked/optimystic-strand-operations-cost-dozens-of-relay-round-trips.md`). When a read took longer than the 2 s poll interval, `setInterval` started another one anyway. On a relayed link with 150 ms added delay each way, a headless run showed read times growing on both parties (5.7 s → 170 s over ~260 s) until a message was not seen within 400 s. The same run with a skip-while-in-flight poll stayed at 2–33 s reads with no growth over 4 minutes. The numbers come from the implement ticket's measurement; this ticket did not re-measure them.

## What changed

**`reference-app-rn/src/use-chat.ts`**: `refresh` keeps a `Set<StrandInstance>` of strands with a read running (`inFlightRef`). If the current strand is already in the set, `refresh` returns at once; otherwise it adds the strand and removes it in `finally`. The key is the strand *instance*, the same identity the existing stale-result check (`strandRef.current !== s`) uses. So:

- poll ticks, and callers of the returned `refresh` (`app/index.tsx` calls it after a failed send), are skipped while that strand's read runs;
- after a strand switch, the new strand's first read starts immediately even if the old strand's read is still running, and the old result is still dropped by the stale check;
- switching back to a strand whose original read is still running starts no second read, and that read's result is applied because the strand is active again. A single "current in-flight strand" ref would have started a duplicate read in that case, which is why this uses a set.

**`reference-app-ns/src/chat-vm.ts`** (outside the ticket's stated file list): the NativeScript port of the same hook had the identical unguarded `setInterval` loop. I applied the same guard (`readsInFlight`). It has **no unit test**: that package's tests cannot load `chat-vm.ts` yet because `ObservableArray` fails to import under Node (`debt-ns-chat-vm-unit-tests`). I added an arm to that backlog ticket to cover the guard once the import works. It passes typecheck; nothing ran it.

## Tests

`packages/reference-app-rn/test/react/use-chat.spec.ts` mounts the real hook with `react-test-renderer`, mocks `chat-operations`, and makes each `queryMessages` call return a promise the test settles by hand, with fake timers:

- five poll intervals plus an explicit `refresh()` while the first read is unresolved → one `queryMessages` call; after it resolves, the rows are applied, `loading` goes false, and the next tick reads again;
- a rejected read sets `error` and releases the guard (the next tick reads);
- a switch from strand X to Y while X's read is running → Y's read starts right away, Y's ticks are skipped while Y's read runs, X's late rows are not applied (`loading` stays true), and Y's rows are;
- X → Y → back to X while X's read is running → no second X read; X's original result is applied; the next tick reads X again.

With the `has(s)` check temporarily removed, three of the four tests fail. The error-release test passes either way, since it only fails if the `finally` removal is missing.

Validation run:

- `yarn workspace @serfab/reference-app-rn test`: 21 files, 311 tests passed.
- `yarn workspace @serfab/reference-app-rn typecheck` and `yarn workspace @serfab/reference-app-ns typecheck`: clean.
- `yarn lint`: clean.
- `yarn workspace @serfab/reference-app-ns test`: 2 failures in `test/cadre-vm.spec.ts`, which this change does not touch. Commit `0fe8a79` added a `strand:writable` subscription to `cadre-vm.ts` and left two assertions that list the subscribed events unchanged. Written up in `tickets/.pre-existing-error.md` for triage.

## Known gaps for the reviewer

- **Not confirmed on a device.** This should stop reads and delivery from slowing down more and more over time. It does not make a single relayed read fast; that cost belongs to optimystic (blocked ticket above). Confirming the latency effect needs a human with the phone to re-run `rn-cross-party-relay-run` (phone ↔ PC party through the relay) and compare delivery times with the numbers recorded in `tickets/complete/rn-cross-party-relay-run.md` (phone writes 59–260 s late at the PC).
- **A read that never settles now stops polling for that strand.** Before, later polls kept starting (and piling up). Now, if `queryMessages`/`queryParticipants` never resolves or rejects, no further read of that strand starts until the strand instance changes. The web app's `refreshInFlight` has the same property. I did not check whether optimystic bounds these reads with a timeout. If it does not, this is worth a look.
- **Optimistic send can briefly disappear. This predates the change.** `send` appends the new message locally. A read that started before the insert and finishes after it replaces the list without that message until the next read. Overlapping polls could do the same. The guard may keep that window open slightly longer, because the next read waits for the running one to finish. Not changed here.
- The NS guard is untested (see above).

## Review findings

Read the implement diff (`0fb74cd`) before the handoff, plus the whole of `use-chat.ts`, the NativeScript `chat-vm.ts`, and the web app's `messages.svelte.ts` that the guard copies.

- **Correctness of the RN guard:** checked. Keying on the strand instance is right: the check comes after the `database` gate, so a joiner whose instance becomes writable is not blocked by an earlier no-op call, and the stale-result check still drops rows from a strand you have switched away from. The four tests cover skipped ticks, release after an error, switching strands, and switching back. No gaps worth adding for this change.
- **NativeScript participant registration overlapped the same way (fixed inline):** `attach()` runs on every poll while the participant is not registered, and it started a new `insertParticipant` commit each time, even with the previous one still running. On a slow relayed link, a joiner would stack up commits every 2 s, which is the same overlap this ticket removes for reads. Moved the insert into `register()` with a `registeringStrand` guard. It also sets `registered` only if that strand is still attached. There is no test yet because the `ObservableArray` import still fails under Node, so I added a coverage arm to `debt-ns-chat-vm-unit-tests`. RN does not have this problem: registration runs in an effect that only re-runs when its dependencies change.
- **A read that never settles stops polling for that strand (tripwire):** optimystic has dial timeouts (`protocol-client.ts`), but I did not confirm that every read path is bounded. Recorded as a `NOTE:` next to `inFlightRef` in `use-chat.ts`. The web app's `refreshInFlight` has the same property.
- **NativeScript has no stale-result check:** this predates the change. `ChatViewModel.refresh` applies rows even if the attached strand changed while the read ran. In NativeScript that only happens when a reconnect creates a new instance of the same strand (`getFirstStrand`), so the rows are from the same conversation and the next poll replaces them. Not filed.
- **Optimistic send can be overwritten by a read already in flight:** this predates the change (see the handoff). The guard does not make it worse in any way I could measure. Not filed.
- **Handoff accuracy:** the `files:` header listed the web app's `messages.svelte.ts` as "the guard mirrored", but that file was not changed. It is only the reference the guard copies. I corrected the header. The NativeScript test failure listed in `.pre-existing-error.md` has since been triaged, and the NativeScript suite now passes.
- **Docs:** none describe the chat poll's timing, so nothing needed updating. The `vitest.config.ts` comment was updated by implement and is accurate.
- **Hygiene, types, cleanup:** the guard adds no `any`. `finally` releases the guard on success and on error, and the timer cleanup is unchanged. The new spec is 184 lines and its helpers are small.

Validation after the review edits: `yarn lint` passed. `typecheck` passed for reference-app-rn and reference-app-ns. `yarn workspace @serfab/reference-app-rn test` passed 311/311, and `yarn workspace @serfab/reference-app-ns test` passed 110/110.

Still open and needs a human: confirming the delivery latency on a device, by re-running the phone ↔ PC relay check.
