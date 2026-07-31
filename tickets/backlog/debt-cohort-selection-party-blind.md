----
description: When the system picks which machines store a copy of your data, it has no idea which machines belong to which person. Asking for two copies can silently put both on one person's phone and laptop, which is one copy as far as surviving a failure goes.
files: ../optimystic/packages/db-p2p/src/libp2p-key-network.ts, packages/quereus-plugin-sereus/src/cluster-size.ts, docs/architecture.md
difficulty: hard
----

# Copies are counted in machines, but the thing that fails is a person

## What is true today

Every replication setting in Sereus counts **machines**. Every question those settings are
meant to answer is about **people** (or organisations) — how many independent parties hold a
copy, how many separate parties would have to fail before data is lost, how many mutually
distrusting parties attested a write.

The group of machines that stores a given piece of data is chosen purely by a hash-distance
measure: `findCluster` in `../optimystic/packages/db-p2p/src/libp2p-key-network.ts` asks the
routing layer for the machines nearest the data's key. It does filter — but only for *network*
membership, meaning "does this machine serve this particular strand's protocol at all". It has
no concept of which party a machine belongs to.

So a request for N copies yields somewhere between 1 and N independent parties, decided by the
hash of the data being written. In a workspace shared by three people, a given row's copies can
land entirely on one person's phone and laptop. That is:

- **one** failure domain, not two — if that person's house burns down, both copies are gone;
- **one** witness, not two — no second party ever saw the write;
- **one** reachable source — when that person's devices are asleep, nobody else can read it.

None of this is visible to anyone. The configured number is met exactly; it simply does not
measure what it appears to measure.

## Why it is worth fixing

It puts a ceiling on every other assurance the system can offer. Raising the number of copies
(`debt-strand-replication-breadth-ignores-party-count`, now in `implement/`) improves the
*odds* of party diversity but cannot guarantee it, and the gap widens as parties run more
machines each: a party with four devices can, on its own, satisfy a request for four copies.

It also blocks the security work. Any rule of the form "a write must be attested by two
different parties" is unenforceable while the layer choosing attestors cannot tell parties
apart — which is the dependency `feat-open-strand-witness-policy` runs into.

## Where a fix has to happen

**Upstream, in `../optimystic` first.** Cohort selection lives entirely in `db-p2p`, and Sereus
has no hook to influence it. That repo keeps its own ticket queue; this ticket exists so the
Sereus side is tracked and so nobody mistakes the machine count for a party count in the
meantime.

The shape of the ask, roughly: cohort selection needs an optional grouping label per machine,
and a selection rule that prefers one machine per label before taking a second from any label.
Sereus can supply the label — a party identifier is exactly what the control database's peer
records already establish — but only if the selection layer accepts one.

Open questions a design would have to settle, none of them answered here:

- Where the label comes from on a strand network, given that cross-party peer discovery is
  itself unfinished (`docs/strands.md` leaves it open).
- Whether the label can be trusted. A party that wants extra copies of its own data could claim
  several labels; a party that wants to *be* the only copy could claim to be several parties.
  Party-diverse selection driven by a self-asserted label is only as good as the identity behind
  it, which is fine for an invitation-only workspace and not fine for an open one.
- What happens when there genuinely are not enough distinct parties — the rule has to degrade to
  today's behaviour rather than refusing to place copies.
- Whether machine uptime should feed the same selection. Sereus already classifies nodes with a
  storage-versus-edge profile, and "prefer the always-on machine" is a different and possibly
  more valuable preference than "prefer a different owner". They may want to be one rule.

## Not in scope

Nothing here is a regression and nothing is currently failing. This is about what the numbers
mean, not about a broken path.
