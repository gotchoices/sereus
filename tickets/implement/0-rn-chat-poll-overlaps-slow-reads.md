description: The phone chat screen re-reads the message list every two seconds without waiting for the previous read to finish, so on a slow relayed connection reads stack up, each one slower than the last, until messages take minutes to appear on either side. The web app already waits; the phone app should too.
files:
  - packages/reference-app-rn/src/use-chat.ts (`refresh` and the polling `useEffect`)
  - packages/reference-app-web/src/lib/messages.svelte.ts (`refreshInFlight`, the guard to mirror)
  - packages/reference-app-rn/test/react/use-cadre.spec.ts, test/react/setup.ts (hook-test pattern to copy)
  - tickets/blocked/optimystic-strand-operations-cost-dozens-of-relay-round-trips.md (the per-read cost that makes overlap matter)
repro: verified
----

# Chat poll on the phone overlaps itself on a slow link

## What was measured

From the device run (`tickets/complete/rn-cross-party-relay-run.md`): phone writes reached the PC party 59–260 s late, PC reads took 18–24 s, and one PC insert took 237 s in the round whose PC poll loop could overlap itself.

Headless reproduction (2026-09-17, sereus `25a5010`, optimystic `ab67fa47` built): the `blind-relay-phone-to-phone-e2e` scenario modified to use the chat schema (`Participant` + `Message` with its foreign key), party A on `profile: 'transaction'`, and A's relay connection passed through a TCP proxy that delays every chunk 150 ms each way. Both sides ran the app's poll: every 2 s, `select … from App.Message order by Timestamp, Id` and `select Id from App.Participant` in parallel.

| Poll shape | Result |
|---|---|
| No added delay, overlapping allowed | every message seen on the next poll (≤ 2 s) |
| 150 ms, overlapping allowed (what `use-chat.ts` does) | read times grew steadily on **both** sides: 5.7 s → 17 s → 60 s (at ~100 s) → 170 s (at ~260 s). A→B commit 15.5 s; the next B→A message was not seen within 400 s and the run failed |
| 150 ms, skip a tick while a read is in flight | reads 2–33 s, commits 6–45 s, every message arrived (worst 28 s after commit); no growth over 4 minutes |

Each strand read is not local: a live read refreshes each table's tree over the network (measured 2–9 block requests per read, see the blocked ticket above). When the read takes longer than the 2 s interval, `setInterval` starts another one anyway. Each queued read adds requests over the same relayed connection, which slows the reads already running and also every commit and every request from the other party that needs an answer from this phone. That is why the slowdown shows on both sides, not just the phone.

The device run's PC script had the same unguarded loop in round 1 (the 237 s insert) and a guarded loop in round 2 (insert 6.5 s). The phone ran the unguarded `use-chat.ts` loop in both rounds.

## What to change

`useChat`'s `refresh` must not start a read while one for the same strand is still running. Mirror `reference-app-web/src/lib/messages.svelte.ts` (`refreshInFlight`), with one difference: the hook switches strands, so key the guard on the strand. A read still running for strand X must not suppress the first read for strand Y, or the new conversation stays empty until the next tick. A ref holding the in-flight strand (or a per-strand-id set) is enough. `refresh` is also returned to callers, and they get the same guard.

Out of scope: the poll interval, and replacing polling with change notification. Both are separate decisions.

## Confirmation beyond unit tests

This fix alone does not make relayed chat fast. On the measured shape a guarded read still costs seconds, and that part belongs to optimystic (blocked ticket above). What it should remove is the growth over time: minutes-late delivery and reads that keep getting slower. A device re-run of `rn-cross-party-relay-run` needs a human with the phone. Put that in the review handoff; don't claim it.

## TODO

- Add a single-flight guard to `refresh` in `packages/reference-app-rn/src/use-chat.ts`, keyed on the strand, and release it in `finally`.
- Add `packages/reference-app-rn/test/react/use-chat.spec.ts` (copy the `react-test-renderer` + `vi.mock` pattern from `use-cadre.spec.ts`; mock `chat-operations` so `queryMessages` returns a promise the test controls). Cover:
  - fake timers advanced past several poll intervals while the first read is unresolved → `queryMessages` called once;
  - after it resolves, the next tick reads again;
  - a strand switch while strand X's read is in flight → strand Y's first read starts immediately, and X's late result is not applied (the existing `strandRef.current !== s` check).
- Run `yarn workspace @serfab/reference-app-rn test` and `yarn lint`.
- Handoff: say a device re-run is still needed to confirm the latency effect.
