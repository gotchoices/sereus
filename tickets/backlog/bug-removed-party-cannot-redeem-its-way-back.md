description: After someone is removed from a shared workspace, sending them a fresh invitation looks like it works but silently achieves nothing — their devices are still being refused, so the invitation can never be accepted, and neither side is told.
files: packages/cadre-core/src/strand-revocation-enforcer.ts, packages/cadre-core/src/strand-membership-reconciler.ts, packages/integration-tests/src/scenarios/strand-party-removal-via-formation-e2e.integration.ts, docs/strands.md
repro: verified
severity: edge-case
likelihood: unusual
tradeoffs: The workaround already exists and is one call — a remaining manager admits the key directly (or clears the removed party's leftover device records first) — so a maintainer may reasonably decide this is a documentation problem rather than a code one; the code fix on the table is a carve-out in the very gate whose whole value is that it has no carve-outs.
----

# A removed party can be re-invited, but can never redeem the invitation

## What happens

A party is removed from a closed strand. Later the remaining party wants them back, so it does the obvious thing: it publishes a fresh invitation bound to the same strand and sends it over.

The invitation is delivered and redeemed successfully — invitations travel over the **control** network, and strand removal does not touch that. The removed party's node persists the same identity it had before, stages the new single-use membership credential, and reports success to the app. From the app's point of view the re-join worked.

Nothing then happens. Ever. The party is not a member again, its machines are still refused, and neither side sees an error. Verified end to end by the second test in `packages/integration-tests/src/scenarios/strand-party-removal-via-formation-e2e.integration.ts`.

## Why

Accepting an invitation means *writing a membership row into the strand itself*. That write has to travel through the strand's own network — and the machines that would carry it are exactly the machines the remaining party is refusing, because refusing them is what removal does. The removed party cannot even see the invitation record the host just wrote, so its background join loop sits waiting for a record that will never arrive, quietly, forever (it logs one warning after about five minutes and then keeps waiting).

The gate that refuses those machines is derived from the device records the removed party left behind: a device record whose owner is no longer a member is what marks that machine as refused. Getting the owner back onto the member list is what clears it, and that is precisely the write nobody can make.

## What already works

Re-admission authored by a **remaining manager** works and is the recipe today, because a manager writes into its own copy first and never has to talk to the party being refused:

- admit the key directly, which makes the leftover device records valid again and lifts the refusal; or
- clear the removed party's leftover device records first, which lifts the refusal and lets an invitation be redeemed normally afterwards (at the cost of forgetting that those machines were ever refused).

The first of these is asserted in the scenario named above.

## What a fix should decide

The two shapes are not equivalent and the choice has not been made:

- **Make the dead end visible.** Cheapest and lowest-risk: an app that re-invites a removed party, and a removed party that redeems, both currently get silence. Detect the case (a redeemed invitation on a strand where this party's own machines are being refused) and say so, rather than idling. This changes no security posture at all and is worth doing regardless of the second decision.
- **Or let a valid invitation admit the machine.** Admit a machine that presents a valid, unspent invitation for long enough to finish joining. That is a carve-out in a gate whose current value is that it has none, and it re-admits a removed party without the removing party separately authorizing it — which is precisely the residual `docs/strands.md` already flags under "It does not cancel an unspent invitation". If this route is taken, cancelling invitations at removal time probably has to stop being optional.

Related, and worth designing together: `backlog/feat-strand-member-allowlist-admission` records the same chicken-and-egg shape for a *first* join under a stricter admission policy — a joiner must reach the strand to register itself, but an allowlist would refuse it until it has. One admission story for "a peer holding a valid unspent invitation" would cover both.

## What is out of scope

Not this: rotating the strand's shared read key, or clawing back what the removed party already replicated. Both remain documented residuals of removal (`docs/strands.md` → "Revocation is forward-looking only").
