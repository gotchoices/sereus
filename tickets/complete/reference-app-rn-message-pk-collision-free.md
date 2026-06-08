----
description: Collision-free (text UUID) message PK migration across the chat-simple schema family (schemas, RN, ns, web, integration tests, RN drone fixture) — reviewed and completed
prereq:
files: schemas/chat-simple.qsql, packages/reference-app-rn/src/uuid.ts, packages/reference-app-rn/src/chat-operations.ts, packages/reference-app-rn/src/chat-strand.ts, packages/reference-app-rn/test-fixture/start.mjs, packages/reference-app-rn/test-fixture/sidecar.mjs, packages/reference-app-ns/src/chat-operations.ts, packages/reference-app-ns/src/chat-strand.ts, packages/reference-app-ns/src/chat-vm.ts, packages/reference-app-web/src/lib/chat-strand.ts, packages/reference-app-web/src/lib/messages.svelte.ts, packages/reference-app-web/e2e/solo/messages-roundtrip.spec.ts, packages/integration-tests/src/scenarios/websocket-chat.integration.ts, packages/integration-tests/src/scenarios/convergence-stress.integration.ts, packages/integration-tests/src/scenarios/multi-party-workflows.integration.ts, docs/reference-app-rn.md
----

## Summary

Migrated the simplified chat sApp's `Message.Id` from `integer primary key`
(`max(Id)+1` read from the local replica — collides when two peers post into a
shared strand before either replicates) to a **text UUID primary key generated
locally per peer**: globally unique, no local read, collision-free under
concurrency. Message ordering moved from `order by M.Id` to `order by M.Timestamp
asc, M.Id asc` (Timestamp is second-resolution, so same-second posts resolve to an
arbitrary-but-stable UUID-tiebreak order — documented as an accepted reference-app
limit). Applied across the whole chat-simple family: canonical + mirror schemas,
RN/ns/web app source, the RN drone e2e fixture, and three integration scenarios.

## Review findings

### Scope re-verified (implementer's claims, all confirmed)

- **Schema migration complete & consistent.** Grepped the repo for `Id integer
  primary key`, `max(Id)`, and `order by …Id` in the chat-simple family: every chat
  `Message` schema (`schemas/chat-simple.qsql`, RN/ns/web `chat-strand`,
  `test-fixture/start.mjs`, and the three integration scenarios' embedded schemas)
  is `text primary key`. The only remaining `integer primary key` / `max(Id)` hits
  are in `quereus-plugin-sereus` (generic `Msg`/`Account`/`Post`/`Note` example
  schemas) and `schemas/chat.qsql` (the full *signed* chat schema with the
  `IdValid` monotonic-sequence check) — both intentionally out of scope. **I agree
  with this boundary.**
- **Insert/query logic** mirrored correctly: RN `uuid()` (Math.random v4 — Hermes
  lacks `crypto.randomUUID`), ns/web `crypto.randomUUID()` (native), sidecar
  `randomUUID()` (node:crypto) — all blind inserts, no `max(Id)` read. Ordering
  `Timestamp, Id` everywhere.
- **Type/consumer safety.** `ChatMessage.Id: string`, `ChatRow.id: string`. Every
  downstream consumer is string-safe: RN `index.tsx` `keyExtractor={String(m.Id)}`,
  `messageRow(id: number|string)` (RN + ns), web `{#each … (msg.Id)}` keying, web
  `#{msg.Id}` render (full UUID — cosmetic, left as-is). `multi-party` Scenario-1's
  `order by Id` on `App.Message` is now lexical UUID order but only feeds a
  `.toHaveLength(2)` assertion, so it's harmless.
- **uuid.ts de-duplication** confirmed — `app/settings.tsx`, `src/use-cadre.ts`, and
  `src/chat-operations.ts` all import the single `src/uuid.ts`; no inline copies
  remain.

### Validation run in-agent (all green)

- **typecheck**: reference-app-rn, reference-app-ns, reference-app-web,
  integration-tests — all exit 0.
- **eslint** on all changed `.ts`: 0 errors. 3 warnings, all pre-existing and
  unrelated to this change (`StrandInstance`/`sleep` unused imports in
  websocket-chat; `prefer-svelte-reactivity` on `new Date()` in messages.svelte.ts).
- **vitest integration** (real libp2p, in-process): `websocket-chat` 1/1,
  `multi-party-workflows` 5/5, `convergence-stress` 3/3 — **9/9 pass**. Interleaved
  convergence at 9ms, sequential burst 24ms, disconnect/reconnect 7ms.

### Edge / error / regression coverage checked

- Collision-freedom invariant: the rewritten web e2e
  (`'multiple messages all render with distinct collision-free ids'`) now asserts
  distinct non-empty ids and explicitly does NOT assert insertion order — correct
  for UUIDs with sub-second ties. (Web Playwright e2e is **not agent-runnable** —
  needs browser + dev server; logic reviewed by eye, sound.)
- The text-PK replication assertions use fixed deterministic ids
  (`'msg-drone-1'`, `'msg-a-1'`, `'msg-b-1'`) — good, keeps assertions stable.
- `Id text primary key` carries no explicit `not null`, but all inserts supply a
  generated UUID and the integer PK had the same shape — not a regression.

### Not run in-agent (treat tests as a floor — unchanged from handoff)

- RN `expo export` bundle + Maestro e2e (Expo toolchain/emulator); ns
  `test:bundle` + device e2e; web Playwright e2e. RN/ns typecheck passed; bundles
  not produced. These need toolchains/devices that are not agent-runnable.

### Findings filed (major)

- **`tickets/backlog/optimystic-strand-sync-blind-write-convergence.md`** — the
  implementer's flagged open question: removing the per-insert `max(Id)` subquery
  removed an *implicit read*, and pure bidirectional blind appends (no intervening
  list read) timed out in the interleaved test until an explicit read was added.
  The fix (read-before-insert) faithfully mirrors the apps' polling timers, so the
  **reference apps are unaffected and correct**. Whether Optimystic's read-driven
  (pull) convergence is by-design or a latent gap is an *Optimystic*-internals
  question — filed to backlog for investigation, not fix/, because it is not a
  confirmed defect and may be intended. I additionally noted that the stated
  mechanism ("`count(*)` polling doesn't converge, list read does") is incomplete:
  the test's own `waitForConvergence` gate uses `count(*)` yet passes, so the real
  trigger needs pinning down before any Optimystic code change.

### Fixed inline (minor)

- None. No minor defects found — the implement diff was clean, DRY (single
  `uuid.ts`, mirrored comments), and the test rewrites were correct. The dead
  `number` arm of `messageRow(id: number|string)` was left intentionally (defensive
  signature on a shared test-id helper; not worth churn).
