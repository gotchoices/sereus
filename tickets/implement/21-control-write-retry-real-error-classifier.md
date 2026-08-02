----
description: Tighten the party-write retry so it never re-runs a write whose final commit outcome is unknown, and prove its error classifier against real engine errors instead of copied message strings.
files: packages/cadre-core/src/control-write-retry.ts, packages/cadre-core/test/control-write-retry.spec.ts, packages/cadre-core/test/control-formation-use-number-retry.spec.ts
difficulty: medium
----

# Narrow the control-write retry's transactor pattern; real-error classifier coverage

Split from `control-write-retry-real-error-coverage` (two agent runs both hit the token
budget before code landed). This half needs no network and no integration-scenario boot;
the other half — `control-write-retry-scenario-coverage` — is gated on scenario boot
defects and carries the runtime measurements.

`isRetriableControlWriteFailure` (`packages/cadre-core/src/control-write-retry.ts`)
decides whether a failed control write is re-presented to the cluster. It classifies by
error message text. Two problems this ticket closes:

1. Its first pattern, `Some peers did not complete:`, also matches a COMMIT-PHASE
   failure, which is not safe to retry (analysis below — already done, do not redo it).
2. Its spec (`control-write-retry.spec.ts`) asserts against message literals only, so an
   upstream rewording would silently disable the retry. The codebase's answer is to
   produce the messages from the real engine
   (`control-formation-use-number-retry.spec.ts` is the precedent). The messages
   producible WITHOUT a network get that treatment here; the network-only ones are the
   scenario ticket's arm.

## The commit-phase question — SETTLED (static trace, 2026-08-01)

Question (raised by the review of `control-write-transient-failure-retry`): optimystic's
network transactor raises `Some peers did not complete:` from three places — the block
read path (`get`), phase 1 (`pend`), and phase 2 (`commitBlocks`). The first two are safe
to re-present. Can the commit-phase one reach `ControlDatabase`, and is retrying it safe?

Answer: **reachable, and NOT safe to retry.** The trace (paths under
`../optimystic/packages/db-core/src`):

- `NetworkTransactor.commitBlocks` (`transactor/network-transactor.ts:687-723`) never
  throws its aggregate — it returns `{ batches, error }`. Its three callers:
  - `commit()`'s non-tail remainder (`:652-659`): error logged and swallowed
    ("non-tail commit had errors; proceeding after tail commit"). Never propagates.
  - `commitBlock()` — the header and tail commits (`:635`, `:642` → `:665-684`): when at
    least one batch carries an explicit success:false RESPONSE, it returns
    `{ success: false, missing }` (no throw). When the failure is pure NO-RESPONSE
    (stream reset, dial timeout — exactly the transient class the retry targets), it
    throws the aggregate at `:681`. So the aggregate escapes `commit()` whenever a
    header/tail commit got no answer at all.
- `TransactorSource.transact` (`transactor/transactor-source.ts:121-124`) catches,
  issues `cancel`, and rethrows unchanged. `cancel` cancels PENDING actions only — a
  cluster peer that already committed stays committed.
- `Collection.syncInternal` (`collection/collection.ts:397`) retries only StaleFailure
  RETURN values; a `transact` THROW propagates uncaught out of `sync`/`updateAndSync`
  (the latch is released in a finally).
- So the commit-phase aggregate reaches `ControlDatabase`'s write funnel,
  QuereusError-wrapped like every other transactor error.

Why retrying it is unsafe: the tail commit is a single batch to one coordinator, which
runs the cluster consensus internally. A no-response failure there is INDETERMINATE — the
coordinator may have completed the commit and only the response was lost. Re-running the
write body over a write that actually landed turns a success into a constraint failure
(e.g. `UNIQUE constraint failed: CadrePeer.PeerId`). Not retrying is the safe choice: the
caller sees the transient error and can re-read committed state.

The `cause` chain does NOT discriminate the phases — a commit-phase aggregate's cause is
the same stream-reset/dial error a pend-phase one carries. The message text DOES: the
three sites format their per-batch detail entries differently —

- `get` (`:238-241`) and `pend` (`:520-522`) emit `<peerId>[block:<id>](<status>)` —
  singular `[block:`;
- `commitBlocks` (`:711-715`) emits `<peerId>[blocks:<count>](<status>)` — plural
  `[blocks:`.

`[block:` (colon included) cannot match inside `[blocks:`, so the token separates the
safe phases from the unsafe one. Secondary signal if wanted: only the pend site attaches
an `errors` array to its aggregate (`:530`); get and commit do not — it confirms pend but
cannot separate get from commit, so the token is the discriminator that covers get too.

## TODO

- Narrow the first entry of `RETRIABLE_CONTROL_WRITE_PATTERNS`: a
  `Some peers did not complete:` aggregate is retriable only when its details carry
  `[block:` and not `[blocks:`. A small predicate reads better than one regex. The
  `root: <cause message>` suffix could in principle contain either token — decide and
  document how a mixed match is treated; treating ANY `[blocks:` occurrence as
  non-retriable is the conservative choice. An aggregate with EMPTY details (edge case
  in `formatBatchStatuses`) carries neither token and should classify non-retriable.
- Rewrite the pattern's doc comment and DELETE the NOTE block at
  `control-write-retry.ts:68-76` — the question is settled; the comment should state the
  answer and the discriminator, not the open question. The classifier doc NOTE at
  `:108-111` (pointing at the follow-up ticket) also needs re-aiming at the two
  continuation tickets.
- Spec (`control-write-retry.spec.ts`): the `TRANSACTOR_AGGREGATE` literal carries no
  `[block:` token, so it goes RED the moment the pattern narrows — that proves the
  narrowing bites. Update it to the real get/pend shape, and add a commit-shaped literal
  (`[blocks:`) asserted NON-retriable. Keep the disjointness cases green.
- Real-error coverage, the part producible without a network. Put it beside the
  precedent in `control-formation-use-number-retry.spec.ts` (or a sibling spec — that
  suite already boots a single `CadreNode` and captures real engine errors):
  - negative half: a REAL engine constraint error classifies as NOT retriable —
    `realLostRaceError()` and the `Authorized` CHECK capture in that spec are ready-made
    producers; also assert disjointness with `isLostUseNumberRace` against those real
    objects, not literals.
  - the retriable messages (transactor aggregate, super-majority shortfall) cannot be
    produced without a real multi-node cluster — that is
    `control-write-retry-scenario-coverage`'s arm. Say so in a spec comment; do not fake
    them with literals presented as real.
- Validate from `packages/cadre-core`, streaming output:
  `yarn vitest run test/control-write-retry.spec.ts test/control-formation-use-number-retry.spec.ts 2>&1 | tee /tmp/retry-specs.log`
  plus root `yarn lint` and the package typecheck.
