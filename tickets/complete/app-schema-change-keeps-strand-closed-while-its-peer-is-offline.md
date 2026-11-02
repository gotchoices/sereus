description: After an app changed its schema, even by one column tag, an existing strand did not open while its other member was offline (`addStrand` failed with `PromiseShortfallError`). The strand now opens and the apply is retried, and cadre-core reports the new `waiting-for-cohort` state on every node. Review found the reported state can be wrong, tracked in a blocked ticket.
architecture: docs/strands.md#an-app-schema-upgrade-waits-for-the-queue-or-the-cohort
files: packages/quereus-plugin-sereus/src/app-schema.ts, packages/quereus-plugin-sereus/src/compose-strand.ts, packages/quereus-plugin-sereus/src/types.ts, packages/quereus-plugin-sereus/src/index.ts, packages/quereus-plugin-sereus/test/app-schema-deferral.spec.ts, packages/quereus-plugin-sereus/README.md, packages/cadre-core/src/strand-app-schema-report.ts, packages/cadre-core/src/strand-offline.ts, packages/cadre-core/src/strand-database.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/index.ts, packages/integration-tests/src/scenarios/strand-app-schema-change-while-partner-offline.integration.ts, packages/integration-tests/src/harness/strand-restart-party.ts, packages/integration-tests/src/harness/fixtures/strand-restart-party.mjs, docs/strands.md, docs/architecture.md, .release-notes.pending.md
repro: verified
----
# An app schema change no longer keeps a strand closed while its peer is offline

GitHub gotchoices/sereus#55. Fix and implement were done in one pass during the Optimystic 1.23.0 adoption (commit subject `fix: an app schema change no longer keeps a strand closed while its peer is offline (#55)`), and shipped in v1.20.0.

## What was built

- **quereus-plugin-sereus `applyAppSchemaOrDefer`:** a connect-time `App` apply refused by queued offline transactions, or classified `cohort-unreachable`, no longer fails the connect. It is retried when the queue drains, or on the strand node's next `peer:connect` plus a 2 s settle, else on a 15 s to 5 min backoff. The result gains `appSchemaWaitingFor`.
- **cadre-core `StrandAppSchemaReport`:** split out of `StrandOfflineReport` and built on every connect. `StrandAppSchemaState` gains `'waiting-for-cohort'`, and `StrandAppSchemaDeferred` gains `waitingFor`.
- **Tests:** `strand-app-schema-change-while-partner-offline`, two arms (offline off and on), failed as reported before the fix.

## Review findings

Read the implementation diff first, then the code at HEAD (Optimystic 1.24.0, Quereus 4.24.0), and traced the refusal through the sibling sources without editing them.

**Major: filed `blocked/app-schema-refused-at-catalog-commit-is-not-unwound`.**

- A cohort refusal usually lands at Optimystic's end-of-apply catalog commit, after every migration step succeeded, and Quereus unwinds only a failed step. The engine therefore keeps the new schema in memory, contrary to the implementation's claim that the strand opens on its earlier schema.
- The retry's diff is then empty, so it writes nothing and settles `applied`. A temporary copy of the scenario read `applied` at 17 s with A still offline, in both arms.
- A unit probe with a refusing transactor showed the same for a tag, a column, a table, an index and a dropped column. A query through a new index threw `does not maintain index`, and still threw after the partner returned, until the next connect.
- The scenario did not catch this because it checks the state only right after the claim and after A returns.
- No clean Sereus-side fix exists: the reachability gate answers true in this exact case, and the other workarounds are listed in the blocked ticket. The recommended fix is in Quereus, a sibling repository this repo treats as read-only.
- #55's reported failure, a strand that does not open, stays fixed: re-run at HEAD, both arms pass.

**Minor, fixed in this pass:**

- **Open transaction during a cohort retry:** the loop went back to the next-chance wait, up to 5 minutes, instead of retrying in 250 ms, and an abort during that delay left a pending timer of up to 5 minutes. `applyOutsideOpenTransaction` now holds that wait, which also closes the abort path.
- **`types.ts`:** the `AppSchemaOutcome` doc comment sat above `AppSchemaWait`. Moved.
- **Listener isolation:** `StartStrandConfig.appSchema` said its listeners were isolated, but a throw from `published()` would have skipped the rest of `publishDatabase`. The report now logs a listener's throw.
- **Cause walk:** `deferralOf` walks `cause` although `classifyCommitFailure` refuses to. The walk is needed for a step's wrapped refusal and is safe because an apply is a declarative diff. Comment added.
- **Docs that stated the unwinding as fact:** corrected in `docs/strands.md` (with the known defect named), `app-schema.ts`, `compose-strand.ts`, the plugin's `types.ts`, cadre-core's `types.ts`, `strand-app-schema-report.ts`, `strand-database.ts`, and the scenario's header and test name. The pending release notes gain a "Known issue".
- **Docs that were out of date:** `docs/architecture.md` still listed the app-schema events as offline-mode only, and the plugin README pointed the cohort case at the wrong section.

**Tripwire:** every `peer:connect` wakes a cohort retry, including the relay's. Parked as a `NOTE:` on `nextCohortChance`. Not measured on a phone.

**The implementer's questions:**

- **The state names the first refusal, with no event per change:** left as documented. It is a smaller inaccuracy than the blocked finding, so it should be reconsidered with that fix rather than alone.
- **`attachAppSchema` not deferred:** correct as documented, a claim on a running replica fails while the cohort is unreachable. It is related to backlog `bug-refused-app-schema-kept-for-strand-resume`, which covers schemas refused for good. No change.
- **Backoff path not exercised by a test:** the temporary scenario did exercise it, since the 15 s retry fired with no connect. No permanent test added.

**Also noticed:** with the partner offline on the offline-off arm, an insert on B succeeded at about 25 s. docs/strands.md describes this: a member marked dead leaves the cohort. Recorded in the blocked ticket's evidence.

**Checked, nothing found:**

- **Resource cleanup:** listeners and timers in `nextCohortChance` are removed on every exit, and `release()` silences the report on close.
- **Launch config:** `appSchema` is forwarded by the only `startStrand` call site and retained with the launch config.
- **Dependencies:** `@optimystic/db-core` and `@libp2p/interface` are declared in the plugin's `package.json`.

**Tests:** no permanent test added. The open-transaction fix is a structural change whose helper the existing queue spec exercises, and a cohort test today would assert the false `applied`. The blocked ticket says how the scenario should be extended and how to reproduce at unit level. The implementer's scenario and spec changes are kept: neither restates the implementation.

**Validation run:** `yarn lint` (exit 0); `tsc --noEmit` for the plugin and cadre-core (no errors); the plugin unit suite (136 passed); the scenario, both arms (2 passed); the cadre-core suite (2560 passed, 1 skipped). The whole integration suite was not run in this pass, because it is the release gate's. A reply on gotchoices/sereus#55 is still a human's to post, and should mention the known issue.
