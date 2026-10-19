description: An opt-in scenario now counts, phase by phase, the streams every node opens per protocol and the block reads each Sereus caller makes, for a two-party strand and a two-machine cadre from start through an idle minute, so each message-reduction ticket can show its before and after against one baseline (GitHub #50, gotchoices/Optimystic#39).
architecture: docs/testing.md#where-measurements-live
files: packages/integration-tests/src/scenarios/message-cost-accounting.integration.ts, docs/testing.md ("Where measurements live")
----
# Message-cost accounting

## What landed

`message-cost-accounting.integration.ts`, skipped unless `MESSAGE_COST_MEASURE=1`. Cases `strand`, `cadre` (owner admits a pinning member) and `invite` (a device redeems a cadre invitation); options `MESSAGE_COST_CASE`, `MESSAGE_COST_IDLE_S`, `MESSAGE_COST_STRANDS`. It asserts only completion. The method, the counting limits and the 2026-10-19 baseline are in its doc comment, which is their single home; docs/testing.md "Where measurements live" points at it.

Landed directly from the planning session's prototype at the maintainer's request, without an implement/review pass. Validated: lint and `yarn workspace @serfab/integration-tests typecheck` clean; the `strand` case passed with `MESSAGE_COST_STRANDS=2 MESSAGE_COST_IDLE_S=30` (50 s); the prototype's three cases passed in four runs earlier the same day.

## Where the baseline's counts come from

The analysis behind the numbers (static, done while planning) lives in the tickets that act on it:

- **Idle control reads:** reconcile pass 46%, strand watcher 31%, pending-join runner 15%, revocation enforcer 7%; on a second machine each read past Optimystic's 10 s read-repair window costs a background `sync`, and each read of a never-written table a blocking consult. `control-and-strand-table-change-subscription`, `control-membership-rows-cached-until-changed`, `strand-watcher-woken-by-control-changes`, `control-reconcile-woken-by-changes-reads-once`, `pending-join-runner-woken-by-changes`, `strand-revocation-enforcer-woken-by-membership-changes`, `control-collections-created-at-cadre-founding`.
- **Formation:** `strand-founding-writes-batched`, `joiner-membership-in-one-commit`, `formation-and-redemption-read-each-row-once`, `new-machine-self-record-written-once`, `first-sync-gate-probes-cheaply`, `join-backfill-pushes-once-and-is-waited-for`, `formation-connection-closed-after-formation`, `claimed-node-rejoins-without-waiting`.
- **Upstream:** `blocked/optimystic-attach-fetches-each-block-twice`, `blocked/optimystic-background-consults-cost-a-request-per-block`, `blocked/optimystic-multi-collection-commit-costs-four-requests-per-collection`, `blocked/fret-maintenance-probes-peers-off-its-ring`.

## Usage

Re-run the case a change affects before and after it, and record both in that ticket's review handoff. The idle minute is deterministic run to run; formation phases shift background work between adjacent phases, so compare phase sums across a flow, not single phases.
