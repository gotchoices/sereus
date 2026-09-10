description: After someone is removed from a shared workspace, sending them a fresh invitation looks like it worked but silently achieves nothing — their device never even tries to accept it, and neither side is told.
files: packages/cadre-core/src/strand-membership-reconciler.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/strand-revocation-enforcer.ts, packages/integration-tests/src/scenarios/strand-party-removal-via-formation-e2e.integration.ts, docs/strands.md
repro: verified
severity: edge-case
likelihood: unusual
tradeoffs: A workaround exists and is one call — a remaining manager admits the key directly — so a maintainer may reasonably decide this is a documentation problem rather than a code one; and the deepest of the fixes on the table is a carve-out in the very gate whose whole value is that it has no carve-outs.
----

# A removed party can be re-invited, but can never redeem the invitation

## What happens

A party is removed from a closed strand. Later the remaining party wants them back, so it does the obvious thing: it publishes a fresh invitation bound to the same strand and sends it over.

The invitation is delivered and redeemed successfully — invitations travel over the **control** network, and strand removal does not touch that. The removed party's node persists the same identity it had before, stages the new single-use membership credential, and reports success to the app. From the app's point of view the re-join worked.

Nothing then happens. Ever. The party is not a member again, its machines are still refused, and neither side sees an error — nothing on the removed party's side so much as attempts the acceptance. Verified end to end by the second test in `packages/integration-tests/src/scenarios/strand-party-removal-via-formation-e2e.integration.ts`.

## Why

Two separate things each block this, and it matters which one comes first — an earlier draft of this ticket named only the second, and was wrong about it.

**First: nothing ever tries.** Redeeming the invitation is the job of one background loop per strand, started when the device brings that strand up. The loop is built to finish: once this party is a member and this machine is registered, it stops for good. Accepting a *second* invitation later would need that loop to be running again, and nothing restarts it — accepting the fresh invitation just files it away where the now-stopped loop would have looked. So on a device that already completed its first join, the re-invitation is not refused, not retried, and not reported; it is simply never picked up. Confirmed by watching the loop's own logging through the scenario: every loop reports itself finished *before* the removal, and none of them logs anything at all during the window where the re-join is supposed to be happening. The only thing that builds a fresh loop is putting the strand down and bringing it back up — hibernating and resuming, or restarting the app — and a restart also forgets the filed-away invitation, because it is only held in memory.

**Second, and never reached today: the write would be refused anyway.** Accepting an invitation means writing a membership row into the strand itself, and that write travels through the strand's own network — where the machines that would carry it are exactly the ones the remaining party is refusing. The refusal is derived from the device records the removed party left behind: a device record whose owner is no longer a member marks that machine as refused, and getting the owner back onto the member list is the very write nobody can make. This is a real dead end, but the scenario above cannot demonstrate it, because the loop that would run into it has already stopped. Anyone fixing the first half should expect to meet this one immediately afterwards.

## What already works

Re-admission authored by a **remaining manager** works, because a manager writes into its own copy first and never has to talk to the party being refused. Admitting the key directly makes the leftover device records valid again and lifts the refusal — asserted in the scenario named above, and the recipe to give people today.

The other recipe that looks reasonable — clear the removed party's leftover device records first, so the refusal lifts and an ordinary invitation can be redeemed afterwards — **does not work on its own**, for the first reason above: lifting the refusal does not restart the removed party's loop. It would only complete if that party also puts the strand down and brings it back up, and by then the filed-away invitation is gone and it has to form again. Do not document it as a workaround until the first half is fixed.

## What a fix should decide

Three shapes, and the first is a prerequisite for the other two being reachable at all:

- **Make accepting a second invitation actually attempt something.** The loop's "I am finished" state assumes membership only ever grows; removal breaks that assumption, and the fix belongs there rather than at any of the places the symptom shows up. Either restart the loop when a fresh invitation is filed away, or make its finished state conditional on still being a member. This is the root cause and is worth fixing whatever is decided below — until it is, neither of the other two shapes changes any outcome, and neither does any amount of clearing device records by hand.
- **Make the dead end visible.** Cheap and low-risk, and what the previous point exposes: once the loop tries and is refused, an app that re-invites a removed party and a removed party that redeems both still get silence. Detect the case (a redeemed invitation on a strand where this party's own machines are being refused) and say so, rather than idling. This changes no security posture at all.
- **Or let a valid invitation admit the machine.** Admit a machine that presents a valid, unspent invitation for long enough to finish joining. That is a carve-out in a gate whose current value is that it has none, and it re-admits a removed party without the removing party separately authorizing it — which is precisely the residual `docs/strands.md` already flags under "It does not cancel an unspent invitation". If this route is taken, cancelling invitations at removal time probably has to stop being optional.

Related, and worth designing together: `backlog/feat-strand-member-allowlist-admission` records the same chicken-and-egg shape for a *first* join under a stricter admission policy — a joiner must reach the strand to register itself, but an allowlist would refuse it until it has. One admission story for "a peer holding a valid unspent invitation" would cover both.

## What is out of scope

Not this: rotating the strand's shared read key, or clawing back what the removed party already replicated. Both remain documented residuals of removal (`docs/strands.md` → "Revocation is forward-looking only").
