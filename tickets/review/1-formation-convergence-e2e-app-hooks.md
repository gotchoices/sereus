description: Review the browser-app changes that make invitation-formed chat strands replicate and add the test-only hooks an end-to-end test uses to connect two parties and read/write their shared messages.
prereq:
files: packages/reference-app-web/src/lib/cadre-web.ts, packages/reference-app-web/src/lib/chat-dml.ts, packages/reference-app-web/src/lib/messages.svelte.ts, packages/cadre-core/src/types.ts, tickets/.pre-existing-error.md
difficulty: medium
----

# Review: browser app hooks for live formation → convergence

App-side enabler for the live two-party formation→convergence e2e. Two classes of
change landed in `reference-app-web`, both grounded in how the cadre-core strand
cohort converges. This is a starting point — the e2e suite that consumes these
hooks (`formation-convergence-e2e-wire-and-spec`) is a separate, still-pending
implement ticket, and the full browser build / e2e could **not** be run here due to
a pre-existing cadre-core bundling break (see "Validation" + the deferral below).

## What changed

### 1. Formed strands run `networked` (so they actually replicate)
`packages/reference-app-web/src/lib/cadre-web.ts`:
- `createClosedChatStrand` (~`:475`) and `joinViaInvitation` (~`:567`) now pass
  `mode: 'networked'` to `addStrand`. Without it, `addStrand` infers `bootstrap`
  from the empty `CadrePeer` cohort (formation exchanges peer addrs but persists no
  `CadrePeer` rows yet) and the strand gets a **local transactor that never
  replicates** — the silent no-convergence failure mode.
- **The solo `addChatStrand` (~`:693`) is intentionally left `bootstrap`** (solo, no
  peers). Confirm it was NOT changed.

### 2. Strand-level test hooks on the read-only `__cadre` surface
Five new exported functions in `cadre-web.ts`, each surfaced on the `__cadre`
debug hook in `exposeDebugHook` (guarded by the same `typeof window === 'undefined'`
no-op as the rest of the hook):
- `getStrandMultiaddrs(strandId): string[]` — the **strand-level** node's multiaddrs
  (`getStrand(strandId).libp2pNode.getMultiaddrs()`), not the control node's.
- `dialStrandPeer(strandId, addr): Promise<void>` — `multiaddr(addr)` → the strand's
  `libp2pNode.dial(...)`, wiring the cohort link control-network discovery doesn't seed yet.
- `getStrandConnectionCount(strandId): number` — `libp2pNode.getConnections().length`,
  for polling until the cohort link is live before expecting convergence.
- `writeChatMessage(strandId, { memberName, content }): Promise<string>` — upsert the
  author `Member` row then insert an `App.Message` into the **formed** strand's DB;
  returns the new message id.
- `readChatMessages(strandId): Promise<Array<{ id; memberId; content }>>` — read
  `App.Message` from the **formed** strand's DB.

All five resolve the target strand via `node.getStrand(strandId)` (the formed,
responder-minted UUID strand) — **never** the solo `CHAT_STRAND_ID`. Two private
guards back them: `requireStrandLibp2p` (throws clearly when the strand is unknown /
still launching / has no libp2p node, e.g. a `bootstrap` strand) and
`requireStrandDatabase` (throws clearly when the strand is unknown / has no attached
DB). A wrong/unknown `strandId` errors loudly rather than silently reading an empty
strand.

### 3. Shared, strand-agnostic chat DML (DRY extraction)
New `packages/reference-app-web/src/lib/chat-dml.ts` holds the `Member`+`Message`
insert/select pattern, taking a Quereus `Database` instead of assuming the active
solo strand:
- `insertChatMessage(db, memberName, content): Promise<string>` — `insert or ignore`
  the `Member` row **before** the `Message` (load-bearing for the FK
  `Message.MemberId → Member.Id` on a fresh formed strand whose `Member` table is
  empty), UUID message id, Quereus `'YYYY-MM-DD HH:MM:SS'` timestamp.
- `selectChatMessages(db): Promise<ChatMessageRow[]>` — the `Message`⋈`Member` join,
  ordered `Timestamp asc, Id asc`.

`messages.svelte.ts` (the solo Messages UI store) was refactored to call these — its
`refresh()` and `sendMessage()` now delegate to the shared module (the inline SQL +
the transient-`Date` eslint-disable were removed). `cadre-web.ts`'s `writeChatMessage`
/`readChatMessages` call the same helpers, so the solo path and the formed-strand
hooks are byte-identical DML (one source of truth).

## Use cases / what to verify

**Reviewer focus — correctness of the seams:**
- `mode: 'networked'` is present on exactly the two formed-strand `addStrand` calls and
  absent on the solo `addChatStrand`. (Regression risk: solo `messages-roundtrip` /
  `boot` if solo flipped to `networked`.)
- The five hooks target the **strand-level** libp2p node and the **formed** strand DB,
  not the control node / solo strand. `getStrandMultiaddrs` must NOT return control addrs.
- Guards: every hook throws a clear, surfaced error (not a bare `undefined` deref) when
  the strand is unknown, still launching, or `bootstrap` (no libp2p node). `dialStrandPeer`
  surfaces the libp2p error on an unreachable addr rather than wedging; already-connected
  dials are idempotent (libp2p-handled).
- DML faithfulness: the extracted `chat-dml.ts` is behaviorally identical to the prior
  inline solo code (same SQL, same UUID id, same timestamp format, Member-before-Message
  FK ordering). The solo `messages.svelte.ts` field mapping (lowercase row → uppercase
  `ChatMessage`) preserves `Id/MemberId/Content/Timestamp/MemberName`.

**Behavioral (the consumer, sibling ticket — context, not this review's job):**
The `formation-convergence-e2e-wire-and-spec` spec joins via invitation, calls
`__cadre.dialStrandPeer(strandId, strandMultiaddrs[0])`, polls
`__cadre.getStrandConnectionCount(strandId) >= 1`, then polls
`__cadre.readChatMessages(strandId)` until the responder's seeded message appears
(cross-cohort convergence), with `writeChatMessage` for the optional reverse direction.
The hook signatures here match that ticket's expected contract.

## Validation performed

- `yarn workspace @serfab/reference-app-web typecheck` (`tsc --noEmit`) — **GREEN**.
- `eslint` on the three changed/added files (`chat-dml.ts`, `messages.svelte.ts`,
  `cadre-web.ts`) — **GREEN**.

## Known gaps / deferrals (be honest)

- **Full `vite build` + the solo/convergence e2e were NOT run.** They are blocked by a
  **pre-existing** cadre-core break unrelated to this ticket: `push-notifier-fcm.ts`
  (added by `cadre-push-notifier`, commit `66d736d`) does a top-level
  `import { sign } from 'node:crypto'`, reachable from `CadreNode` via `push-notifier.js`,
  and `reference-app-web` bundles `CadreNode`. The web vite config **deliberately** does
  not alias `node:crypto` ("a real bug we want surfaced"), so the bundle hard-fails:
  `"sign" is not exported by "__vite-browser-external"`. Because `playwright.config.ts`'s
  `webServer` runs `yarn build && yarn preview`, the e2e server can't start either.
  Logged in `tickets/.pre-existing-error.md` for the triage pass. **This blocks the
  sibling wire-and-spec e2e tier until cadre-core stops pulling `node:crypto` into the
  browser graph** — worth flagging upward, not just leaving to triage.
- Consequently, the new hooks and the solo-path refactor have **type/lint-level**
  assurance only; no behavioral/e2e confirmation in this window. The DML extraction is a
  faithful move of unchanged SQL, so regression risk is low, but the reviewer should
  re-run the solo e2e (`messages-roundtrip`, `boot`, `formation-rbac`) once the cadre-core
  bundling break is fixed.
- No cadre-core change was needed or made (`StrandInstance.libp2pNode` and `getStrand`
  are already public). The `types.ts` reference in `files:` is for context only (the
  `StrandConfig.mode` semantics), not a change.
