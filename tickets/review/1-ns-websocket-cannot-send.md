description: Fixed the NativeScript reference app so it can actually send data over a WebSocket connection to another machine, mirroring a fix already shipped for the React Native app.
files:
  - packages/reference-app-ns/src/polyfills/hermes.ts
  - packages/reference-app-ns/app/app.ts
  - packages/reference-app-ns/src/polyfills/index.ts
  - packages/reference-app-ns/src/polyfills/abort.ts
  - packages/reference-app-ns/src/polyfills/audit.ts
  - docs/reference-app-ns.md
----

# NativeScript WebSocket bufferedAmount shim + AbortSignal.any listener leak — implemented

Source ticket: `tickets/implement/1-ns-websocket-cannot-send.md` (deleted; this
supersedes it). Original diagnosis confirmed by source inspection, not a device
run — see "What's NOT verified" below, which still applies after this work.

## What changed

**`@valor/nativescript-websockets` declares `bufferedAmount?: number` on its
`WebSocket` class but never assigns it** (confirmed: the name appears only in
`websocket.d.ts`, nowhere in the package's `.js`). `@libp2p/websockets`'
`websocket-to-conn.js` gates every send on `websocket.bufferedAmount <
maxBufferedAmount`; against `undefined` that's always `false`, so it stops
sending, then polls for `bufferedAmount === 0`, which never happens. The socket
opens, the handshake is never written, and the dial dies on libp2p's 10 s
timeout — this is the same defect fixed for React Native in commit `7a0fd6c`
(2026-09-16).

1. **`src/polyfills/hermes.ts`** — added `patchWebSocketBufferedAmount()`, a
   `WebSocket.prototype.bufferedAmount` getter returning `0`, guarded on the
   property being absent and calling `markPolyfilled`.
2. **Ordering fix not in the original ticket's file list — read this
   carefully.** `hermes.ts` (via the `src/polyfills` barrel) is imported in
   `app.ts` *before* `@valor/nativescript-websockets`, which is what actually
   assigns `globalThis.WebSocket` (its `index.js` is just `global.WebSocket =
   WebSocket`). A module-scope guard in `hermes.ts` — the pattern every other
   patch in that file uses, and what the ticket's TODO literally asked for —
   would run while `globalThis.WebSocket` is still `undefined` and silently
   no-op, reproducing the exact bug this ticket exists to fix. So the shim is
   exported as a function instead of applied at import time, and **`app/app.ts`
   now calls `patchWebSocketBufferedAmount()` right after the
   `@valor/nativescript-websockets` import**, before `runPolyfillAudit()`.
   `src/polyfills/index.ts`'s barrel doc-comment now notes the exception.
   **Please double check this reasoning** — it's the one place I deviated from
   the ticket's stated file list, and it's easy to verify: revert `app.ts`'s
   added call and watch the `WebSocket.prototype.bufferedAmount` audit probe
   (see below) report `MISSING` instead of `∙ polyfilled`.
3. **`src/polyfills/audit.ts`** — added a `WebSocket.prototype.bufferedAmount`
   probe (keyed to the same `markPolyfilled` name) so a regression shows up at
   boot instead of silently reintroducing the dial-timeout failure.
4. **`docs/reference-app-ns.md`** — documented the shim in the polyfill table,
   the V8/JSC-vs-Hermes comparison table, and the startup-sequence code block
   (now 5 steps instead of 4), including a short paragraph on why this one
   patch can't run at barrel-import time like the others.

## `AbortSignal.any` listener leak (`src/polyfills/abort.ts`)

Per the ticket's correction section: `static any` attached an `abort` listener
to every input signal and never removed any of them once the combined signal
settled — a leak on any long-lived input (Optimystic's repo client combines a
caller signal with a fresh deadline controller on every remote block RPC).
Rewrote it to match the already-verified RN pattern: collect listeners, detach
them all once the combined signal aborts (whichever input caused it), and
register nothing at all when an input is already aborted at call time (early
return before any listener is attached).

**`static timeout`: the ticket's TODO literally says "clear its timer once the
signal has aborted," but the ticket's own correction paragraph says not to do
that** — only the timer itself can abort that signal, so an abort listener that
tries to clear it would run after the fact and accomplish nothing. I left the
logic unchanged and only added a `NOTE:` comment explaining why, mirroring the
comment already in the RN version. Flagging this explicitly in case the
literal TODO wording was intentional and I'm misreading the correction.

Per the ticket, the case where a combined signal's controller is *cleared*
(never aborted) — Optimystic's repo client on a successful RPC — is NOT fixed
by this change and isn't fixable from inside the polyfill (no GC hook). That's
tracked separately in `tickets/backlog/bug-abortsignal-any-leaks-listeners-on-hermes.md`.

## Validation performed

- `yarn workspace @serfab/reference-app-ns typecheck` — clean.
- `yarn workspace @serfab/reference-app-ns test` — 103/103 passed, 5 files.
  **Required rebuilding two stale sibling packages first**
  (`yarn workspace @optimystic/db-core build` and `@optimystic/db-p2p build` in
  `../optimystic`, both plain `tsc`, gitignored `dist`, no source changes) — the
  stale-build guard was tripped by *pre-existing* uncommitted edits in the
  sibling `../optimystic` checkout (`git status` there shows in-progress work
  on `change-notifier.ts`, `block-transfer.ts`, etc., none of it touched by
  this ticket). Not filed as a pre-existing-test-failure — it's a build-freshness
  gate, not a failing test, and rebuilding is the documented recovery path.
- `yarn lint` — clean, exit 0.
- `yarn workspace @serfab/reference-app-ns test:bundle` — webpack compiles the
  whole graph (now including `app.ts`'s new import/call) with **0 errors, 0
  warnings**.

## What's NOT verified — same gap the ticket flagged, still open

**No NativeScript device or emulator is available in this pipeline.** Nobody
has watched a real dial succeed against a WebSocket-listening peer, or read
`bufferedAmount` off a live socket instance. What was actually checked is:
source-level confirmation that the property is never assigned by the native
plugin, and that the shim + its audit probe are wired correctly through the
bundle. The one thing that would make the original diagnosis a non-issue —
`@valor/nativescript-websockets` setting `bufferedAmount` from native code in a
way a source search can't see — is still unruled-out without a device.

Also unexecuted (needs a device/emulator, explicitly out of scope for this
implement pass per the earlier `rn-polyfill-guard-and-audit` precedent):
`test:bundle:native` (gradle) and `test:e2e` (Maestro).

## Suggested review focus

1. The `app.ts`/`hermes.ts` ordering fix (item 2 above) — is exporting
   `patchWebSocketBufferedAmount` and calling it post-import the right shape,
   or is there a cleaner way to sequence it within the existing barrel
   convention?
2. The `AbortSignal.timeout` non-change — confirm the TODO's literal wording
   was superseded by the ticket's own correction, not missed.
3. Whether a device/emulator check should block this ticket's promotion to
   `complete/` or be tracked as a follow-up — no device is available here
   either.
