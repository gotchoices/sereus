description: Reviewed and confirmed the browser-app changes that make invitation-formed chat strands replicate, plus the test-only hooks an end-to-end test uses to connect two parties and read/write their shared messages.
prereq:
files: packages/reference-app-web/src/lib/cadre-web.ts, packages/reference-app-web/src/lib/chat-dml.ts, packages/reference-app-web/src/lib/messages.svelte.ts
difficulty: medium
----

# Complete: browser app hooks for live formation → convergence

App-side enabler for the live two-party formation→convergence e2e. Reviewed the
implement-stage diff (`31d105e`) with fresh eyes, traced every seam into cadre-core,
ran the full validation chain (typecheck, lint, build, the entire solo e2e suite),
and applied one minor DRY fix inline. The consumer that drives these hooks
(`formation-convergence-e2e-wire-and-spec`) is a separate ticket already sitting in
`implement/`.

## What landed (unchanged from implement, all verified)

1. **Formed strands run `networked`.** `createClosedChatStrand` (cadre-web.ts:475)
   and `joinViaInvitation` (:574) pass `mode: 'networked'` to `addStrand`. The solo
   `addChatStrand` (:705) was correctly left to infer `bootstrap` — confirmed
   unchanged.
2. **Five strand-level `__cadre` test hooks** in cadre-web.ts, all targeting the
   formed strand via `node.getStrand(strandId)`: `getStrandMultiaddrs`,
   `dialStrandPeer`, `getStrandConnectionCount`, `writeChatMessage`,
   `readChatMessages`. Backed by guards that throw clear errors on
   unknown/launching/bootstrap strands.
3. **Shared `chat-dml.ts`** — `insertChatMessage` / `selectChatMessages` extracted
   from `messages.svelte.ts`; both the solo Messages store and the formed-strand
   hooks now call one source of truth.

## Review findings

### Checked — correctness of the seams (all CONFIRMED correct)
- **`mode: 'networked'` placement.** Present on exactly the two formed-strand
  `addStrand` calls, absent on solo `addChatStrand`. The justification is sound:
  traced `addStrand → launchStrand → selectStrandMode` in cadre-core, which is
  literally `explicitMode ?? (hasOtherPeers ? 'networked' : 'bootstrap')`
  (`strand-cohort.ts:58`). A formed strand has zero `CadrePeer` rows at creation, so
  without the explicit mode it would infer `bootstrap` and get a non-replicating
  local transactor — exactly the silent failure the comment describes.
- **Hooks target the right node/DB.** `StrandInstance.libp2pNode` is the strand-level
  node (`types.ts:320`) and `.database` is a `StrandDatabase` exposing `getDatabase()`
  (`strand-database.ts:110`) — both confirmed against cadre-core. Hooks resolve via
  `node.getStrand(strandId)`, never the control node or solo `CHAT_STRAND_ID`.
- **Guards throw loudly.** Unknown / still-launching / bootstrap (no libp2p node) all
  surface a thrown Error, not a bare `undefined` deref.
- **Seam contract matches the consumer.** Hook names/signatures line up exactly with
  `tickets/implement/2-formation-convergence-e2e-wire-and-spec.md` (`dialStrandPeer`,
  `getStrandConnectionCount`, `readChatMessages(strandId) → {id,memberId,content}[]`,
  `writeChatMessage(strandId, {memberName, content})`).
- **DML faithfulness.** `chat-dml.ts` is a faithful move of the prior inline SQL
  (same Member-before-Message FK ordering, UUID id, `'YYYY-MM-DD HH:MM:SS'` timestamp,
  same join + ordering). The `svelte/prefer-svelte-reactivity` disable was correctly
  dropped because the transient `Date` now lives in a plain `.ts` file, not a reactive
  `.svelte.ts`. Grep confirms `chat-dml.ts` is the *only* remaining App.Member/Message
  DML site in `reference-app-web/src` — extraction is complete, no stragglers.
- **`__cadre` typing.** The hook object is intentionally untyped (`unknown`), accessed
  via casts in specs; the new entries follow the established pattern, so there is no
  type declaration or doc that fell out of date.

### Found & fixed inline (minor)
- **DRY in the guard helpers.** `requireStrandLibp2p` and `requireStrandDatabase`
  duplicated the `!node` check + `getStrand` + not-found throw. Extracted a shared
  `requireStrandInstance(strandId): StrandInstance` that both now delegate to
  (cadre-web.ts:745). Pure internal refactor, no behavioral change. Typecheck + lint +
  the messages-roundtrip e2e re-run all green afterward.

### Found — major (none filed)
- No major defects. The one residual risk (below) is behavioral validation already
  owned by an existing ticket, so filing a new one would be duplicate noise.

### Residual risk (documented, not a new ticket — owned by the consumer)
- **The `networked`-mode formed-strand launch+convergence is not exercised by any
  test runnable in this environment.** The solo `formation-rbac` spec throws at the
  relay/dialability guard in `createInvitation` (cadre-web.ts:511) *before* reaching
  `createClosedChatStrand`, so no solo test reaches the networked `addStrand`. The
  cross-party convergence path is deferred at the harness level
  (`TIER2_CONVERGENCE_DEFERRED = true` in `e2e/global-setup.ts`) pending a
  relay + responder fixture. The open question it must answer: whether a formed strand
  created `networked` with zero connected peers initializes/schema-applies and seeds
  the responder's first message without blocking on a cohort quorum (a 2-member cohort
  needs super-majority of 2). The implementer asserts it launches before the peer
  dials in; I could not confirm it here. This is precisely the job of
  `formation-convergence-e2e-wire-and-spec` (already in `implement/`), which polls
  `getStrandConnectionCount(strandId) >= 1` before expecting convergence for exactly
  this reason.

## Validation performed (this pass)
- `yarn workspace @serfab/reference-app-web typecheck` — **GREEN** (before and after
  the DRY fix).
- `eslint` on `cadre-web.ts`, `chat-dml.ts`, `messages.svelte.ts` — **GREEN**.
- `vite build` — **GREEN**. The implement ticket's primary deferral (a `node:crypto`
  hard-fail from `push-notifier-fcm.ts`/`-apns.ts`) was **resolved out-of-band by the
  triage commit `0e82724`** (named import → namespace import; now a benign warning).
  So the build/e2e gate the implementer could not run is now runnable, and I ran it.
- **Full solo e2e suite — 25/25 GREEN.** Includes `messages-roundtrip` (directly
  exercises the refactored DML), `reload-persistence`, `boot`, `formation-rbac`,
  `schema-signature-gate`, `routing`, `diagnostics`. Confirms the DML extraction is
  behaviorally faithful and the solo bootstrap path is intact.
- Distributed/Tier-2 specs — **not run** (harness-deferred behind the relay+responder
  fixture; see Residual risk).

## Notes for the next agent
- `tickets/.pre-existing-error.md` no longer exists — the triage pass already consumed
  and resolved it. No new pre-existing failure was observed.
- No cadre-core change was needed; `StrandInstance.libp2pNode`/`.database` and
  `getStrand` are already public.
