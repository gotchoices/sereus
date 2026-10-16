description: Founding a strand used to make the app wait several seconds for the strand to start before it could make an invitation. There is now an opt-in form of the founding call that returns right after the strand is published and finishes starting it in the background, and both reference apps use it when making an invitation (GitHub #49).
architecture: docs/architecture.md
files: packages/cadre-core/src/cadre-node.ts (`foundStrand` overloads, `publishFoundingRow`, `attachFoundingRow`), packages/cadre-core/src/types.ts (`FoundStrandOptions`, `FoundStrandBackgroundResult`), packages/cadre-core/test/publish-strand.spec.ts (new test in the `CadreNode.foundStrand` describe), packages/reference-app-rn/src/chat-strand.ts (`createClosedChatStrand`, `CreateClosedStrandResult`), packages/reference-app-rn/test/chat-strand.spec.ts, packages/reference-app-rn/test/solo-founding.spec.ts, packages/reference-app-web/src/lib/cadre-web.ts (`createClosedChatStrand`), packages/reference-app-web/e2e/fixtures/formation-responder.ts (comment only), packages/reference-app-web/README.md, docs/architecture.md, docs/reference-app-rn.md
----

# `foundStrand` can return after the publish

## What was built

`CadreNode.foundStrand(config, { background: true })` resolves with `{ strandRow, founded, ready }` as soon as the `Strand` row is published (or adopted). The local start (`addStrand`) continues in `ready: Promise<StrandInstance>`. The one-argument call is unchanged and keeps its `FoundStrandResult` type through overloads.

- `publishFoundingRow(config)` holds every check that can refuse the founding (node started, blank id, type mismatch, publish/adopt, `founded` derivation). Both forms await it before returning, so publish errors reject the call itself and never reach `ready`.
- `attachFoundingRow(published, config)` is the timed `addStrand`. Because it runs through `timedStep`, its `[foundStrand:<id>] addStrand: start` / `<n>ms` / `failed after` lines are logged when the start settles, also in the background form. `[foundStrand:<id>] total` covers what the caller waited for (only the publish, in the background form).
- The background branch attaches a logging-only `.catch` to `ready` (so a caller that ignores `ready` gets no unhandled rejection) and returns the original promise, so callers still see the rejection.

Reference apps:

- **Web `createClosedChatStrand`** passes `{ background: true }` and attaches a `console.warn` handler to `ready`. `openStores([strandId])` stays before the call.
- **RN `createClosedChatStrand`** uses the background form. `CreateClosedStrandResult` is now `{ strandId, memberPrivateKey, ready }`. Its `ready` is the core `ready` chained with the owner-role write, so it settles after both; a `.catch` warns `[chat-strand] closed strand <id> did not start; no owner role was written:`. `use-cadre.ts` (`createClosedStrandWithInvite`) is unchanged; it ignores the result.
- The open-strand create paths and the web e2e responder fixture stay on the default form, because they need the instance.

Docs: architecture.md gains the "Returning after the publish" sub-bullet under the founding "Entry point" bullet, and a "Host strand still starting" bullet beside "Next machine" in "Which machines an invitation names". docs/reference-app-rn.md's "Tracing a strand founding" says the closed-strand button now succeeds before the start finishes and which timing lines follow. The web README's formation steps say the host strand starts in the background and that a too-early *Form strand* gets the retryable `host-strand-unavailable`.

## Tests

- **Added** `publish-strand.spec.ts` → "background form: resolves once published; a failed start rejects only `ready` and the row stays". The failure is real, with no mock: an sApp config whose schema was changed after signing. The publish never reads the sApp, and `startStrand`'s signature check refuses it after the row commits. The test asserts `founded: true`, that `ready` rejects with the schema-verification error, and that `queryStrand` still returns the row afterwards. It fails against the old code, because the old one-argument body awaited the start and so rejected the whole call. No happy-path background test was added (per the ticket).
- **Updated** RN `chat-strand.spec.ts`: the stub's `foundStrand` now answers both forms, and the closed-strand case asserts the call passes `{ background: true }`.
- **Updated** RN `solo-founding.spec.ts`: the closed-strand case awaits `created.ready` inside the same deadline, so it still checks an active instance and no `[chat-strand]` warnings (that is, the owner role was written).

Runs, all green: `yarn workspace @serfab/cadre-core test` (181 files, 2503 passed, 1 skipped), `yarn workspace @serfab/reference-app-rn test` (174 passed), `yarn workspace @serfab/reference-app-web test` (22 passed), `yarn lint`, and typecheck of cadre-core, reference-app-rn (its tsconfig covers its tests), reference-app-web (`typecheck` and `typecheck:e2e`), cadre-rn and integration-tests. cadre-core was rebuilt (`yarn workspace @serfab/cadre-core build`) so the apps see the new types.

## Known gaps / for the reviewer

- **Not run on a device or in a browser.** No Maestro flow or two-tab web formation was run, so the 0.4 s tap-to-invitation figure is not re-measured here. Worth a device run of **Create Closed Strand + Invite** followed immediately by a join from a second device. The join should either succeed or get a retryable refusal that succeeds when tried again.
- **RN owner-role ordering.** Before this change the owner role was written before `use-cadre` selected the strand. Now it is written after the start resolves, and `useChat`'s default-`member` `insert or ignore` (`use-chat.ts` ~111) runs once the selected strand has a database. The owner insert is started in the microtasks right after `ready` resolves, ahead of any React re-render, so it should normally land first. Nothing enforces that, though. Recorded in the accepted-tradeoff `NOTE:` at the `ready.then` site in `chat-strand.ts`, together with the "failed start writes no role" case. The role is display-only.
- **The RN joiner's `joinViaInvite` uses `formStrand`.** A joiner that redeems while the host strand is still starting gets the retryable `FormationRejectedError` (`host-strand-unavailable`) as an alert, and must tap Join again. The token is not spent. The RN UI does not distinguish this refusal from others. If that shows up as confusing in practice, it is a UI follow-up (or the RN joiner could move to `requestJoin`), not part of this ticket.
- The `FoundStrandOptions` doc states that an open host strand redeemed before the start finishes gets an approval with no strand addresses. Neither reference app binds an invitation to an open strand, so nothing changed for open strands.
