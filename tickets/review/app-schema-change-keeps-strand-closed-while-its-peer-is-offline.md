description: After an app changed its schema, even by one column tag, an existing strand did not open while its other member was offline (`addStrand` failed with `PromiseShortfallError`). The connect-time `App` apply now defers a refusal Optimystic classifies as `cohort-unreachable`, as it already deferred one refused by queued offline transactions; the strand opens on its earlier schema and the apply is retried when the strand node connects to a peer, or on a backoff. cadre-core reports the new `waiting-for-cohort` state on every node, offline mode or not.
architecture: docs/strands.md#an-app-schema-upgrade-waits-for-the-queue-or-the-cohort
files: packages/quereus-plugin-sereus/src/app-schema.ts, packages/quereus-plugin-sereus/src/compose-strand.ts, packages/quereus-plugin-sereus/src/types.ts, packages/quereus-plugin-sereus/src/index.ts, packages/quereus-plugin-sereus/test/app-schema-deferral.spec.ts, packages/quereus-plugin-sereus/README.md, packages/cadre-core/src/strand-app-schema-report.ts (new), packages/cadre-core/src/strand-offline.ts, packages/cadre-core/src/strand-database.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/index.ts, packages/integration-tests/src/scenarios/strand-app-schema-change-while-partner-offline.integration.ts (new), packages/integration-tests/src/harness/strand-restart-party.ts, packages/integration-tests/src/harness/fixtures/strand-restart-party.mjs, docs/strands.md, .release-notes.pending.md
repro: verified
----
# An app schema change no longer keeps a strand closed while its peer is offline

GitHub gotchoices/sereus#55. Fix and implement were done in one pass, during the Optimystic 1.23.0 adoption.

## Reproduction

`strand-app-schema-change-while-partner-offline.integration.ts`: A founds a closed strand on v1, B forms it, each writes a row; A exits; B restarts and claims with v2 (one column tag added). Before the fix, on Optimystic 1.23.0 / Quereus 4.22.0, B's claim failed after about 4 s with `PromiseShortfallError: Failed to get super-majority: 1/2 approvals (needed 2, 0 rejections)` (`tickets/.logs/app-schema-55.repro.log`, offline-off arm). The error reached `applyAppSchema` bare, not wrapped. A tag-only change does write the strand's catalog, which is why it needs the cohort.

After the fix, both arms (offline mode off and on) pass: B's claim is `active` after about 5.6 s (one refused apply), `appSchemaState()` is `waiting-for-cohort`, both rows read back, and once A is back B's apply lands 1.5–2 s after A's strand is active (`tickets/.logs/app-schema-55.fixed.log`).

## What changed

- **quereus-plugin-sereus `applyAppSchemaOrDefer`** (was `applyAppSchemaAfterQueue`; not exported from the package index). `deferralOf(err)` walks the `cause` chain for `QueuedEntriesBlockSchemaChangeError` (wait `queue`) or anything `classifyCommitFailure` sorts as `cohort-unreachable` (wait `cohort`). The retry loop waits per the last refusal: the queue's `whenDrained()`, or the strand node's next `peer:connect` plus a 2 s settle, else a backoff of 15/30/60/120 s then 300 s. `composeStrand` passes the libp2p node it resolved (`peers`), absent only on the unit-test transactor. The result gains `appSchemaWaitingFor`.
- **cadre-core `StrandAppSchemaReport`** (new file), split out of `StrandOfflineReport`, which now reports only the queue. `StrandDatabase` builds it on every connect, from a new `appSchema` listeners config that `StrandInstanceManager` forwards from `StartStrandConfig.appSchema` and `CadreNode` always passes; before, the app-schema events existed only with `strandOffline` configured. `StrandAppSchemaState` gains `'waiting-for-cohort'`; `StrandAppSchemaDeferred` gains `waitingFor`.
- **Docs:** docs/strands.md has a new top-level section "An app schema upgrade waits for the queue or the cohort"; the Offline mode subsection now links to it. Release notes: Fixes and Changed.

## Tests

- **Added:** the integration scenario above, two arms. It is the bug's reproduction; no lower layer reproduces a cohort-unreachable apply without a real second member.
- **Changed:** `app-schema-deferral.spec.ts` follows the rename and asserts `appSchemaWaitingFor: 'queue'`.
- **Harness:** `strand-restart-party` gains an `appSchemaState` request.

## For the reviewer

- **The state names the first refusal.** A retry refused for the other reason (queue, then cohort) keeps the first `waiting-for-*` state and emits no new event. Documented; decide whether an event per change is worth it.
- **Every `peer:connect` wakes a cohort retry**, including the relay's. A refused attempt costs one commit's wait for the cohort (about 4 s here). Not measured on a phone.
- **`attachAppSchema` (a running replica claimed by an app) is not deferred**, and the claim fails while the cohort is unreachable; the replica's next rebuild applies it through the connect path. Documented in strands.md. It interacts with backlog `bug-refused-app-schema-kept-for-strand-resume` (that one is about schemas refused for good).
- **No unit test for the cohort retry trigger.** The integration arms cover connect-woken retries; the backoff path (no connect) was not exercised.
- Not yet run: the whole integration suite with this change (the unit suites and lint/typecheck were run; see the release-prep commit).
- **Reply on gotchoices/sereus#55** once released (a human posts it).
