description: Optimystic lets a machine that knows other members exist, but is connected to none of them, save a change on its own and then records that nobody else needs a copy. Sereus needs the Optimystic fix released and adopted before the reproduction for GitHub issue 44 can pass.
files: packages/integration-tests/src/scenarios/joiner-first-commit-over-slow-relay.integration.ts, package.json (resolutions, @optimystic/* floors), packages/cadre-core/package.json
----
# Upstream: a write made alone while other members are known owes no one a copy

**Blocked on:** a dependency outside this repo. Unblocks when Optimystic releases a fix for `../optimystic/tickets/fix/1-a-write-made-alone-while-other-members-are-known-never-reaches-them` and Sereus adopts that release.

## The defect

GitHub issue gotchoices/sereus#44. When a node's cohort for a block resolves to only itself, `CoordinatorRepo.commitSolo` commits with `quorum: 'local'` and records the block in the under-replication ledger with `missingPeerIds: []`. The drain therefore has nobody to push to, on reconnect or after a restart. A joiner that wrote alone and then stopped never delivers the write; the commit reported success.

Optimystic's ticket names the likely fix (record as owed the members the node knows serve the network but is not connected to) and keeps the refuse-or-wait policy for one- and two-machine groups out of scope, owned by its partition-healing design. Optimystic's agent has been told; it is ranked first on their board.

## What Sereus does when it lands

- Adopt the release (floors in `packages/cadre-core/package.json` and the other `@optimystic/*` dependents; the adoption pattern is in the recent `adopt optimystic …` commits).
- Re-run `joiner-first-commit-over-slow-relay.integration.ts`. Its third arm is `it.fails` (`fix/joiner-write-made-alone-lost-when-it-stops` commits it); when it starts failing, the bug is fixed: make it a plain `it`.
- If the fix stage of `joiner-write-made-alone-lost-when-it-stops` found a Sereus-side delivery defect after restart, confirm both together.
- Reply on #44 and close it.
