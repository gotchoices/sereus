description: Re-ran the phone-to-PC private chat through a relay after the fix that stops chat polls from piling up, and checked that the phone's startup check no longer flags a missing web API. The startup check is clean. Messages from the phone now reach the PC in 7 to 50 seconds, down from 1 to 4 minutes, with no errors. A PC party running as a storage node is still much slower than one running as a transaction node.
files:
  - packages/reference-app-rn/polyfills/hermes.js, polyfills/audit.js (check 1)
  - packages/reference-app-rn/src/use-chat.ts (poll guard on the phone)
  - packages/integration-tests/src/harness/dedicated-relay.ts, node-fixtures.ts (reused by the PC-side script)
  - tickets/complete/rn-cross-party-relay-run.md (the run compared against)
  - tickets/blocked/optimystic-strand-operations-cost-dozens-of-relay-round-trips.md (new evidence below, not added there)
----

# Device run: boot audit after the DOMException fix, relay chat after the poll fix

Run by an agent driving the phone over adb, 2026-09-17 08:52–09:36 MDT. Verifies `rn-boot-audit-reports-domexception-missing` and `0-rn-chat-poll-overlaps-slow-reads` on a device, and compares against `rn-cross-party-relay-run`.

## Setup

- Galaxy Note 9 (SM-N960U), Android 10, debug dev client `org.gotchoices.sereus.chat`. SDK adb (`platform-tools/adb.exe`). No adb hang this run.
- `stay_on_while_plugged_in` was `2` (USB) before the run. `svc power stayon usb` kept it at `2`. Restored with `settings put global stay_on_while_plugged_in 2` and read back as `2`.
- Sereus `82ea3dc`, clean. cadre-core, quereus-plugin-sereus and the integration harness `dist` are newer than their sources.
- **Optimystic `c5540380`**, the same HEAD at Metro start (08:52) and after the bundle was built (08:53). The working tree had another runner's uncommitted `package.json`/`yarn.lock` edits and no source edits. The `dist` of db-core (01:18), db-p2p (02:02) and quereus-plugin-optimystic (01:19) is newer than each package's last source commit. The phone's previous run used `7cd71341`. This build includes `a-write-whose-log-entry-landed-alone-is-reported-saved` (`3416d5a8`/`ab67fa47`) and `coordinator-refuses-blocks-it-is-not-responsible-for`.
- Quereus `561195502`, Fret `8f6bd03`. Nothing rebuilt.
- Metro: `yarn start:frozen`. Android bundle fetched once from the PC using the manifest's `launchAsset.url` (8.5 s, 34 MB, warm transform cache). It contains `inFlightRef` (the poll guard). Then `adb reverse tcp:8081 tcp:8081` and the deep link.
- PC side: one Node process, as in the previous run (a temporary script in the git-ignored `packages/integration-tests/dist/`, deleted afterwards). It starts `startDedicatedRelay()` on loopback, then party B from `controlNodeConfig({ profile, enableRelay: false, listenAddrs: [], relayAddrs: [relay] })` with `requireSignedSchemas: false` and `makeOwnOwner`. Then `formStrand` → `addStrand({ awaitFirstSync: false })` → `whenStrandWritable` → `Participant` insert → first message. After that it reads `App.Message` and `App.Participant` every 2 s. **Each tick returns at once if the previous read is still running** (a `polling` flag), so PC reads never overlap. It logs every read over 3 s and every 15th read. Send commands come from a file. A message counts as seen at the PC when the poll loop first returns it, and its lag is measured from the message's `Timestamp` (the sender's clock).
- The relay port was forwarded with `adb reverse`. Phone: Settings, then a new party id (`…000919` round 1, `…000920` round 2; `Strands 0` each time), the relay address, Connect, and **Create Closed Strand + Invite**. The invitation was read from the modal with `uiautomator dump`.
- Round 1: PC party `storage`, the same profile as last time. Round 2: everything restarted (new relay, new party ids, new strand), PC party `transaction`.
- Free RAM at start was 3.6 GB of 31 GB (other runners' Node processes). Only Metro and one PC party process ran.

## Check 1: boot audit

**Pass.** First boot of the run, 08:53:35:

native: `process.env`, `queueMicrotask`, `performance.now`, `EventTarget`, `WebSocket`, `AbortController`, `TextEncoder`, `crypto.getRandomValues`, **`AggregateError`**, `TextDecoder`, `ReadableStream`, `WritableStream`, `TransformStream`, `Symbol.asyncIterator`.
polyfilled: `setTimeout`, `crypto.subtle.digest`, `structuredClone`, `Promise.withResolvers`, `AbortSignal.prototype.throwIfAborted`, `AbortSignal.timeout`, `AbortSignal.any`, `WebSocket.prototype.bufferedAmount`, `CustomEvent`, `Intl.PluralRules`, `RTCPeerConnection`, **`DOMException`**.
gap: `crypto.subtle.importKey`, `crypto.subtle.encrypt`.
No `✗` row and no MISSING warning.

The review of that ticket left a `NOTE:` that the Babel-lowered class had been checked only in Node. On the device, through the inspector (`Runtime.evaluate`), all of the following held:

- `new DOMException('m','AbortError')` has `instanceof Error` and `instanceof DOMException` both `true`, `name` `AbortError`, `message` `m`, `code` `20`, `String()` `AbortError: m`, and `DOMException.name` `DOMException`.
- `AbortController().abort()` gives a reason with `name` `AbortError` that is `instanceof DOMException`.
- After it fires, `AbortSignal.timeout(1)` gives a reason with `name` `TimeoutError` that is `instanceof DOMException`.

The tripwire's condition (a wrong `instanceof` or `name`) did not occur.

## Check 2: cross-party relay chat

"Phone → PC" is the time from the phone's message `Timestamp` to the PC poll that first returned the message. "PC → phone" is the time from the PC insert resolving to the first `uiautomator` dump that showed the message. Each dump takes 1–4 s, so these are upper bounds. "Concurrent" means both sides sent within the gap shown.

| Step | Previous run, round 2 (`storage`, optimystic `7cd71341`) | Round 1 (`storage`) | Round 2 (`transaction`) |
|---|---|---|---|
| Phone node start | 4890 ms | 4960 ms (`reserveRelays` 2033 ms) | 3428 ms (`reserveRelays` 639 ms) |
| Create closed strand + invite | 9351 ms | 9725 ms | 9933 ms |
| `formStrand` (invite redeem) on PC | 2532 ms | 2173 ms | 2113 ms |
| PC `addStrand` (not waiting) | 140 ms, `syncing` | 238 ms, `syncing` | 99 ms, `syncing` |
| Joiner `syncing` → writable | 24.4 s | **40.3 s** | **17.4 s** |
| PC `Participant` / first message insert | 8.0 s / 8.8 s | 8.1 s / 7.7 s | 5.4 s / 5.9 s |
| PC → phone, first message | 10 s | ≤14 s (first check) | ≤13 s (first check) |
| Phone → PC, phone sending alone | **80 s** (59 s in round 1) | **26 s, 9.5 s, 9.3 s, 14.6 s** | **13.8 s, 11.2 s** |
| PC → phone, PC sending alone | 8 s | ≤1 s (insert 9.2 s) | ≤6 s (insert 4.7 s) |
| Concurrent, phone → PC | **163 s** (~260 s round 1) | 12.1 s (7 s gap), 15.1 s (6 s gap), **49.8 s (2 s gap)** | 12.0 s (4 s gap), 6.7 s (5 s gap) |
| Concurrent, PC insert | 6.5 s | 9.5 s, 9.3 s, **36.6 s** | 4.0 s, 4.6 s |
| Concurrent, PC → phone | not timed | ≤10.5 s, ≤11.4 s, ≤13 s | ≤7 s, ≤15 s |
| PC reads over 3 s | "some" took 18–24 s | 218 of 338 polls in 33 min; 14 over 10 s; 5 over 30 s (max 42.4 s) | 5 of 75 polls in 3.5 min; 2 over 10 s (20.0 s, 12.3 s, both in the first minute after joining) |

The 26 s phone → PC sample in round 1 was sent while a 38 s PC read was already running. The next read returned the message.

Final state, both rounds: the PC listed every message sent by either side (round 1: 14, round 2: 8) and 2 participants. The phone showed every PC message the run checked for, but its full list was not counted. `Connected · 1 strand(s) · 2 participant(s)`. The PC's strand node reached the phone's strand node `relayed`, and the relay held 4 reservations in both rounds.

**Errors: none.** No `TornActionError`, `Failed to get super-majority`, `cohort-unreachable`, `BlockUnavailableError` or failed insert in either round, on either side. There were 8 PC inserts (the `Participant` row and 7 messages) and 7 phone messages in round 1, and 5 PC and 4 phone inserts in round 2. The phone logged no JS lines after founding apart from the known push-wake `FirebaseApp is not initialized` warning, checked with `logcat -d` as well as the running capture. One PC read failed at the end of round 1: `Some peers did not complete: …1KzhLy[block:default/app/Participant](in-flight) cause=No response received`. That was the script calling `B.stop()` while a poll was still running, so the script caused it and it is not a finding.

### Verdict

- **The poll fix removed the growing delay.** Phone → PC went from 59–80 s alone and 163–260 s concurrent to 9–26 s alone and 12–50 s concurrent, with the PC party on the same `storage` profile. Idle PC reads stayed flat at 3–4 s for 33 minutes instead of growing. The phone and PC both poll with the guard now, and the phone also runs a newer optimystic build than last time, so this run cannot say how much of the change comes from each.
- **A `storage` joiner is still slow**, and the slowness is in optimystic, not in polling. Compared with `transaction`, it took 2.3× as long to become writable, its inserts took 1.5–2× as long (and 36.6 s once under concurrency), and 65% of its unchanged reads took over 3 s. The 42 s read spikes happened with no writes on either side (see below).

### Log excerpts (PC, UTC)

Round 1 (`storage`):

```
[14:56:33.744] formStrand ok in 2173 ms
[14:56:33.984] addStrand(awaitFirstSync:false) ok in 238 ms
[14:57:14.318] whenStrandWritable ok in 40333 ms
[14:58:24.606] read 38398 ms (1 msgs, 2 participants, poll #4)
[14:58:50.656] SEEN phone "r1-phone-" ts=2026-09-17T14:58:24.709 lag=25947 ms (read took 24324 ms)
[14:59:50.447] SEEN phone "r1phonethree" ts=2026-09-17T14:59:40.994 lag=9453 ms (read took 3905 ms)
[15:10:48.928] read 42389 ms (5 msgs, 2 participants, poll #148)
[15:11:26.547] read 35665 ms (5 msgs, 2 participants, poll #149)
[15:12:08.171] read 40984 ms (5 msgs, 2 participants, poll #150)
[15:27:10.998] SEND "r1e8-pc" ok in 36642 ms
[15:27:26.088] SEEN phone "r1e8phone" ts=2026-09-17T15:26:36.324 lag=49764 ms (read took 9698 ms)
[15:27:27.059] paths strand: ksUrNy:direct 1KzhLy:relayed; relay reservations=4
```

Round 2 (`transaction`):

```
[15:30:00.216] formStrand ok in 2113 ms
[15:30:17.722] whenStrandWritable ok in 17405 ms
[15:31:25.932] SEEN phone "r2phoneone" ts=2026-09-17T15:31:12.105 lag=13826 ms (read took 705 ms)
[15:32:47.182] SEND "r2d4-pc" ok in 4021 ms
[15:33:27.644] SEEN phone "r2e5phone" ts=2026-09-17T15:33:20.928 lag=6716 ms (read took 10 ms)
```

Phone: `[settings] create closed strand aaab091f succeeded in 9725 ms`, `… ec647a60 succeeded in 9933 ms`.

## Evidence for `optimystic-strand-operations-cost-dozens-of-relay-round-trips`

Kept here, not added to the blocked ticket.

- **Storage-profile commit failures did not reproduce on a device.** Optimystic `c5540380` includes `a-write-whose-log-entry-landed-alone-is-reported-saved`, so a refused commit would now raise instead of being retried. The run had 15 inserts with a `storage` joiner, including 3 concurrent pairs, and none failed. The blocked ticket's headless `TornActionError` and super-majority failures were not seen on this path. The worst insert took 36.6 s, when both sides wrote within 2 s.
- **Unchanged reads by a `storage` joiner cost 3–4 s each** over the phone relay path, every poll, for 33 minutes. A `transaction` joiner's reads on the same path mostly took under 1 s (as low as 10 ms). The blocked ticket measured 45–80 ms without added delay, headless, with `transaction` on both sides. This run shows the profile makes a large difference on a real device.
- **Read spikes of 18–42 s with no writes.** From 15:10:06 to 15:12:21, five consecutive storage-joiner reads took 17.7, 42.4, 35.7, 41.0 and 11.6 s, while neither side was sending. At 15:10:57 `uiautomator` crashed on the phone (two dumps from this harness overlapped), so extra load on the phone may have contributed. This is not established.
- **A `storage` joiner takes longer to become writable**: 40.3 s against 17.4 s for `transaction` (24–26 s in the previous run, older build).

## Found during the run

- **Not filed: Send taps missed while a commit crossed the link.** Three of the 11 phone sends needed another tap on Send (not counting one early miss caused by wrong coordinates). Each miss happened while the PC's insert was in progress. `app/index.tsx` disables Send while `draft` is empty. The likely cause is a busy JS thread that had not yet applied the typed text to `draft` when the tap landed, which would also mean the UI responds slowly while a relayed commit is running. That was not measured. The run's helper now taps until the input clears.
- **Not filed, repeat of the previous run: two `startOrFoundStrand` passes for one founding.** Round 2 (the second strand the app founded in this session, after Disconnect and Connect) logged `resolveCohortSeed: start` twice, 180 ms apart. The second pass's `strandManager.startStrand` returned in 0 ms. Round 1 logged one pass. Founding succeeded both times.
- **The previous run's "logcat capture stopped writing" was probably not a capture fault.** In this run the app logged nothing after founding, and `logcat -d` agreed with the running capture.
- Quereus `dist` logs three `Require cycle` warnings at boot (`runtime/emitters.js` ↔ `scalar-fusion.js`). They are not from sereus and were not investigated.

## Driving notes

- Keyboard up: chat input at `[21,1086][861,1187]`, Send at `(970, 1137)`. Keyboard down: input `(440, 1893)`, Send `(970, 1894)`. Tapping Send at the keyboard-down position while the keyboard is up hits a key. Locate both from a dump rather than hard-coding them.
- `adb shell input text` lands before React state catches up. Wait 1.5–2 s, then tap Send and confirm the input shows `Message…`.
- Never run two `uiautomator dump`s at once: the second crashes the automation service (`registerUiTestAutomationService`, `Bad file descriptor` in the crash buffer).
- `TaskStop` on `yarn start:frozen` leaves the `expo … start --dev-client` Node child listening on 8081. End it by PID.
- Clearing a Settings field: tap it, `keyevent 123` (move to end), then 60–120 × `keyevent 67`.

## Cleanup

The PC party and relay were stopped by the script's `quit` command (both rounds, `stopped` logged). The Metro Node process and the logcat capture were ended, and nothing listens on 8081. The app was force-stopped. `adb reverse --remove-all` ran and `reverse --list` came back empty. `stay_on_while_plugged_in` reads `2`, as before the run. The temporary script was deleted. `git status` shows only this file.
