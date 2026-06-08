----
description: Review the collision-free (text UUID) message PK migration across the chat-simple schema family (schemas, RN, ns, web, integration tests, RN drone fixture)
prereq:
files: schemas/chat-simple.qsql, packages/reference-app-rn/src/chat-operations.ts, packages/reference-app-rn/src/chat-strand.ts, packages/reference-app-rn/src/uuid.ts, packages/reference-app-rn/test-fixture/start.mjs, packages/reference-app-rn/test-fixture/sidecar.mjs, packages/reference-app-ns/src/chat-operations.ts, packages/reference-app-ns/src/chat-strand.ts, packages/reference-app-ns/src/chat-vm.ts, packages/reference-app-web/src/lib/chat-strand.ts, packages/reference-app-web/src/lib/messages.svelte.ts, packages/reference-app-web/e2e/solo/messages-roundtrip.spec.ts, packages/integration-tests/src/scenarios/websocket-chat.integration.ts, packages/integration-tests/src/scenarios/convergence-stress.integration.ts, packages/integration-tests/src/scenarios/multi-party-workflows.integration.ts, docs/reference-app-rn.md
----

## What changed and why

The simplified chat sApp keyed `Message.Id` as `integer primary key` and computed
the next key as `max(Id)+1` read from the **local** replica. Once two peers share
a strand and post concurrently, they independently compute the same `max(Id)+1`
and collide on the PK. This migrates the whole chat-simple schema family to a
**text UUID** primary key generated locally per peer — globally unique, no local
read, collision-free under concurrency.

`Message.Id` is not chronologically sortable as a UUID, so message ordering moved
from `order by M.Id asc` to `order by M.Timestamp asc, M.Id asc` (Timestamp is the
primary sort; the UUID Id is only a stable tiebreak). `Timestamp` has **second**
resolution, so two peers posting within the same second resolve to an
arbitrary-but-stable order — documented in code as an accepted reference-app limit.

### Scope landed before this run (already committed — verify, don't re-do)

The RN app source was already migrated by the prior (interrupted) run and landed
via a later commit (the trust-enrollment ticket built on top of it). These are
**committed and clean**, not in this run's diff, but are part of the feature and
should be reviewed:
- `packages/reference-app-rn/src/uuid.ts` — new tiny Math.random v4 UUID helper
  (Hermes lacks `crypto.randomUUID`; only `crypto.getRandomValues` is polyfilled
  via `react-native-get-random-values`). Also now used by `app/settings.tsx`
  (strand IDs), de-duplicating the inline copy that lived there.
- `packages/reference-app-rn/src/chat-operations.ts` — `ChatMessage.Id: string`,
  `insertMessage` blind-inserts a `uuid()` (no `max(Id)` read), `queryMessages`
  orders by `Timestamp, Id`.
- `packages/reference-app-rn/src/chat-strand.ts` — `CHAT_SCHEMA` `Message.Id text
  primary key`.

### Scope landed THIS run (in the diff)

Canonical + mirror schemas → `text primary key`:
- `schemas/chat-simple.qsql` (canonical on-disk schema; header comment added).
- `packages/reference-app-ns/src/chat-strand.ts`, `packages/reference-app-web/src/lib/chat-strand.ts`
  (the web copy is **signed** at runtime via `signSchema(CHAT_SCHEMA,…)`, so the
  schema-body change just recomputes a valid signature — verified by svelte-check
  + the signature gate is exercised by web e2e, not in-agent).
- `packages/reference-app-rn/test-fixture/start.mjs` (drone e2e fixture; its
  embedded schema mirrored the bug — flagged as "drone-fixture divergence" by the
  earlier closed-strand ticket).

Insert/query logic mirrored from the RN app:
- `reference-app-ns/src/chat-operations.ts` — `Id: string`, `crypto.randomUUID()`
  blind insert (NativeScript 8.8+ native, matches `solo-smoke.ts`), `order by
  Timestamp, Id`. `chat-vm.ts` `ChatRow.id: number → string` (consumes `message.Id`).
- `reference-app-web/src/lib/messages.svelte.ts` — `Id: string`,
  `crypto.randomUUID()` (browser native, matches `cadre-web.ts`), `order by
  Timestamp, Id`.
- `reference-app-rn/test-fixture/sidecar.mjs` — drops `max(Id)` read, uses the
  already-imported `randomUUID` from `node:crypto`; `order by Timestamp, Id`.

Integration tests (text IDs + assertions):
- `websocket-chat.integration.ts` — schema text PK; literal-`1` insert + three
  `where Id = 1` assertions → fixed text id `'msg-drone-1'`.
- `multi-party-workflows.integration.ts` — schema text PK; `values (1,…)`/`(2,…)`
  + `where Id = 1`/`= 2` → `'msg-a-1'`/`'msg-b-1'`.
- `convergence-stress.integration.ts` — schema text PK; `insertBatch` and the
  interleaved inserts drop `coalesce(max(Id),0)+1` for `randomUUID()` (imported
  from `node:crypto`). **The interleaved loop now reads before each insert — see
  the convergence note below; this is the one non-obvious change.**

Docs: `docs/reference-app-rn.md` chat-schema snippet → text PK with rationale.

## ⚠️ Reviewer: scrutinize this — read-driven convergence

Removing the per-send `max(Id)` read changed an emergent behavior. **Optimystic
convergence is read-driven**: a peer observes another peer's appends when it
*reads*. The old `(select max(Id)+1)` subquery did an implicit read on every
insert, which is what drove convergence in the tight test loops.

- `convergence-stress` "Interleaved Inserts" (20 bidirectional blind inserts, zero
  intervening reads) **timed out at 30s** with the blind-UUID change. I verified
  this is a real regression of the *test*, not flakiness: reverting just that file
  to HEAD converges in ~20ms; my version times out reproducibly; adding a single
  read before each insert converges in ~11ms (confirmed by experiment).
- Fix: the interleaved loop now does a `queryAll(db, 'select Id from App.Message')`
  before each insert, **mirroring how the real app actually behaves** — every peer
  polls `queryMessages` on a timer (`useChat` 2s, web `messages.svelte` 4s, ns 2s)
  between sends. The old subquery is gone, so the poll is explicit. Sequential
  burst (10 then 10) and disconnection scenarios still converge without it because
  one side completes before the other; only tight *interleaved bidirectional*
  no-read writes hit the wall.
- **Why the app is fine:** the app reads continuously via polling, which drives the
  same convergence. The removed read was the racy bug the ticket targets.
- **Open question for the reviewer:** is "concurrent bidirectional blind appends do
  not converge within 30s via `count(*)` polling alone, but do converge the moment
  either side issues a list read" expected Optimystic pull-based behavior, or a
  latent convergence gap worth a `fix/`/`backlog/` investigation ticket? I did not
  file one — it does not affect the polling app and may be by design — but it is the
  highest-value thing to second-guess here. If the reviewer wants it tracked, a
  backlog ticket against Optimystic strand sync (not the reference app) is the place.

## Use cases / validation

Ran in-agent (all green):
- `typecheck`: reference-app-rn, reference-app-ns, reference-app-web,
  integration-tests — all exit 0.
- `svelte-check` (web): 0 errors / 0 warnings (validates the `.svelte` template
  consuming the now-`string` `msg.Id`).
- `vitest` integration (real libp2p, in-process):
  - `websocket-chat` — 1/1 pass (text id `'msg-drone-1'` replicates drone→phone).
  - `convergence-stress` — 3/3 pass (sequential 10+10, interleaved bidirectional,
    disconnect/reconnect; all converge to 20/10 identical messages).
  - `multi-party-workflows` — 5/5 pass (closed-strand bidirectional chat with text
    ids; Phase-2 convergence tests use the separate `Data` key-text schema).
- `eslint` on all changed `.ts`: 0 errors (3 pre-existing `warn`s: unused
  `StrandInstance`/`sleep` imports in websocket-chat, and the `new Date()` /
  `prefer-svelte-reactivity` in `messages.svelte.ts` — all predate this change).

Worth a reviewer's manual eye (use-case checks):
- Two RN phones in one strand both sending rapidly → no PK collision, both messages
  appear on both devices after a poll cycle.
- Ordering: messages from the same wall-clock second may render in UUID-tiebreak
  order, not strict send order. Confirm that's acceptable UX for the reference app
  (it is documented as a limit).
- Web `Messages.svelte` renders `#{msg.Id}` — now a full UUID in the row corner
  (cosmetic; left as-is). The `{#each … (msg.Id)}` keying still works with strings.

## Known gaps / NOT run in-agent (treat tests as a floor)

- **RN bundle/build** (`expo export`) and **RN Maestro e2e** — need the Expo
  toolchain / device-emulator; not agent-runnable. RN typecheck passed; the
  bundle was not produced. The drone fixture (`start.mjs`/`sidecar.mjs`) feeding
  RN e2e was updated but only typechecked indirectly (`.mjs`, no per-file check).
- **ns** — `crypto.randomUUID()` typechecks (matches existing `solo-smoke.ts`
  usage) but the NativeScript bundle (`test:bundle`) / device e2e were not run.
- **web Playwright e2e** (`messages-roundtrip.spec.ts`) — not runnable here (needs
  browser + dev server). I rewrote the obsolete `'multiple messages keep ascending
  order'` test: it parsed `data-message-id` via `Number(...)` and asserted numeric
  ascending order — meaningless for UUIDs, and sub-second ties are no longer
  insertion-ordered. It now asserts all sent messages render with **distinct,
  non-empty** ids (collision-freedom, the ticket's actual invariant) and explicitly
  does NOT assert insertion order. **This test edit is unverified in-agent** —
  please run it (or eyeball the logic).
- The `quereus-plugin-sereus` tests and `schemas/chat.qsql` were deliberately left
  on `integer` PKs: the former are generic example schemas (`Msg`/`Account`/`Post`/
  `Note`, no `MemberId`/FK), the latter is the full *signed* chat schema whose
  `Message.Id` is an intentionally constrained monotonic sequence (`IdValid` check).
  Neither is the simplified reference chat. Confirm you agree with this boundary.

## Pointers

- Collision mechanism + design: original ticket (now deleted from `implement/`).
- Convergence experiment evidence: `/tmp/it-conv*.log` from this run (HEAD passes,
  blind-UUID times out, read-before-insert passes) — re-run the three integration
  files to reproduce.
