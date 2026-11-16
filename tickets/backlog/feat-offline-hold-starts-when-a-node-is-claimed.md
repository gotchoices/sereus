description: In offline mode, a save made in the few seconds right after adding an always-on node still commits alone, because the phone has no proof yet that the node will run that workspace. Decide whether the phone should wait for such a node from the moment it is added.
files: packages/cadre-core/src/cadre-node.ts (`claimNode` ~10557), packages/cadre-core/src/strand-party-machines.ts, schemas/control.qsql (`CadrePeer.Profile`, `StrandPeer`), docs/strands/writes.md
tradeoffs: The save is not at risk beyond what a queued one is: it is on the phone and reaches the node through the peer-join backfill once they connect, the window is seconds long in the normal path, and closing it requires knowing a node's strand filter before it has spoken, so a maintainer may reasonably leave it as a documented limit.
----
# Hold a phone's offline writes from the moment it claims a node

`offline-queue-waits-for-party-machines-that-hold-the-strand` waits for a machine once its `CadreControl.StrandPeer` row reaches the phone. The row is written when the machine launches the strand. Between the claim and the row's arrival nothing says the machine will hold this strand, so a save in that window commits alone. The measurement on `strand-addr-retry-waits-a-minute-after-a-node-claim` shows one strand commit in that window: the `+0 s` write, 0.5 s before the node's addresses arrived. If the phone loses the network right after the claim, the window lasts until it next connects to the node.

## Why it is not settled

- **A node's filter is local.** Every storage-profile node runs every strand its filter admits (`hostUnclaimedStrands`), and the filter is configuration the phone cannot see, so "it is an always-on node" is not proof. `CadrePeer.Profile` is null until the machine self-publishes, which comes after the claim anyway.
- **Counting too high holds writes for a machine that will never hold the strand** (`docs/cadre/control-replication.md` → Replication cluster size).

## Shapes to weigh

- The claim records in memory on the phone that this machine is expected, released by its first `StrandPeer` row or by a strand-address answer saying the filter excludes the strand. It needs a new reply status from the strand-address protocol and a bound on an expectation nothing ever answers.
- The machine's self-record also states its filter, so a phone can evaluate it against the strand. It closes the offline-after-the-self-record case, not the first seconds.
- Leave it, as the documented limit it already is in `docs/strands/writes.md` → Waiting for the party's own machines.
