description: Re-ran the phone-to-PC private chat through a relay on the latest optimystic build (95fd269e). No errors on either side. A PC party running as a storage node is now much faster than in the previous run: it can write in 20 s instead of 40 s, and its idle reads take about half a second instead of 3 to 4 seconds. Messages from the phone reach the PC in 5 to 7 seconds when the phone sends alone and 5 to 17 seconds when both sides send at once.
files:
  - tickets/complete/rn-device-relay-rerun-after-poll-fix.md (the run compared against; same setup and script)
  - packages/integration-tests/src/harness/dedicated-relay.ts, node-fixtures.ts (reused by the PC-side script)
  - tickets/blocked/optimystic-strand-operations-cost-dozens-of-relay-round-trips.md (evidence below, not added there)
----

# Device run: relay chat on optimystic 95fd269e

Run by an agent driving the phone over adb, 2026-09-17 22:38–23:10 MDT. Repeats `rn-device-relay-rerun-after-poll-fix` after optimystic's day of fixes (dead-pend wedge, same-instant unique race, conflict rule, stale-read floors, browser/RN-safe plugin root).

## Setup

- Galaxy Note 9 (SM-N960U), Android 10, debug dev client `org.gotchoices.sereus.chat`. SDK adb. No adb hang.
- `stay_on_while_plugged_in` was **`0`** before the run. `svc power stayon usb` set it to `2` for the run. Restored with `svc power stayon false` and read back as `0`.
- Sereus `76cb6880`, clean. **Optimystic `95fd269e`** (`git log --oneline -1`: `95fd269e tickets: record the error-class identity fix`), clean working tree. HEAD moved to `3854b769` during the run through four ticket-only commits (no source or dist change). The dist of db-core (21:06) and db-p2p (21:07) is newer than their newest source (19:48, 20:41). quereus-plugin-optimystic dist (22:23) is newer than its source (22:19) and matches commit `98d6cf18` (22:23). cadre-core and quereus-plugin-sereus dist newer than source. The integration harness files the script uses (`dedicated-relay.ts` 09-10, `node-fixtures.ts` 09-16 17:41) predate its dist (09-16 18:20). Quereus `b972dc976` (another runner's uncommitted `tess` and `tickets/fix/` changes, no source edits), Fret `8f6bd03`. Nothing rebuilt. Metro reported no stale build.
- Metro `yarn start:frozen`. Android bundle fetched once from the PC via the manifest's `launchAsset.url`: 19.1 s, 34 MB, 4831 modules. Then `adb reverse tcp:8081`, deep link. Boot audit: `DOMException` polyfilled, no `✗` row, no MISSING warning.
- PC side: the same single-process script as the previous run (rebuilt from its description, placed in the git-ignored `packages/integration-tests/dist/`, deleted afterwards). It runs `startDedicatedRelay()` on loopback, then party B from `controlNodeConfig({ profile, enableRelay: false, listenAddrs: [], relayAddrs: [relay] })` + `requireSignedSchemas: false` + `makeOwnOwner`, then `formStrand` → `addStrand({ awaitFirstSync: false })` → `whenStrandWritable` → `Participant` insert → first message. It reads `App.Message` + `App.Participant` every 2 s with a guard so reads never overlap. It records every read's duration, logs reads over 3 s and every 15th read, and prints the distribution on `stats`. Errors are logged with `name`, `message`, `final`, `reason`, `attempts`, `staleAt` and the `cause` chain.
- Phone: Settings → party id `…000921` (round 1), `…000922` (round 2), `Strands 0` each time → relay address → Connect → **Create Closed Strand + Invite**. Invitation read from the modal with `uiautomator dump`.
- Round 1: PC party `storage`. Round 2: new relay, new party ids, new strand, PC party `transaction`.
- Only Metro and one PC party process ran from this session. 11 GB free of 31 GB at start.

## Results

Same definitions as the previous record. "Phone → PC" runs from the phone message's `Timestamp` to the PC poll that first returned it. "PC → phone" runs from the PC insert resolving to the first `uiautomator` dump that showed the message. Each dump takes 2–4 s, so these are upper bounds. The gap is the time between the two sides' sends. The phone's clock ran about 0.6 s behind the PC's.

| Step | Previous run, round 1 (`storage`, `c5540380`) | Previous run, round 2 (`transaction`) | This run, round 1 (`storage`) | This run, round 2 (`transaction`) |
|---|---|---|---|---|
| Phone node start | 4960 ms (`reserveRelays` 2033) | 3428 ms (639) | 5123 ms (`reserveRelays` 2081) | 3394 ms (615) |
| Create closed strand + invite | 9725 ms | 9933 ms | 9092 ms | 8409 ms |
| `formStrand` on PC | 2173 ms | 2113 ms | 2014 ms | 1927 ms |
| PC `addStrand` (not waiting) | 238 ms, `syncing` | 99 ms, `syncing` | 297 ms, `syncing` | 112 ms, `syncing` |
| Joiner `syncing` → writable | **40.3 s** | 17.4 s | **19.7 s** | 14.7 s |
| PC `Participant` / first message insert | 8.1 s / 7.7 s | 5.4 s / 5.9 s | 8.1 s / **52 ms** | 5.9 s / **14 ms** |
| PC → phone, first message | ≤14 s | ≤13 s | ≤27.6 s (watch started 15 s late) | not measured (tab tap missed) |
| Phone → PC, phone alone | 26, 9.5, 9.3, 14.6 s | 13.8, 11.2 s | **5.4, 6.1, 4.6 s** | **7.3, 6.1, 4.7 s** |
| PC → phone, PC alone (insert) | ≤1 s (9.2 s) | ≤6 s (4.7 s) | ≤3.0 s (5.4 s), arrived (5.4 s, row clipped, see below), ≤4.0 s (5.5 s) | ≤1.9 s (4.2 s), ≤2.7 s (5.2 s), ≤2.1 s (4.1 s) |
| Concurrent, phone → PC (gap) | 12.1 (7 s), 15.1 (6 s), **49.8 s (2 s)** | 12.0 (4 s), 6.7 s (5 s) | 4.9 (≈5 s), 7.2 (4.5 s), **15.1 (0.2 s)**, 9.1 s (3.9 s) | 5.0 (4.7 s), 8.4 (3.6 s), **16.7 (0.5 s)**, 10.9 s (1.2 s) |
| Concurrent, PC insert | 9.5, 9.3, **36.6 s** | 4.0, 4.6 s | 4.7, 5.4, 8.5, 6.9 s | 3.8, 4.5, **14.7**, 5.0 s |
| Concurrent, PC → phone | ≤10.5, ≤11.4, ≤13 s | ≤7, ≤15 s | ≤7.5, ≤6.1, ≤10.1, ≤3.9 s | ≤7.9, ≤5.5, not measured, ≤2.2 s |
| PC reads | 338 polls / 33 min: 218 over 3 s, 14 over 10 s, 5 over 30 s, max 42.4 s; idle 3–4 s | 75 polls / 3.5 min: 5 over 3 s, 2 over 10 s | 342 polls / 12.7 min: p50 541 ms, p90 1.4 s, p99 7.0 s; 70 over 1 s, **9 over 3 s, 3 over 10 s, 0 over 30 s, max 21.2 s**; idle 0.35–1.1 s | 300 polls / 11 min: p50 208 ms, p90 0.9 s, p99 7.4 s; 22 over 1 s, 9 over 3 s, 2 over 10 s, max 19.1 s; idle 0.17–0.28 s |

Where the slow reads fell. Round 1: the first two polls after joining (21.2 s, 14.6 s) and polls that overlapped a write (4.5–10.2 s, the 10.2 s one during the 0.2 s-gap pair). Round 2: the first two polls (19.1 s, 7.4 s) and polls during writes (3.7–14.4 s, the 14.4 s one during the 0.5 s-gap pair). In neither round did an idle read take over 3 s. The previous run's 18–42 s idle spikes did not occur.

Final state: the PC listed all 15 messages and 2 participants in both rounds (1 first message, 3 phone-alone, 3 PC-alone, 4 concurrent pairs). The phone showed every PC message checked for; its full list was not counted. Strand paths at the end: PC → relay `direct`, PC → phone `relayed`. The relay held 4 reservations in both rounds.

### Errors

**None**, on either side, in either round. No `TornActionError` (so no `final` value to report), no `SyncRetryExhaustedError`, no `Failed to get super-majority`, no `cohort-unreachable`, no `CoordinatorPartialCommitError`, no `BlockUnavailableError`, no failed read or insert, and no `strand:error` event. That covers 18 PC inserts (2 `Participant` + 16 messages) and 14 phone messages. Phone logcat after boot had only the known push-wake `FirebaseApp is not initialized` warning (once per Connect) and the Quereus/db-core `Require cycle` warnings at load.

## Verdict

- **The storage-profile joiner is now close to the transaction one.** Writable in 19.7 s (was 40.3 s), idle reads about 0.5 s (were 3–4 s every poll), no read over 30 s (were 5), and 9 reads over 3 s in 342 (were 218 in 338). The difference between profiles remains but is now small: idle reads about 0.45 s against 0.2 s, and first-message and alone-send times about the same.
- **Phone → PC halved.** 4.6–7.3 s alone in both rounds, against 9–26 s (storage) and 11–14 s (transaction) before.
- **Near-simultaneous writes are still the slow case**, with no errors. With a 0.2–0.5 s gap, phone → PC took 15–17 s, and the round-2 PC insert took 14.7 s with a 14.4 s read running at the same time. The previous run's worst case (49.8 s, and a 36.6 s insert at a 2 s gap) did not recur.
- The first message insert returns in 14–52 ms right after the `Participant` insert, which itself still takes 6–8 s.

## Repeated observations

- **Founding still runs the startup code twice, sometimes.** Round 1, which was the first strand founded in this app session, logged `resolveCohortSeed: start` twice, 119 ms apart (22:42:44.940 and 22:42:45.059). The two passes finished at 235 ms and 6154 ms, and `mergeStrandPeerAddrs: start` also appeared twice. Round 2 (after Disconnect and Connect) logged one pass. The previous run saw the opposite (one pass in round 1, two in round 2), and the run before that saw two. So it is intermittent and not tied to the first or second founding. Founding succeeded every time. Still not filed. The pattern fits the existing note that `startOrFoundStrand` runs twice for one strand id.
- **Send did not ignore taps this run.** All 14 phone sends took the first tap on Send, including five that landed while a PC insert was in progress (r1c3, r1c4, r2c2, r2c3, r2c4). The helper waited 2 s after typing before tapping, as the previous record advised, so the earlier misses were probably the typed text not yet in `draft`, not a busy JS thread. Not reproduced, so not filed.

## Evidence for `optimystic-strand-operations-cost-dozens-of-relay-round-trips`

Kept here, not added to the blocked ticket.

- On the phone relay path, optimystic `95fd269e` removes most of the storage-profile cost that the previous run measured. Unchanged reads went from 3–4 s to about 0.45 s, and time to writable halved. The profile still costs about twice the transaction profile per idle read.
- The remaining slow operations are the first reads after joining (15–21 s), the `Participant` insert (6–8 s, the joiner's first write), and near-simultaneous writes (8.5–14.7 s inserts, 15–17 s delivery).

## Driving notes

- In Git Bash, `adb shell uiautomator dump /sdcard/ui.xml` without `MSYS_NO_PATHCONV=1` writes to a mangled path (`/Files/Git/sdcard/ui.xml`), and a later `pull` returns a stale file from an earlier session. Set `MSYS_NO_PATHCONV=1` for every adb call, and delete the device file before each dump.
- With the keyboard up, the newest chat row can sit clipped at the list's bottom edge (`[32,1052][304,1063]`), so a text match on the dump misses it. The message had arrived. Dismiss the keyboard (`keyevent 4`) before watching for a message, or watch for a new `message-row-<id>`. A new row can also be the phone's own message, which is what happened for r2c3.
- A tap on the tab bar at `(810, 2030)` hits the keyboard when it is up, and typed a `.` into the chat input once. Dismiss the keyboard first.
- A tab tap right after closing a modal can be lost. Confirm the screen with a dump before starting a timer.

## Cleanup

Both PC party processes stopped via `quit` (`stopped` logged, relay stopped). Metro's Node process and the logcat capture were ended by PID, and nothing listens on 8081. The app was force-stopped. `adb reverse --remove-all` ran and `reverse --list` came back empty. `stay_on_while_plugged_in` reads `0`, as before the run. The temporary script was deleted.
