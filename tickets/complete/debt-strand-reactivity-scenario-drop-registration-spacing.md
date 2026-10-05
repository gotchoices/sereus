description: The strand change-notification test spaces out machines' watch registrations to dodge an Optimystic bug; once Optimystic fixes it, the test should let machines register naturally again.
prereq:
files: packages/integration-tests/src/scenarios/strand-reactivity-wakes-watchers.integration.ts, docs/strands.md (#registrations-that-arrive-together)
tradeoffs: Waits on Optimystic's fix/reactivity-registration-burst-locks-out-a-small-root; nothing to do until that ships.
----
# Drop the registration-spacing workaround once Optimystic fixes the burst lock-out

Filed upstream as optimystic `fix/reactivity-registration-burst-locks-out-a-small-root`.

- In the scenario, drop the tag toggling and spacing (the `NOTE:` on `REGISTRATION_SPACING_MS`). The table is already tagged in its schema, so wait for those watches to register on their own, and re-measure whether `RECORD_GOSSIP_SETTLE_MS` is still needed.
- Rewrite docs/strands.md → "Registrations that arrive together" to describe the fixed behaviour, or remove it.

## Done

Tested against local optimystic c1e33d34 (fix landed, not released). Spacing and tag toggling removed; the scenario waits for all three schema-opened watches to register after a seed commit. 3 of 3 runs passed: all three registered within ~250 ms of each other, every watcher pushed and woken within ~100 ms, the outsider included. `RECORD_GOSSIP_SETTLE_MS` stays (Optimystic documents the up-to-5 s post-registration gap on groups of three or fewer). docs/strands.md's "Registrations that arrive together" removed.

**Before the sereus release:** the `@optimystic/*` floors must move to the release carrying the fix, or a published install gets 1.10.0 and the test fails.
