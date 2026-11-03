description: When an owner removes an owner key while their device has no connection to the rest of the cadre, a device they chose to keep could be dropped by every other machine after reconnecting. The removal is now refused until the device is connected, as it already was when the owner kept another owner key.
architecture: docs/architecture.md#removing-an-owner-key
files: packages/cadre-core/src/cadre-node.ts (removeOwner, revouchDependents, controlWriteCouldFork doc comment), packages/cadre-core/src/owner-keys.ts, packages/cadre-core/src/types.ts, packages/cadre-core/test/cadre-node-remove-machine.spec.ts, packages/cadre-core/test/cadre-node-owner-signer.spec.ts, packages/reference-app-rn/src/owner-keys.ts, packages/reference-app-web/src/lib/owner-keys.svelte.ts, docs/architecture.md, docs/reference-app-rn.md
repro: verified
difficulty: easy
----

# Review: `removeOwner` is refused while alone when it would re-vouch any row

## What changed

`CadreNode.removeOwner` now throws `OwnerKeyRemovalRefusedError` with code `alone` when `revouch.owners` or `revouch.peers` is non-empty and `controlWriteCouldFork()` is true. Before, only an owner re-vouch was refused. `revouch.peers` includes this node's own row when the plan says `revouchesOwnRow`, so a call with no `revouch` option is refused too in that case.

The reason: a `CadrePeer` re-vouch committed alone takes the collection to the same revision as any other member's write made meanwhile, with different content. That fork is not healed by a re-issue. The removal's tombstone lives in the separate `Revocation` collection and still arrives, so other machines drop the kept row.

`revouchDependents` now logs a machine re-vouch that committed alone, as it already did for an owner re-vouch. The refusal wording, both reference apps' `REMOVAL_REFUSAL_LINE.alone`, the doc comments and the docs follow. The `NOTE` naming this ticket and the matching sentence in "Concurrent removals" are gone.

## Behaviour to check

- Alone, with other members, and something to re-vouch (an owner row, a machine row, or only this node's own row): refused `alone`, with nothing written.
- Alone, with nothing to re-vouch: still commits, and the tombstone is re-issued on cohort growth.
- A party with no other members: not refused.
- A sibling reachable: the re-vouch and removal go ahead as before, one owner approval.
- Apps show "Connect to your cadre first; the devices and owner keys you keep would not reach your other machines." The user retries once connected.

## Tests

- `cadre-node-remove-machine.spec.ts`, the existing `removes an owner key...` test, extended:
  - An owner re-vouch, a machine re-vouch, and a call with no `revouch` when the own row depends on the key are each refused `alone`, and the rows keep their old voucher and no tombstone appears. This is the regression test for the bug.
  - A removal with nothing to re-vouch still commits alone.
- `cadre-node-owner-signer.spec.ts`: setup only, so its re-vouching removal runs with a member reachable.

## Validation

Passed on the final code:

- the two specs above
- integration scenarios `machine-removal`, `owner-grant-backup-recovery` and `owner-anchor-follows-owner-changes`
- reference-app-rn (180 tests) and reference-app-web (11 tests)
- `yarn lint`
- `tsc` for cadre-core

The whole `@serfab/cadre-core` suite was not run; a grep found no other spec calling `CadreNode.removeOwner`. The first test attempt hit the stale-build guard because `../optimystic` `packages/db-core` was being edited. It passed on retry after that repo's own build caught up, and nothing in that repo was built. That repo's `git status` still shows uncommitted edits to `db-core/src/network/i-repo.ts` and `transactor/network-transactor.ts`, so these runs were against its in-progress work.

## Known gaps and things to look at

- **Test seam differs from the ticket's.** Adding to `identifiedControlPeers` alone was not enough. The next membership refresh then sees a false-to-true reachability edge and starts the growth drain, which added approvals and rewrote the rows the assertions compare. Both specs therefore also set the private `controlSiblingReachable` flag to true. Consider whether two private fields is acceptable or a test helper is warranted.
- **Possible separate issue, not fixed here.** The first-growth sweep (`reconstructAuthoredMembership`) re-signs rows with no `Sig` under this node's owner key, including rows another owner vouched. While settling the tests, a drain run between the plan and the call moved a device off the removed key's dependents, and `removeOwner` then threw the plain "re-vouch names rows the removed owner key did not vouch" error. So an app that reads its plan while alone, reconnects, and then submits could show that generic error in place of a refreshed prompt. This was seen only in the spec, by forcing the drain; it was not run through an app. The reviewer should decide whether it is worth a ticket.
- **Window left open by design.** The check runs before the approval, so a connection that drops while the user approves still commits alone. It is logged, and `addOwner`'s `NOTE` records when to revisit that.
- **The own-row case and a three-machine party were not run over a real network.** The refusal happens before any write, so the unit spec covers it.
