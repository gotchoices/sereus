description: The wait a machine gets to receive a shared workspace's data when it joins was too short for a phone on a slow relayed connection, so normal joins were reported as failures; the wait is now two minutes and the reason is written down where it is set.
architecture: docs/strands.md#joining-no-writes-before-the-first-sync
files:
  - packages/cadre-core/src/strand-first-sync-gate.ts (DEFAULT_STRAND_FIRST_SYNC_TIMEOUT_MS: 30_000 -> 120_000, doc comment rewritten)
  - packages/cadre-core/src/types.ts (CadreNodeConfig.strandFirstSync doc, ~line 745)
  - packages/cadre-core/test/strand-first-sync-gate.spec.ts (one comment naming the module default)
  - docs/strands.md ("Joining: no writes before the first sync", the addStrand bullet)
  - docs/reference-app-rn.md (new paragraph after "The ping deadline is already widened")
  - .release-notes.pending.md
----

# Review: the joining machine's first-sync wait is now 120 s

## What changed

`DEFAULT_STRAND_FIRST_SYNC_TIMEOUT_MS` went from 30 s to 120 s. Nothing else in the gate's behaviour moved: the probe, its cadence, the retryable `StrandAwaitingFirstSyncError`, the `strand:writable` event and the founder/restart fast paths are untouched. The rest of the diff is the explanation following the number into the four places that carry it.

The constant's doc comment now carries both measurements instead of one: the direct-connection case (about 1.3 s, 2026-09-16) kept as the fast case, and the relayed slow-link band the ticket measured on 2026-09-26 — one Windows developer machine, two relay-only `CadreNode`s on a shared loopback dedicated relay, 900 ms one-way per-frame delay, so about a 1.8 s round trip; first sync completed in 23, 27, 31 and 41 s at optimystic's 1000 ms cohort read deadline, and 35, 42 and 46 s at a 5000 ms one. The comment states what the larger value costs (a strand whose members are all genuinely unreachable takes two minutes to report rather than thirty seconds) and why that cost is bounded (retryable rejection, launch stays up, event fires on arrival).

`CadreNodeConfig.strandFirstSync`'s doc, the `addStrand` bullet in `docs/strands.md`, and a new paragraph in `docs/reference-app-rn.md` beside the widened ping deadline all name 120 s and say why a relayed phone needs it. One line added to `.release-notes.pending.md`.

## Why 120 s and not something else

The worst measured sample is 46 s, at the 5000 ms cohort read deadline `2-declare-cohort-read-deadline-for-relayed-phones` proposes — so 120 s clears the band that will be in force after that sibling lands, with about 2.6x margin, not just today's. It is also the value the reporting app had already set for itself, which is the evidence that a two-minute wait is tolerable in a real app rather than only on paper.

## Tests

**No test added**, and that is deliberate — the ticket asked for none. The value is a constant with no branching; the gate's behaviour (comes up `syncing`, times out retryably, opens when the Header arrives, survives a hibernation cycle, honours a retained per-launch `timeoutMs`) is already pinned by `packages/cadre-core/test/strand-first-sync-gate.spec.ts`, and the measured band behind the number was taken with an instrument this repo does not commit.

One existing comment in that spec named "the module default of 30 s" as the thing the retained config's budget is well under; it now says 120 s. The assertion it annotates (`< 5 s` elapsed) is unchanged and still discriminates.

## What was run

- `yarn workspace @serfab/cadre-core typecheck` — clean.
- `yarn workspace @serfab/cadre-core build` — clean; `dist` rebuilt, so the emitted constant is 120000.
- `yarn workspace @serfab/cadre-core test` — 139 files, 2273 passed, 1 skipped, no failures.
- `yarn lint` — clean.

Integration scenarios were not run (they are the slow, opt-in ones); none of them depends on this default — every one passes an explicit `timeoutMs` or `awaitFirstSync: false`.

## What a reviewer should check

- **Every caller that could now block for two minutes.** The risk of this change is a caller that awaits `addStrand`/`whenStrandWritable` against a gated strand with no reachable peer and no explicit budget: it now sits for 120 s where it sat for 30. I grepped the repo for `whenWritable`, `whenStrandWritable`, `awaitFirstSync` and `addStrand` across `packages/cadre-core/test`, `packages/integration-tests/src`, `packages/cadre-cli/src`, `packages/cadre-host/src` and both reference apps: every joiner-shaped call passes `awaitFirstSync: false` or an explicit `timeoutMs` (`relay-round-trip-measure` and `blind-relay-phone-to-phone-e2e` already use 120 s of their own; `convergence-stress` uses 30 s explicitly; the `strand-join` harness threads its own). `cadre-cli`, `cadre-host` and `cadre-provider` never call `addStrand` or `whenStrandWritable` at all, so no request handler there can hold a connection open for two minutes on an unreachable strand. Worth confirming I did not miss a path.
- **Whether the claim in the RN doc about `joinClosedChatStrand` is right.** I wrote that the chat screens re-render on `strand:writable` (they do — `use-cadre.ts:327`) but that `joinClosedChatStrand` writes the joiner's app-level role right after `addStrand` resolves, so a timed-out join must be retried before that role exists. That is read from `packages/reference-app-rn/src/chat-strand.ts`; check the reading.
- **The numbers I copied.** I did not re-measure. Every figure in the new comments comes from the implement ticket's measurement section, reproduced with its date, machine and link condition. If a reviewer wants them re-derived, the recipe is in `2-declare-cohort-read-deadline-for-relayed-phones` ("How to re-measure") — there is no committed instrument for this shape.
- **Whether `docs/testing.md` → "Where measurements live" should carry this band.** I left that file alone: the sibling ticket explicitly owns the measurement home for this link condition, and editing it here would collide. If the reviewer thinks the first-sync band belongs there independently of the sibling, that is a one-line addition, not a rework.

## Use cases this should be validated against

- A phone joining a closed strand through a relay on a link with a round trip of a couple of seconds: `addStrand` resolves without the app having to retry, where before it often rejected at 30 s and the app re-called.
- A strand no member of which is reachable at all: still rejects with `StrandAwaitingFirstSyncError`, still retryable, still leaves the launch probing — just after two minutes. This is the case that got slower, and it is the intended trade.
- A restart, a hibernation resume, or a founder: never gated, so unaffected by the value entirely.
- An app that listens for `strand:writable` instead of awaiting the call: unaffected either way, before and after.
