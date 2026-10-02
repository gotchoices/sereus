description: A draft follow-up for the reporter on gotchoices/sereus#13, asking them to re-run their slow-link test now that sereus no longer cuts a relayed connection off after 6 seconds. Posting it, and closing #13 on a pass, is the maintainer's call.
files:
  - packages/cadre-core/src/link-budget.ts (`optimysticDialLimits`, the limits this reply quotes)
  - packages/cadre-core/src/strand-formation-deadlines.ts (`formationDeadlines().dialMs`, the join's own dial budget)
  - packages/integration-tests/src/scenarios/relayed-dial-cost-by-latency.integration.ts (the 2026-10-01 measurement quoted below)
----
# Human action: ask kjeib to re-run #13 at 1 500 ms one-way

**Blocked on:** the maintainer posting to a public tracker, after `adopt-optimystic-address-dial-timeout` lands on master or ships in a release. Fill in which one before posting.

## Context for the maintainer

kjeib reported on #13 that a relayed strand join at 1 500 ms delay each way timed out 6.0 s into the dial. The cause was libp2p's fixed per-address dial limit (`connectionManager.addressDialTimeout`, 6 000 ms). They patched it to 30 s in their `node_modules`, and the test then passed end to end.

`adopt-optimystic-address-dial-timeout` requires `@optimystic/*` 1.9.0 and has every cadre node state three connection limits, each Optimystic's derivation from the declared link round trip plus 4 s for two admission decisions (a party-run relay's and the called machine's). At the default declared round trip of 3.5 s: 39 s per address, 39 s for a whole dial that carries no deadline of its own, and 42.5 s for an Optimystic request's dial.

Re-measured 2026-10-01 with the opt-in instrument (`RELAY_DIAL_COST=1`, 1 500 ms one-way): under cadre's limits a relayed dial took 12 089 ms and a stream over it worked. Under the limits a node gets when it declares no link, the dial aborted at about 6 004 ms, which matches kjeib's report.

**What could still fail their re-run, and where it belongs.** A strand join's own dial budget is `formationDeadlines().dialMs`, five round trips plus one admission decision (19.5 s at the default), and libp2p's per-address limit no longer binds inside it. The measured 12.1 s dial was over a relay connection the dialer already held. A joiner that must first open its connection to the relay pays about 3 s more, plus the relay's decision if the relay is a party-run node. That case is `fix/bug-relayed-dial-budget-omits-opening-the-relay-connection`, not this one. A re-run that fails with a `Formation dial-connect` timeout near 19.5 s points there. A failure near 6 s means the 1.9.0 floor did not reach their install.

## Draft

> Thanks again for pinning this to libp2p's per-address limit; your 30 s patch was the right diagnosis.
>
> This is now fixed without a patch, on <master / sereus X.Y.Z>. Sereus requires `@optimystic/*` 1.9.0, which derives libp2p's per-address dial limit from the link round trip the node declares (`NetworkConfig.linkRoundTripMs`, 3.5 s by default). Cadre states it as ten round trips plus 4 s for the two connection gates a relayed dial can pass, a party-run relay's and the called machine's. That is **39 s per address** at the default, where libp2p's fixed limit was 6 s. The whole-dial limit (39 s) and Optimystic's own request dial deadline (42.5 s) are derived the same way. If you declare your own `linkRoundTripMs`, all three scale with it.
>
> We re-measured it at 1 500 ms one-way: a relayed dial now completes in about 12.1 s and a stream over it works. Without a declared link, the same dial still aborts at 6 s, which is the cut-off you reported.
>
> Could you re-run your 1 500 ms case on <master / X.Y.Z> **without** the `node_modules` patch? Please check that a fresh install resolves `@optimystic/db-p2p` 1.9.0 or later. If it passes, we'll close #13. If the join times out, the elapsed time tells us which limit was hit, so please include it with the error.
>
> The cost: a dial to a machine that is gone now waits up to 39 s per address before giving up, rather than 6 s.
