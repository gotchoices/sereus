description: A draft reply for the reporter on GitHub issue 28, telling them strand nodes can now turn on Optimystic's change notifications, what the setting is called, what we measured, and the limit we found. Posting it is the maintainer's call, after the change ships.
files: packages/cadre-core/src/strand-reactivity.ts (StrandReactivityConfig, strandCohortTopicOption), packages/cadre-cli/README.md (strandReactivity), docs/strands.md (#change-notifications-reactivity), packages/integration-tests/src/scenarios/strand-reactivity-wakes-watchers.integration.ts
----
# Human action: reply to risavian on gotchoices/sereus#28 once `strandReactivity` ships

**Blocked on:** the maintainer posting to a public tracker, after a sereus release that contains `strand-reactivity-node-option`. The option landed after v1.11.0, so it is not released yet; fill in the version before posting.

## Context for the maintainer

#28 asked for a node-local way to turn on `@optimystic/db-p2p`'s `cohortTopic` for chosen strand nodes, proposing `strandCohortTopic: { enabled; strandIds?; minSigs? }`. It landed as `CadreNodeConfig.strandReactivity: { enabled: boolean; strandIds?: string[] }`, and as the `strandReactivity` key in a cadre-cli config file. The shape is theirs, minus `minSigs`.

`strand-reactivity-scenario` measured it on three machines at `strandClusterSize: 2`, against Optimystic 1.10.0. Once a machine is registered, it is pushed within about 50 ms of the commit, including the machine outside the tail block's storage group. That is the same position as their browser viewer. The limit is that machines registering in a burst lock later ones out. It is filed as `report-optimystic-reactivity-registration-burst-on-a-small-strand` and matters to them: a viewer that arrives after two others registered under 0.5 s apart at the same root is never pushed. Their `CohortBackoffError: no willing primary right now` is also the error that lock-out produces.

**Their regression test only partly inverts.** Test 3, the static scan of `dist/*.js` for the identifier `cohortTopic`, now fails as intended: `dist/strand-reactivity.js` and `dist/strand-instance-manager.js` contain it. Tests 1 and 2 guess the setting's name (`strandCohortTopic`, `cohortTopic`, `network.cohortTopic` on the launch config, and `strandCohortTopic` on `CadreNodeConfig`). The landed names are `strandReactivity`, and `reactivity` on the launch config, so those two keep passing, and they would report the gap as still open.

## Draft

> Thanks for the detailed proposal; it is what landed, under a different name.
>
> In <sereus X.Y.Z>, `CadreNodeConfig.strandReactivity` (`strandReactivity` in a cadre-cli config file) is `{ enabled: boolean; strandIds?: string[] }`. With `enabled: true` and `strandIds` absent or empty, every strand node this node builds gets `cohortTopic: { enabled: true }`. Listing ids narrows it to exactly those strands. Anything else (`enabled` not the boolean `true`, or `strandIds` not an array) adds no `cohortTopic` key at all. It is node-local and never read from the control database, a strand row, or a peer. A hibernation wake rebuilds with it, and the control node never gets it.
>
> A table opts in from the sApp schema: `table Message ( … ) with tags ("optimystic.network_watch" = true)`. The key must be quoted and the value must be the boolean `true`. A tagged table on a node without the option keeps local wakes only, so an sApp can ship the tag unconditionally.
>
> We left out `minSigs`. A notification's root is the storage group of the collection's log tail block, verified at the consensus super-majority, and neither `minSigs` nor `wantK` governs that. Enable it on every machine that serves the strand: a machine without it neither announces commits nor serves as part of a notification's root.
>
> Measured on a real network (three machines, `strandClusterSize: 2`, Optimystic 1.10.0): every registered watcher was woken within about 50 ms of the committing machine's insert returning. That includes the machine that is outside the tail block's storage group, which is the position your browser viewer is in. A table watched before its first commit registers at the first renewal tick after that commit (up to 30 s), and the first registration at a root pays Optimystic's proof of work (1.5–41 s measured).
>
> One limit, reported to Optimystic: on a network smaller than its `wantK` (16), when machines register at the same root under about 0.5 s apart, the root pre-promotes and never demotes. Any later registrant is sent to a tier the network cannot form and fails with `CohortBackoffError: no willing primary right now`, the error you saw. A browser viewer arriving after such a burst would get no pushes, only Optimystic's 30 s tail read, and in our runs even that sometimes stopped. Until that is fixed, keep a poll as the floor. `docs/strands.md` → "Change notifications (reactivity)" in the repo has the details, including the extra protocols enabling registers on closed strands.
>
> About your regression test: test 3 (the `dist` scan) now fails, as intended. Tests 1 and 2 look for `strandCohortTopic` / `cohortTopic` and will keep passing, because the names are `strandReactivity` on `CadreNodeConfig` and `reactivity` on the strand launch config. Point them at those names, or drop them, when you remove your local patch.
