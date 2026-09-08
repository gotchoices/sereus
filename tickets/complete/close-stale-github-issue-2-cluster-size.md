description: A public GitHub issue that described a problem no longer present in this project has been corrected and closed, and the record now says accurately why the option it named is deliberately not wired up.
files: docs/architecture.md, packages/quereus-plugin-sereus/src/cluster-size.ts
----

# Complete: `gotchoices/sereus#2` corrected and closed

Human action carried out 2026-09-08. No code changed; this ticket only ever asked for someone with
tracker access to fix a public record.

## What was done

Commented on and closed [`gotchoices/sereus#2`](https://github.com/gotchoices/sereus/issues/2),
taking the first of the two options the reporter (`risavian`) had offered — *re-close with the
accurate reason* — rather than the second (keep it open as a plumbing request).

## The correction that mattered, which is not the one this ticket predicted

This ticket said the issue "describes code that no longer exists", and for the **first** half of the
issue title that is right: the hardcoded `clusterSize: 3` is gone, the reporter verified that
himself against `@serfab/cadre-core@0.11.0`, and the replication figure is now the named
`CONTROL_REPLICATION_BREADTH` constant with its reasoning in
[`docs/architecture.md`](../../docs/architecture.md).

The **second** half was a different situation, and the closing comment had to correct *our own*
record rather than the reporter's. A previous maintainer comment on that issue claimed
`allowUnvalidatedSmallCluster` had been removed from `@optimystic/db-p2p` upstream, so the
complaint that it could not be reached through cadre-core was moot. That was false. The reporter
checked and said so; re-verified at `v0.29.0` before closing:

- declared on `clusterPolicy` — `cluster/cluster-policy.ts:110`
- resolved — `cluster/cluster-policy.ts:435`
- consumed as a live opt-in branch in `admitMembership` — `cluster/cluster-repo.ts:1153`

So the option is alive, and anyone grepping their `node_modules` would have found it and concluded
the maintainer had not looked. The accurate reason it stays unplumbed is the reporter's own: it
gates **membership admission** only and never touches the read-repair corroboration floor, which is
the lever that actually bites a small cadre. Plumbing it would fix nothing either side had hit.

## Why closing was defensible even though the downstream half is unpublished

The last maintainer comment before this one had escalated the issue: it said our documented advice
for two-machine deployments was *inert for anything built on cadre-core*, because there was no seam
to forward a declared size through. That gap is now closed upstream — `@optimystic/*` **0.29.0**
ships `clusterPolicy.repairCorroborationClusterSize`, which declares the repair corroboration
yardstick alone, without dragging the membership admission gate's write floor up with it. That
coupling is precisely why `cluster-size.ts` pinned `assumedClusterSize: 2` at every group size and
therefore got no repair tightening at all.

The cadre-core side that derives the number from membership has landed in this repository but is
**not published**; the closing comment says so plainly and names the release it will ship in, along
with the `^0.27.0` pin widening the reporter separately asked for. Nothing in that pending work is
a reason to keep a public issue open whose two stated findings are respectively fixed and
deliberately declined.

Two qualifications went into the comment with the new setting, because over-declaring it is worse
than declaring nothing: the number is the size of the cohort that actually **serves** the network
(not the count of enrolled machines), and it is read once when a node is built, so a changed value
applies on rebuild rather than live.

## Left open deliberately

The closing comment invites a reopen if the corroboration seam turns out not to cover the
reporter's case, and asks for a fresh issue against 0.29.0 rather than a reopen if a genuinely new
gap appears — the same instruction this ticket carried.
