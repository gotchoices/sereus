description: When two machines of a cadre start at the same moment (a host reboot, a power cut), each commits its own startup `CadrePeer` refresh while alone. Both writes land on the same block at the same revision with different content, so the block forks. From then on every `CadrePeer` write is rejected with `content-digest-mismatch`, adding a machine tears its commit, and nothing heals it (gotchoices/sereus#53). Stop background control writes from committing alone while the party has other members, the rule `addOwner` already follows.
architecture: docs/architecture.md#writes-made-while-alone
repro: none
files: packages/cadre-core/src/cadre-node.ts (`scheduleSelfRegistration` ~3329, `publishSelfRecordUnlessCurrent`, `publishFirstSelfRecord` ~3697, `startRecordRefresh` ~3730, `hasReachableControlSibling`, `committedAlone`), packages/cadre-core/src/control-database.ts (`updateSelfPeerRecord` ~2408), docs/architecture.md ("Writes made while alone" ~491), packages/integration-tests/src/scenarios/control-write-while-alone-convergence.integration.ts, packages/integration-tests/src/scenarios/cadre-invite-any-member.integration.ts, tickets/blocked/forked-control-collection-sync-livelocks.md
----
## Report

gotchoices/sereus#53 (cadre-core, cadre-cli, Optimystic 1.19.0; Node only). It includes a self-contained ~3-minute repro (`control-fork-repro.mjs`): a phone-like owner and two cadre-cli nodes.

| restart of the 2 nodes | runs | third node added? |
|---|---|---|
| both at once | 4 | no: torn commit, `content-digest-mismatch` on every `CadrePeer` write |
| both at once, then 5 min wait | 1 | no |
| only one | 1 | yes |
| both, 60 s apart | 2 | yes |

Logs at the restart. Both nodes log `control-db Self peer record updated` 40 ms apart, about 90 ms before either logs `Control cohort grew`. Then each node's re-replication of its own write is rejected by the other: `Transaction rejected by validators (1/2 rejected): <other>: content-digest-mismatch`. The later node-add then throws `CoordinatorPartialCommitError` ("Multi-collection commit was not atomic … CANNOT be rolled back"): the `CadrePeer` unique index committed and the table did not. Five minutes later the add still fails the same way.

## Cause (static)

`CadreNode.scheduleSelfRegistration` publishes the node's own `CadrePeer` record 1 s after start, connected or not. Its doc comment says so on purpose ("Whether the node is connected yet does not matter: a device that redeems within a second of starting is"). A machine restarted alongside its sibling is alone at that moment on both sides, so each commits an update to the same block at the same next revision.

`docs/architecture.md` → "Writes made while alone" assumes the queue-and-re-issue path heals an alone write. It can't when the sibling advanced the same block to the same revision in the meantime: the re-issue is judged against a forked base and refused (`content-digest-mismatch`). Healing that fork is upstream work: `blocked/forked-control-collection-sync-livelocks` (its "A restarted owner's self-record UPDATE committed alone" paragraph already names this boot one-shot as a remaining trigger), and Optimystic's partition-healing design.

**The rule already exists for one write.** `CadreNode.addOwner` refuses before writing (`OwnerKeyAddRefusedError`, code `alone`) when no sibling is reachable and the party has other authorized members, because "a party with no other members cannot fork". A background write has no user waiting on it, so it should defer under the same condition rather than refuse.

## Fix direction

**Invariant:** a background control write (one no caller is waiting on) does not commit while this node is alone (`!hasReachableControlSibling()`) and the party has other authorized members. It defers to the first-growth drain or the next connected reconcile pass, which already publish the self-record once a sibling is reachable (`publishFirstSelfRecord`).

- **Apply it at one seam**, not at each call site: a guard used by every background self-record path. That covers the 1 s boot publish, the address-change refresh and the TTL heartbeat in `startRecordRefresh`, and any other background control writer the audit finds. Audit every control write made from a timer, event or reconcile pass (`DeviceToken` refresh, ledger markers, re-replication drains), and list each in the handoff with its disposition.
- **The device-redeem case still works.** A device redeeming within a second of starting counts as a reachable sibling (it passes `isNetworkMember` as "a device whose admission this node is writing"), so the node is not alone. Confirm this, because the boot publish's comment cites this case.
- **A lone founder still publishes.** A party with no other authorized members cannot fork. Count "other members" the way `addOwner` does, and reuse its predicate rather than writing a second one.
- **Update the doc.** "Writes made while alone" must say which writes commit alone (user-initiated ones, under the existing queue-and-re-issue rule) and which defer (background ones in a party with other members), and why re-issue cannot heal a same-revision fork. Name this ticket's slug, not the story.

**Out of scope here; record it on the blocked ticket instead.** Healing an existing fork, and the torn multi-collection commit, are upstream. Add #53 to `blocked/forked-control-collection-sync-livelocks` as an observed trigger, with its numbers. A cadre already forked by 1.19.x stays forked after this fix. Say so in the handoff for the release notes.

## Reproduce first

Build the reproduction as an integration scenario from the issue's repro: two cadre nodes of one party, stopped and started together, then a third machine added. Expect it to fail on HEAD. The issue's `RESTART=staggered` control should pass. If the simultaneous start doesn't fork in-process (timing), log both nodes' `Self peer record updated` against `Control cohort grew`, and force the overlap rather than looping runs.

## Edge cases & interactions

- **Restart where the sibling stays down.** The node defers its self-record write until a sibling appears. Check that nothing that needs the fresh record (address resolution by others, `relayStatus`) waits on that write while the node is alone. Verify by reading the code and with one assertion in the scenario.
- **The address changes while the node is alone** (relay rotation): deferred like the rest. The first sibling to connect gets the current record from the growth publish. Verify by reading the code.
- **The owner's re-touch of other machines' rows** (`reauthorizeCadrePeer` on first growth) runs only on growth, so it is not alone. Confirm.
- **A node that was revoked or is awaiting claim:** skipped as today (`publishFirstSelfRecord`'s guards).
- **Existing scenarios** that rely on the boot publish happening while alone: `control-write-while-alone-convergence` (writes a `CadrePeer` row while alone, on purpose) and `cadre-invite-any-member`. Keep them passing. An explicit, awaited `registerSelf()` from a caller is user-initiated and still commits alone under the queue rule.

## Tests

- The reproduction scenario above, which turns green with the fix. The repro must not depend on wall-clock luck; see "Reproduce first".
- No unit test of the guard beyond that, unless the "party has other members" predicate gains branching beyond reuse.

## TODO

- Reproduce as an integration scenario; confirm the boot publish is the alone write on both nodes.
- Add the background-write guard at one seam; audit the other background control writers.
- Update `docs/architecture.md` → "Writes made while alone".
- Add #53 as a trigger on `blocked/forked-control-collection-sync-livelocks`.
- Run cadre-core tests, the touched scenarios, `yarn lint`, `yarn typecheck`.
