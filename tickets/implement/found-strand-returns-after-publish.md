description: Founding a strand makes the app wait several seconds for the strand to start, although an invitation can be made as soon as the strand is published. Add an opt-in form of the founding call that returns right after the publish and finishes starting the strand in the background, and use it in the reference apps' "make an invitation" path (GitHub #49).
architecture: docs/architecture.md
files: packages/cadre-core/src/cadre-node.ts (`foundStrand` ~5954-5988, `addStrand` ~5655, `whenStrandWritable` ~5757, `issueStrandMembershipInvite` ~9980-10020), packages/cadre-core/src/types.ts (`FoundStrandConfig` ~1450, `FoundStrandResult` ~1475-1500), packages/cadre-core/test/publish-strand.spec.ts (`CadreNode.foundStrand` describe ~434), packages/reference-app-rn/src/chat-strand.ts (`createClosedChatStrand` ~145-169, `assignLocalParticipantRole` ~246), packages/reference-app-rn/src/use-cadre.ts (`createClosedStrandWithInvite` ~767-791), packages/reference-app-web/src/lib/cadre-web.ts (`createClosedChatStrand` ~799-817, `createInvitation` ~837-870), docs/architecture.md (founding "Entry point" bullet ~1387; "Which machines an invitation names" ~1345-1355)
----

# `foundStrand` can return after the publish

## Why

kjeib (gotchoices/sereus#49) measured `foundStrand` at 751 ms on Node through relay.sereus.org. The publish took 103 ms. The rest was starting the strand: seed lookup 95 ms, database initialize 159 ms, first relay attempts 375 ms. On a Galaxy S7 the whole call takes 4-5 s. Sereus Chat cut tap-to-invitation from 4.0-4.7 s to 0.40-0.43 s by founding early at app level.

The strand exists durably once `publishStrand` commits. Minting an invitation needs only the strand id and the membership key, both on the returned row. Facts verified at 70b2dc1d:

- **A failed start is recoverable.** After the publish, a failed `addStrand` leaves a published strand that is not running. `addStrand` hands it back to the strand watcher (`StrandWatcher.forgetStrand`), which relaunches it on its backoff ladder. A later `addStrand` or `foundStrand` re-attaches, and founder status comes from the row's `FounderPeerId`.
- **Minting an invitation needs no running strand.** `createOpenInvitation` and `publishFormationInvite` touch only the control database.
- **Redeeming one does.** For a closed host strand, `issueStrandMembershipInvite` needs the live strand database. Until it exists, it throws "runtime is not live on this responder (not launched, or still starting)". The formation manager maps that to `host-strand-unavailable`, which `FORMATION_REJECTION_RETRYABLE` marks retryable. The token is not spent.
- **Who retries that refusal.** `CadreNode.formStrand` makes one attempt per machine the invitation names. It moves to the next machine on a retryable refusal, and when every machine refuses it throws the last retryable `FormationRejectedError` to its caller. It does not retry the same machine. `CadreNode.requestJoin`, through `PendingJoinRunner`, retries retryable refusals on its backoff until the request expires. So a `requestJoin` joiner waits through the start-up on its own, and a `formStrand` caller gets a retryable error and must try again.

Approved by the maintainer on 2026-10-15: the opt-in `{ background: true }` form, as replied on #49.

## Interface

```ts
// types.ts
/** What {@link CadreNode.foundStrand} returns with `{ background: true }`: the row is published; the local start continues. */
export interface FoundStrandBackgroundResult {
  /** The live control-plane row: freshly published, or the one already there. Same as FoundStrandResult.strandRow. */
  strandRow: StrandRow;
  /** Same as FoundStrandResult.founded. */
  founded: boolean;
  /**
   * Settles when the local start does. Resolves with the instance `addStrand` returns.
   * Rejects with the start's own error. After a launch failure the strand stays published
   * and the strand watcher keeps retrying it. After a first-sync timeout (only an adopted,
   * not-founded row waits for one) the instance stays up and still syncing, so wait with
   * `whenStrandWritable`.
   */
  ready: Promise<StrandInstance>;
}

export interface FoundStrandOptions {
  /** Return once the row is published; the start continues in `ready`. */
  background: true;
}

// cadre-node.ts: overloads, so the existing call keeps its type
foundStrand(config: FoundStrandConfig): Promise<FoundStrandResult>;
foundStrand(config: FoundStrandConfig, options: FoundStrandOptions): Promise<FoundStrandBackgroundResult>;
```

### Implementation shape

Split today's body into two private steps:

- **`publishFoundingRow(config)`** does the started-check, id trim, `queryStrand`, adopt or `publishStrand`, and the `founded` derivation and its log. It returns `{ strandId, strandRow, founded }`. Everything in it stays awaited before either form returns, so publish errors (type mismatch, blank id, unauthorized insert) still reject the `foundStrand` call itself and never reach `ready`.
- **`attachFoundingRow(published, config)`** runs the timed `addStrand({ strandRow, sAppConfig, founder: founded, awaitFirstSync })` and logs the start time.

`foundStrand` then has two branches. The default form awaits the attach and returns `{ instance, strandRow, founded }` as today. The background form starts the attach and returns `{ strandRow, founded, ready }` straight away.

In the background form, attach a handler to `ready` that only logs (`log('foundStrand(%s): background start failed; the strand stays published and the watcher retries it: %o', …)`). Without it, a caller that ignores `ready` gets an unhandled rejection. Return the original promise, not the `.catch` chain, so the caller still sees the rejection.

Timing: the `[foundStrand:<id>] total` line covers what the caller waited for. In the background form, also log the start time when `ready` settles, because `docs/reference-app-rn.md` ~1203 tells readers to find a hung step by a start line with no end line, and that has to keep working.

## Reference apps

Both apps' "make an invitation" path switches to the background form. Their "create an open chat strand" path (`createChatStrand`, RN `createStrand`) stays on the default form, because it returns the instance to the UI.

- **Web `createClosedChatStrand` (cadre-web.ts).** It already uses only `strandRow`. Pass `{ background: true }`, then attach a `ready` handler that logs a start failure with `console.warn`. Do not throw from it: the watcher retries, and the invitation is still valid. Keep `openStores([strandId])` before the call, because the start opens the store synchronously.
- **RN `createClosedChatStrand` (chat-strand.ts).** Use the background form, check `strandRow.MemberPrivateKey` as now, and chain the owner-role write onto `ready`: `ready.then((instance) => assignLocalParticipantRole(cadreNode, instance, 'owner'))`. Add a `.catch` that warns. The role write is already best-effort (it warns on failure), and the chat schema's `Participant.Role` is display-only. Change `CreateClosedStrandResult` to `{ strandId, memberPrivateKey, ready }`, dropping `instance`. Only `use-cadre.ts` calls it, and it ignores the result. Update the doc comment, which now says the function "starts the instance, and assigns the creator the app-level owner role" before returning.
- **RN `createClosedStrandWithInvite` (use-cadre.ts).** No change in shape. `setSelectedStrandId(strandId)` before the strand runs is already handled: `pickActiveStrandId` falls back while the id is absent, and the `strand:started` listener calls `refreshStrands()` when it appears.

## Docs

- **architecture.md, founding "Entry point" bullet (~1387).** Add a labelled sub-bullet, "Returning after the publish". `foundStrand(config, { background: true })` returns once the row is published, with the start in `ready`. Say what each settled state of `ready` means: a launch failure leaves the strand published with the watcher retrying it, and a first-sync timeout leaves the instance syncing. Name `whenStrandWritable` for "wait until usable". Give the reason: an invitation needs only the row's id and key.
- **architecture.md, "Which machines an invitation names" (~1345-1355).** Add a line next to the "Next machine" bullet. An invitation minted before its closed host strand is running is answered `host-strand-unavailable`, which is retryable and leaves the token unspent. `formStrand` throws that to its caller after trying every machine. `requestJoin` retries it on its backoff.
- **docs/reference-app-rn.md.** If it describes the invite path's timing or the `foundStrand` timing lines in a way the background form changes, update that passage. Grep for `createClosedStrandWithInvite` and `foundStrand`.

## Edge cases & interactions

- **Publish fails** (blank id, type mismatch with a stored row, not an enrolled owner, node not started). The `foundStrand` call itself rejects in both forms, and no `ready` exists. *Inspection:* every check sits in `publishFoundingRow`, which is awaited before the branch.
- **Start fails after the publish.** `ready` rejects with `addStrand`'s error. `addStrand`'s catch has already called `strandWatcher.forgetStrand`, and the node emits `strand:error` per failed retry and `strand:started` on success. *Test (below).*
- **A caller that ignores `ready`.** No unhandled rejection. *Inspection:* the logging handler is attached before return.
- **Node stops while the start is in flight.** `ready` rejects with whatever `addStrand` or `launchStrand` throws on a stopping node, and the handler logs it. This is the same race a stop during today's awaited `foundStrand` has, so there is nothing new to guard. *Inspection.*
- **`stopStrand(id)` during the start.** Same as a stop racing a plain `addStrand` today. Do not add handling. *Inspection.*
- **Second `foundStrand` or `addStrand` of the same id during the start.** The second call adopts the published row, and its attach finds the strand mid-launch and resolves once that launch has built it. The existing test "an attach that finds the strand mid-launch resolves only once that launch has built it" (publish-strand.spec.ts ~631) covers this. *No new test.*
- **Strand watcher sees the published row before the background attach runs.** This is the existing publish-then-attach race: the watcher may launch a storage replica, and the claim upgrades it in place (`attachSApp`) and founds it. The background form does not widen the window, since the attach starts on the same tick it does today. *Inspection.*
- **Adopted row from a sibling** (`founded: false`). `ready` honours `awaitFirstSync`. With the default `true`, it may reject with `StrandAwaitingFirstSyncError` while the instance stays up. The `FoundStrandBackgroundResult.ready` doc states this. *Type doc plus inspection.*
- **Joiner redeems during the host's start.** It gets the retryable `host-strand-unavailable` and the token stays unspent. *Covered by `cadre-node-issue-membership-invite.spec.ts` ("closed strand whose runtime is not live → throws") and the rejection table. No new test.*
- **Open host strand redeemed during the start.** An open strand's formation needs no membership invite, but the approval's `strandAddrs` comes from `getStrandMultiaddrs`, which is `[]` until the strand node exists. Neither reference app binds an invitation to an open strand, so this ticket changes nothing for open strands. Note it in the `FoundStrandOptions` doc: an approval sent before the start finishes carries no strand addresses.
- **RN owner role when the start fails.** The role is not written. A start the watcher later completes does not write it either. Accepted: the role is display-only and already best-effort. Put a `NOTE: accepted tradeoff` comment at the `ready.then` site with the revisit condition "if `Participant.Role` ever gates anything".

## Tests

One new test, in `publish-strand.spec.ts` under the `CadreNode.foundStrand` describe. It pins the background form's contract on a start failure:

- Make the attach fail after the publish. Use a seam the file already uses, or the cheapest real failure, such as a closed strand whose founder bootstrap rejects for want of a party key. Do not mock a module this repository owns.
- Expect `foundStrand(…, { background: true })` to resolve with `strandRow` and `founded: true`, and `ready` to reject with the start's error.
- Expect `controlDatabase.queryStrand(id)` to still return the row.

Do not add a test that the default form is unchanged: the existing `foundStrand` tests cover it. Do not add a happy-path background test either, because it would repeat the existing open-strand founding test with an extra `await ready`. Fold an `await ready` happy-path assertion into this test only if the failure seam makes that free.

## TODO

- Add `FoundStrandOptions` and `FoundStrandBackgroundResult` to `types.ts` (`index.ts` already re-exports all of `types.ts`).
- Split `foundStrand` into `publishFoundingRow` and `attachFoundingRow`. Add the overloads and the background branch with its logging handler and start-time log. Extend the `foundStrand` JSDoc with the background form and the retryable redemption behaviour.
- Switch web `createClosedChatStrand` to the background form, with a warning-only `ready` handler.
- Switch RN `createClosedChatStrand` to the background form. Chain the owner role onto `ready`, add the accepted-tradeoff `NOTE:`, change `CreateClosedStrandResult`, and update the doc comments.
- Add the one test in `publish-strand.spec.ts`.
- Update `docs/architecture.md` (both places) and, if affected, `docs/reference-app-rn.md`.
- Run `yarn workspace @serfab/cadre-core test` (or the spec file alone), `yarn lint`, and typecheck the two reference apps.
