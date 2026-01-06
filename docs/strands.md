# Strand Management and Negotiation

## History
An initial attempt at a strand negotiation protocol is in the package ./packages/strand-proto and is discussed in ./strand_proto.md.

## Terminology
- party: a person or entity which transacts data with other parties
- node: a device/process linked to a libp2p peer ID
- cadre: one or more nodes representing a single party to a strand
- cohort: the collection of nodes/cohorts for the parties to a strand
- strand: a logical network over which belonging parties transact data and share a database using their collective cohort
Other definitions?

## Primary Objective
This document seeks to explore how best to manage the nodes in a strand.
From a UX perspective, this involves:
- How does one establish a cadre?
- How does one add/delete/update nodes in its?
- How does one create a strand?
- How does one invite others to the strand?
- How does one manage the strand?
- What is the lifecycle of a strand?

## Cadre Types
A cadre mould conceptually take on one of the following characters (only showing the interesting cases rather than all permutations):
- SN: Single NAT node: phone, laptop behind a firewall
- SP: Single public: cloud or physical server with public IP
- MN: Multiple NAT nodes: a phone and several computers, all behind a firewall
- MM: Multiple mixed nodes: several devices with at least one having a public IP
- LM: Large-scale mixed: More nodes than the DHT replication factor, at least one with a public IP

## Use Cases
SN-SN: A user with only a phone wants to connect to another such user.
- They will need a willing relay somewhere
- At a minimum, one will have to register with the relay and disclose its full relay-based multiaddress
- The second can reach the first through the relay if it has the full multiaddress
- If the first intends to roam (connect via more than one relay), it will need to:
  - join a DHT somewhere
  - disclose its peer address and one or more bootstrap nodes on that DHT
- This will allow the second to discover the full path using only the peer address

## Use Cases
