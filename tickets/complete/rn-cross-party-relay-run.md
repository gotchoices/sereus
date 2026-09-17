description: Re-ran the phone-to-PC private chat through a relay after the joining-machine fix. Messages now reach both sides in both directions and the "cohort-unreachable" error is gone. Messages from the phone reach the PC party one to four minutes late, filed as a fix ticket.
files:
  - tickets/fix/cross-party-relay-phone-writes-reach-the-joiner-minutes-late.md
  - packages/integration-tests/src/harness/dedicated-relay.ts, node-fixtures.ts (reused by the PC-side script)
  - packages/reference-app-rn/src/chat-strand.ts, src/use-cadre.ts (flows driven)
----

# Device run: cross-party closed strand through a relay, after the first-sync gate

Run by an agent driving the phone over adb, 2026-09-16 23:01–23:23 MDT. Verifies
`3.1-joining-machine-writes-before-first-sync-fork-tables` and
`3-strand-app-table-names-collide-with-strand-tables` against the failure recorded in
`fix/3-cross-party-strand-messages-do-not-converge` (commit `570b9b7`).

## Setup

- Galaxy Note 9 (SM-N960U), Android 10, debug dev client. `stay_on_while_plugged_in` was `0`; set
  `svc power stayon usb` for the run.
- Sereus `f2d4c1a`, clean. cadre-core and quereus-plugin-sereus `dist` newer than `src`. Optimystic
  `7cd71341` with another runner's uncommitted `db-core` edits (HEAD moved to `3416d5a8` during the
  run; Metro was frozen, so the phone ran what Metro read at 23:01). Quereus `ff1c619c6` with
  uncommitted `schema-differ.ts` edits. Nothing rebuilt.
- Metro: `yarn start:frozen`; Android bundle fetched once from the PC first (52 s, 35 MB); then
  `adb reverse tcp:8081`, deep link.
- PC side: one Node process (a scratch script placed temporarily in the git-ignored
  `packages/integration-tests/dist/` so workspace imports resolve, deleted afterwards):
  `startDedicatedRelay()` from the integration harness on loopback, plus party B built with
  `controlNodeConfig({ profile: 'storage', enableRelay: false, listenAddrs: [], relayAddrs: [relay] })`,
  `requireSignedSchemas: false`, `makeOwnOwner`. It waited for the invitation in a file, then ran
  `formStrand` → `addStrand({ awaitFirstSync: false })` → `whenStrandWritable` → inserted its
  `Participant` row and a message, then polled `App.Message`/`App.Participant` every 2 s and took
  send commands from a file. The chat sApp config and schema are copied from `src/chat-strand.ts`.
- The relay's ephemeral port was forwarded with `adb reverse tcp:<port> tcp:<port>`, so the phone
  and party B both dial `/ip4/127.0.0.1/tcp/<port>/ws/p2p/<relay>`.
- Phone: Settings → fixed party id (`…000917` round 1, `…000918` round 2, so no strands from earlier
  runs were attached; Strands read `0`), Relay field → Connect → **Create Closed Strand + Invite**.
  The invitation was read from the modal with `uiautomator dump`.

Two rounds. Round 2 restarted everything (new relay, new party ids, new strand) because round 1's PC
poll loop could overlap itself (a `setInterval` with no guard), which could distort PC timings.

## Results

| Step | Round 1 | Round 2 |
|---|---|---|
| Phone node start | 4949 ms, `Reachable: Yes — via relay` | 4890 ms, same |
| Create closed strand + invite | 9572 ms | 9351 ms |
| `formStrand` on PC through the relay | 2330 ms | 2532 ms |
| PC `addStrand` (not waiting) | 289 ms, status `syncing` | 140 ms, `syncing` |
| `strand:writable` on PC | 25.7 s after `addStrand`, `active` | 24.4 s, `active` |
| PC `Participant` insert / first message insert | 9.0 s / 16.1 s | 8.0 s / 8.8 s |
| PC → phone, first message | visible on the phone at the first check, ≤24 s after commit | 10 s after commit |
| Phone → PC, phone sending alone | **59 s** | **80 s** |
| PC → phone, PC sending alone | — | 8 s after commit (commit 8.6 s) |
| Both send within 3 s: phone → PC | **~260 s** | **163 s** |
| Both send within 3 s: PC insert | **236 776 ms** (overlapping poll, see above) | 6.5 s |
| Both send within 3 s: PC → phone | 16 s after commit | arrived; not timed (first checked 2.5 min later) |

Final state, both rounds: both sides list the same messages in the same order (round 2: 5 messages,
3 from the PC and 2 from the phone, plus the first one) and 2 participants. The chat banner read
`Connected · 1 strand(s) · 2 participant(s)`.

Every strand and control connection between the two parties was `relayed`
(`control[…rwAm2B:relayed] strand[…Ehf2TA:relayed]`); the relay held 4 reservations.

**Errors:** none. No `cohort-unreachable`, `BlockUnavailableError`, `StrandAwaitingFirstSyncError`,
failed insert or failed read in the PC log, and none in the phone's logcat apart from the known
push-wake `FirebaseApp is not initialized` warning. The PC read back its own first message on its
first poll.

### Verdict against the original failure

| Original symptom | Now |
|---|---|
| Joiner could not read its own insert | Reads it back on the first poll |
| `Block default/Message is unavailable (cohort-unreachable)` | Not seen |
| Phone messages never reached the joiner | Arrive, 59–260 s late |
| Joiner messages never reached the phone | Arrive in about 10 s |

### Log excerpts (PC, round 2, UTC)

```
[05:16:57.481] formStrand ok in 2532 ms strand=3148bd58-7caa-4d3c-b93f-4d13d832c867
[05:16:57.621] addStrand resolved in 140 ms status=syncing
[05:17:21.910] event strand:writable {"strandId":"3148bd58-7caa-4d3c-b93f-4d13d832c867"}
[05:17:38.712] SEND ok "hello from PC party B #1" in 8751 ms
[05:18:08.151] slow read 23667 ms
[05:18:32.022] slow read 18008 ms
[05:19:19.090] READ … '2026-09-17T05:17:59.039 KprwAm2B: r2-phone-1'
[05:20:09.533] SEND ok "r2-pc-3" in 6539 ms
[05:22:43.946] READ … '05:20:00.132 KprwAm2B: r2-phone-3', '05:20:02.994 t4NavphH: r2-pc-3'
```

Phone: `[settings] create closed strand 3148bd58 succeeded in 9351 ms`.

## Found during the run

- **Filed `fix/cross-party-relay-phone-writes-reach-the-joiner-minutes-late`.** Messages converge,
  but the phone's writes reach the PC party in 1–4 minutes while the PC's reach the phone in about
  10 s, and some PC reads took 18–24 s.
- **Not filed: founder shown as `member` once.** Round 1, the phone founded the strand but its
  `Participant` row read `member` on both sides; round 2 it read `owner`. `createClosedChatStrand`
  inserts `owner` with `insert or ignore` and `useChat` inserts the default `member` the same way, so
  whichever lands first wins. That contradicts the comment on `assignLocalParticipantRole` ("an
  earlier role assignment wins"). Seen once in two rounds and affects only the displayed role;
  recorded here for whoever next touches the role write.
- **The found-strand timing lines interleave two `startOrFoundStrand` runs** for the same strand id
  on the phone (two `resolveCohortSeed: start` 170 ms apart, 23:06:39). Founding still succeeded.
  Not investigated.

## Driving notes

- `ui.sh`-style helper: `uiautomator dump` + `adb pull` to a Windows path with
  `MSYS_NO_PATHCONV=1`. In Git Bash, `"$W\\$1.xml"` inside a quoted heredoc saved the file literally
  as `scratchpad$1.xml`; use `/`.
- With the keyboard up, `keyevent 111` did not close it; `keyevent 4` did, after which Connect was at
  (540, 1292). Create Closed Strand + Invite is at (540, 1494) after two upward swipes; the modal's
  OK at (540, 1443). Chat input (440, 1893), Send (970, 1894).
- Importing workspace packages from a script outside the repo fails (`ERR_PACKAGE_PATH_NOT_EXPORTED`
  via `createRequire`); run it from inside a package's ignored `dist/` instead.
- The logcat capture stopped writing at 23:16 although the app kept working.
- **Cleanup and adb.** Metro, the PC party/relay process and the logcat capture were stopped; the
  app force-stopped; `adb reverse --remove-all` ran and `reverse --list` came back empty;
  `svc power stayon false` was sent. The following `settings get global stay_on_while_plugged_in`
  hung, and every later adb command timed out. The adb server on 5037 (PID 7588, started 22:58,
  no visible executable path) could not be stopped from this session (`Access is denied`), and a
  second server on another port did not see the phone. So the stay-awake restore was sent but not
  read back. If the phone stays awake on USB, run `adb shell svc power stayon false` after ending
  PID 7588 from an elevated prompt.
