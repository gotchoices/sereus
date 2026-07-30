description: Data in a shared workspace is copied to only two of the participating machines by default. That number was picked to make writes work at all on tiny setups, and someone needs to confirm it is an acceptable durability trade for real deployments.
blocked-reason: Product/durability decision. Engineering picked 2 on correctness grounds; nobody has weighed the reduced number of copies against real deployment expectations. Narrowed 2026-07-29 — the group's own settings data now copies to every machine, so this is about shared-workspace (strand) data only.
files: docs/architecture.md, docs/strands.md, packages/quereus-plugin-sereus/src/cluster-size.ts, tickets/backlog/debt-strand-replication-breadth-ignores-party-count.md
----

# Decision: is two copies the right default for shared-workspace data?

## Background, in plain terms

Every piece of data written to a shared workspace is copied to several machines. How many is a
setting. It used to be three, then two.

The change to two was not made for durability reasons — it was made because three was **broken**.
Each machine independently checks that a write is being offered to as many machines as it expects,
and refuses to participate if the group looks too small. With the setting at three, a small setup
had every write refused. Two is also the smallest value the storage layer accepts, so there was no
room below it.

That correctness argument is settled and shipped. What is left is the question nobody has
answered.

## What this ticket now covers — and what it no longer does

**Narrowed on 2026-07-29.** When this ticket was filed, one setting governed copies of *everything*.
That is no longer true; there are two separate settings:

- **A group's own settings and membership data** (each person's or organisation's own machines —
  phone, laptop, home server). This now copies to **every machine in the group**, decided and
  shipped. Not open, not part of this decision. It had to change: at two copies, a machine that
  missed an update could never catch up.
- **Shared-workspace data** (a workspace shared between several groups). Still two copies by
  default. **This is the only thing this ticket asks about.**

## What is actually at stake

- With two copies, losing both machines that hold a piece of data loses it. With three, two losses
  were survivable. A real reduction in redundancy, not a bookkeeping change.
- Availability, not only durability: a participant that does not hold a piece of data can read it
  only while at least one of the two holders is reachable. For a workspace shared between people
  whose phones and laptops come and go, "both holders happen to be offline" is an ordinary day.
- Adding participants to a workspace never increases the number of copies. A five-participant
  workspace still stores each piece on two machines.
- Raising the number is safe *only* if the workspace reliably runs that many machines, and every
  machine must be configured with the same number — a machine expecting more than it is shown
  refuses to participate, which is the failure this whole change came from.

## Options for whoever picks this up

1. **Keep two as the default** — accept lower redundancy in exchange for small setups working out
   of the box. (Current state; no work needed, just close this.)
2. **Keep two as the default, but have larger deployments raise it** — needs guidance in the
   operator docs, and probably a way for the participants to agree on the number rather than each
   machine being configured by hand.
3. **Something adaptive** — the number follows the workspace's actual size. Attractive, but the
   value is fixed when a machine starts and machines learn about each other only gradually, so a
   naive version reintroduces the exact disagreement that broke writes.

Option 3 is a real design ticket, and the engineering side of it is already written up in
`backlog/debt-strand-replication-breadth-ignores-party-count` — read that before choosing 3.
Options 1 and 2 are a decision plus, at most, docs.

## Context

Mechanism: the "Replication cluster size" section of `docs/architecture.md`. The two-copy default
lives as `DEFAULT_STRAND_CLUSTER_SIZE` in `packages/quereus-plugin-sereus/src/cluster-size.ts`,
overridable per node. Originally shipped by `bug-cluster-size-exceeds-cadre-size`
(`tickets/complete/0.5-bug-cluster-size-exceeds-cadre-size.md`); narrowed to this scope by
`control-db-replicates-to-whole-party`.
