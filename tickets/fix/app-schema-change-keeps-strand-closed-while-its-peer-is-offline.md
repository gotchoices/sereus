description: After an app changes its schema, even by one column tag, an existing strand does not open while its other member is offline. `addStrand` fails with `PromiseShortfallError` after about 5 s, so the strand disappears from the app until that member comes back. Expected: the strand opens on the schema it already has, and the change is applied once the cohort can be reached, the same way an apply refused by queued offline transactions is deferred.
architecture: docs/strands.md#an-app-schema-upgrade-waits-for-the-queue
files: packages/quereus-plugin-sereus/src/app-schema.ts (applyAppSchemaAfterQueue), packages/quereus-plugin-sereus/src/compose-strand.ts (step 7, ~line 420), packages/cadre-core/src/strand-database.ts (attachAppSchema), docs/strands.md
repro: none
----
# An app schema change keeps a strand closed while its other member is offline

GitHub gotchoices/sereus#55. Reported in Sereus Chat: the app tagged `Message.Id` with `"optimystic.fresh" = true`, as `docs/strands.md` → "Offline mode" recommends. After the update, every conversation whose other member was offline vanished from the list until that member came back.

## Reporter's measurement

Sereus 1.19.1, Optimystic 1.20.1, Quereus 4.21.1, Node, two parties on loopback, file storage. A founds a closed strand with schema v1, B joins, both write one row. B stops for good. A stops, restarts, and calls `addStrand` for the strand when `strand:discovered` fires.

| A restarts with | offline mode | `addStrand` |
|---|---|---|
| the same schema (v1.0.0) | off | OK in 88–96 ms |
| the same schema (v1.0.0) | on | OK in 93–96 ms |
| one column tag added (v1.1.0) | off | fails after 4.9 s: `PromiseShortfallError: Failed to get super-majority: 1/2 approvals (needed 2, 0 rejections)` |
| one column tag added (v1.1.0) | on | fails after 4.9 s, same error |

The change is `Id text primary key` → `Id text primary key with tags ("optimystic.fresh" = true)`. Each row was repeated in 2–3 runs, with the same result. The full repro script is in the issue body (`schema-change-offline-peer.mjs`). Not yet run here.

## Hypothesis

The connect-time apply (`applyAppSchemaAfterQueue`, step 7 of `composeStrand`) changes the strand's catalog. The catalog is a strand collection, so its commit needs the cohort's super-majority, which a two-member strand with one member offline cannot give. Only `QueuedEntriesBlockSchemaChangeError` is deferred today; any other apply error fails the connect, which is what the reporter sees. Offline mode does not help because the catalog write is not a queued app transaction.

Two things to establish first:

- Whether a tag-only change (no row-storage change) needs to write the catalog at all. If Quereus or the Optimystic plugin writes a catalog entry for a tag change, that may be avoidable upstream, but a column or index change still needs the write, so the deferral below is needed either way.
- Which error reaches `applyAppSchemaAfterQueue`: the bare `PromiseShortfallError`, or a wrapper. Classify by type (see backlog `debt-control-write-retry-matches-the-shortfall-by-type` for the same matching problem on control writes), not by message text.

## Likely fix

Extend the deferral in `applyAppSchemaAfterQueue` to an apply refused because the cohort cannot be reached: the connect succeeds on the existing `App` schema, `appSchema` stays pending, and the apply is retried when a cohort member becomes reachable (in addition to the existing queue-drain retry). The result reports why it was deferred, so an app can show it.

`StrandDatabase.attachAppSchema` (a storage replica claimed by an app) has the same exposure and should follow the same rule, or the ticket should say why not.

## TODO

- Reproduce at the lowest layer that shows it: a quereus-plugin-sereus or cadre-core test with a two-member strand, one member stopped, the other reconnecting with a tag added. Note the error type that reaches step 7.
- Check whether a tag-only change writes the catalog; if it does and need not, record that for an upstream report.
- Write the implement ticket: the deferral condition, the retry trigger, what `appSchema` / `appSchemaDeferredBy` report, and the `attachAppSchema` decision.
- Update `docs/strands.md` → "An app schema upgrade waits for the queue" to cover the unreachable-cohort case.
- Reply on gotchoices/sereus#55 once fixed (a human posts it).
