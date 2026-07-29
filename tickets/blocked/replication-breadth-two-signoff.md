description: Data now gets copied to two machines instead of three by default, which was chosen to make writes work at all on small setups — someone needs to confirm that is an acceptable durability trade for real deployments.
blocked-reason: Product/durability decision. Engineering picked 2 on correctness grounds (writes fail outright above it on small parties); nobody has weighed the reduced number of copies against real deployment expectations.
files: docs/architecture.md, packages/quereus-plugin-sereus/src/cluster-size.ts, tickets/complete/0.5-bug-cluster-size-exceeds-cadre-size.md
----

# Decision: is two copies the right default?

## Background, in plain terms

Every piece of data written to a party is copied to several machines. How many is a single
setting. It used to be three. It is now two.

The change was not made for durability reasons — it was made because three was **broken**. Each
machine independently checks that a write is being offered to as many machines as it expects, and
refuses to participate if the group looks too small. With the setting at three, a party running
one or two machines had every write refused. Since most real setups today are a phone plus one
host, nothing could be written at all. Two is also the smallest value the storage layer accepts,
so there was no room below it.

So the correctness argument is settled and shipped. The open question is the one nobody has
answered:

**Is two copies an acceptable default for real deployments?**

## What is actually at stake

- With two copies, losing both machines that hold a block loses that block. With three, two
  losses were survivable. This is a real reduction in redundancy, not a bookkeeping change.
- The setting also governs how widely data spreads when machines join or leave, so the effect is
  broader than "one fewer backup".
- Raising it is safe *only* if the party reliably runs that many machines, and every machine must
  be configured with the same number — a machine expecting more than it is shown refuses to
  participate, which is the failure this whole change came from.

## Options for whoever picks this up

1. **Keep two as the default** — accept lower redundancy in exchange for small setups working out
   of the box. (Current state; no work needed, just close this.)
2. **Keep two as the default, but make larger deployments raise it** — needs guidance in the
   operator docs, and probably a way for a party to agree on the number rather than each machine
   being configured by hand.
3. **Something adaptive** — the number would follow the party's actual size. Attractive, but the
   value is fixed when a machine starts, and machines learn about each other only gradually, so a
   naive version reintroduces the exact disagreement that broke writes. This needs design, not
   just a config change.

Option 3 would be a real design ticket. Options 1 and 2 are a decision plus, at most, docs.

## Context

Shipped by `bug-cluster-size-exceeds-cadre-size`; see
`tickets/complete/0.5-bug-cluster-size-exceeds-cadre-size.md` and the "Replication cluster size"
section of `docs/architecture.md` for the mechanism.
