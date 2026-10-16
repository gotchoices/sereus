description: Founding a strand used to make the app wait several seconds for the strand to start before it could make an invitation. There is now an opt-in form of the founding call that returns right after the strand is published and finishes starting it in the background, and both reference apps use it when making an invitation (GitHub #49).
architecture: docs/architecture.md
files: packages/cadre-core/src/cadre-node.ts (`foundStrand` overloads, `publishFoundingRow`, `attachFoundingRow`), packages/cadre-core/src/types.ts (`FoundStrandOptions`, `FoundStrandBackgroundResult`), packages/cadre-core/test/publish-strand.spec.ts, packages/reference-app-rn/src/chat-strand.ts (`createClosedChatStrand`, `CreateClosedStrandResult`), packages/reference-app-rn/test/chat-strand.spec.ts, packages/reference-app-rn/test/solo-founding.spec.ts, packages/reference-app-rn/README.md, packages/reference-app-web/src/lib/cadre-web.ts (`createClosedChatStrand`, `createInvitation`), packages/reference-app-web/e2e/fixtures/formation-responder.ts (comment only), packages/reference-app-web/README.md, docs/architecture.md, docs/reference-app-rn.md
----

# `foundStrand` can return after the publish

## What was built

`CadreNode.foundStrand(config, { background: true })` resolves with `{ strandRow, founded, ready }` as soon as the `Strand` row is published (or adopted); the local start (`addStrand`) continues in `ready: Promise<StrandInstance>`. The one-argument call is unchanged and keeps its `FoundStrandResult` type through overloads.

- `publishFoundingRow(config)` holds every check that can refuse the founding (node started, blank id, type mismatch, publish/adopt, `founded` derivation). Both forms await it, so publish errors reject the call itself and never reach `ready`.
- `attachFoundingRow(published, config)` is the timed `addStrand`. Its timing lines are logged when the start settles, also in the background form; `[foundStrand:<id>] total` covers only what the caller waited for.
- The background branch attaches a logging-only `.catch` to `ready` (no unhandled rejection for a caller that ignores it) and returns the original promise, so callers still see the rejection.
- A failed launch inside `addStrand` hands the strand to `StrandWatcher.forgetStrand`, so the watcher retries it on its backoff; a first-sync timeout leaves the instance up.

Reference apps: the web and RN `createClosedChatStrand` both use the background form. RN's `CreateClosedStrandResult` is now `{ strandId, memberPrivateKey, ready }`, where `ready` also covers the owner-role write. Open-strand create paths and the web e2e responder fixture keep the default form because they need the instance.

A joiner that redeems the invitation before the host's closed strand is running gets the retryable `host-strand-unavailable` and the token stays unspent; `requestJoin` retries it, `formStrand` throws it to the caller.

Docs: docs/architecture.md ("Returning after the publish" under the founding entry point; "Host strand still starting" under which machines an invitation names), docs/reference-app-rn.md ("Tracing a strand founding"), both app READMEs.

## Review findings

Read the `ticket(implement): found-strand-returns-after-publish` diff first, then checked each claim it makes against the code.

- **Correctness, core.** Verified that both forms reject on publish errors before returning, that the background `ready` has a handler attached synchronously, and that `addStrand` still registers the sApp config synchronously before its first await, so the window where the `StrandWatcher` could race the founder's own `addStrand` is the same as in the default form. Verified the doc claim that a failed launch is retried: `addStrand`'s catch calls `StrandWatcher.forgetStrand` (`cadre-node.ts` ~5728). Verified `host-strand-unavailable` is retryable (`FORMATION_REJECTION_RETRYABLE`), is returned both when the bound strand is missing and when issuing the membership invite throws (`strand-formation-manager.ts` ~525, ~619), and that the pending-join runner only stops on non-retryable refusals. No defects found.
- **Fixed inline — misleading log line.** The core's background `.catch` said "the watcher retries it" for every failure, which is wrong for a first-sync timeout (the instance stays up, nothing is retried). Reworded to "background start did not complete; the strand stays published".
- **Fixed inline — stale docs.** `packages/reference-app-rn/README.md` still showed the one-argument `foundStrand` call and said it "attaches as founder"; updated to the background form and added that a join made while the host strand is starting is refused retryably and should be retried. The web `createInvitation` docstring's step 1 still said it attaches the local instance; updated to say the start runs in the background. The implement pass had missed the RN README.
- **Callers.** Grepped every use of `createClosedChatStrand` and `CreateClosedStrandResult`: only `use-cadre.ts` (ignores the result; it selects the strand at once, and `refreshStrands` runs again on `strand:started`, so the UI picks the instance up when it arrives) and the tests. No web e2e or Maestro flow redeems an invitation the app under test just made, so none can now hit the retryable refusal.
- **RN owner-role ordering and the failed-start case.** Already recorded by the implementer as an accepted-tradeoff `NOTE:` at the `ready.then` site in `chat-strand.ts`; `Participant.Role` is display-only. Left as is.
- **RN joiner UX.** The RN joiner shows `host-strand-unavailable` as an ordinary alert. Not filed: the README now tells the user to retry, and the refusal leaves the token unspent. No tripwire added beyond that, since the condition is "users find it confusing in practice", which a device run will show.
- **Tests.** The new core test fails a real start (sApp schema changed after signing) with no mocks and fails against the old code; kept. The RN `chat-strand.spec` assertion on `{ background: true }` is close to a wiring check, but it is a one-line update of an existing test that pins which form the app uses; kept. `solo-founding.spec` still checks an active instance and the owner-role write under the deadline. No tests added or cut.
- **Hygiene, types, resource cleanup.** Overloads keep the default form's type exact; `FoundStrandOptions.background` is the literal `true`, so there is no ambiguous `false` form. No new resources are held. No file-size concern introduced (the change is a split of one method into two).
- **Not done here.** No device or two-tab browser run, so the tap-to-invitation time is not re-measured; that needs a human with a device.

Runs after the review edits, all green: `yarn workspace @serfab/cadre-core build`, `yarn workspace @serfab/cadre-core vitest run test/publish-strand.spec.ts` (41 passed), `yarn lint`, `yarn workspace @serfab/reference-app-rn test` (174 passed), `yarn workspace @serfab/reference-app-web test` (22 passed), `yarn workspace @serfab/reference-app-web typecheck`. The full cadre-core suite was not re-run; the only core source change in review is a log string, and the implement pass ran it green.
