description: A phone needs some machine to act as its address before other people can reach it. Today that has to be a separate public server somebody set up. If the machine a person already runs at home could do the job instead, a phone plus a home machine would be a complete setup with nothing else to configure.
prereq: bug-party-run-relay-caps-every-relayed-connection, bug-party-run-relay-drops-a-stranger-dialing-through-it
files: packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/strand-network-config.ts, packages/reference-app-rn/src/phone-node-config.ts, packages/reference-app-rn/src/host-node-request.ts, packages/integration-tests/src/scenarios/blind-relay-phone-to-phone-e2e.integration.ts, docs/architecture.md, docs/reference-app-rn.md
difficulty: hard
tradeoffs: The configured-relay route already works and is tested, so this buys convenience rather than capability — and it puts a person's home machine on the data path for their own traffic, which is more load and more uptime expectation than that machine signed up for.
----

# A person's own always-on machine as their phone's address

## What this is about

A phone cannot accept incoming connections, so before anyone can reach it, some other machine has to forward traffic on its behalf. That machine is called a relay. Today the phone app is pointed at one by configuration — a public server someone deployed (`ops/docker/libp2p-infra`), named by an environment variable or typed into Settings. That works (`phone-becomes-reachable-through-a-relay`), but it means every deployment needs a piece of shared infrastructure, and everyone who uses it is trusting it to stay up.

There is already a machine in the picture that could do the job. A person can ask a machine they run at home to lend their cadre an always-on node (`rn-request-node-from-cadre-host`, shipped). That node runs the `storage` profile, and a storage-profile node already runs the relay server by default. The phone already knows its address, because it dialled it. Nothing new would have to be deployed, and the setup story becomes "a phone plus a machine at home", with no third party in it.

## Use cases

- Someone with a phone and a home machine invites a friend into a private chat, and the friend reaches them through the home machine. No public relay is configured anywhere.
- A family or a small group runs one machine between them; every member's phone is reachable through it.
- A deployment that does not want to operate relay infrastructure at all.

## What has to be true for it to work

Two defects block it outright, and each is filed separately because each is a real problem on its own:

- `bug-party-run-relay-caps-every-relayed-connection` — a cadre node's relay server applies libp2p's default 128 KiB / 2 minute cap to everything it forwards, so real traffic dies partway through.
- `bug-party-run-relay-drops-a-stranger-dialing-through-it` — the machine hangs up on an outsider dialling through it after five seconds, which is exactly what an invitee does.

Beyond those, this ticket has its own design questions:

- **How does the phone learn the relay address?** The lent node's address is already in the phone's control database as a `CadrePeer` row, so it could be discovered rather than configured — but that is a *runtime* source, and the config field that reaches a phone's strand nodes (`network.relayAddrs`) is read when the node is built. Either the relay set becomes something that can change while the node is running and propagate into strand instances, or the phone restarts its node when it acquires one. Both are real designs with real costs.
- **A phone with no always-on node of its own.** It must fall back cleanly to a configured relay, or say plainly that it is not reachable yet.
- **More than one always-on node.** Which one, or all of them? A second relay is a second reservation per node per strand.
- **The home machine's reachability.** It has to be dialable from the wider internet for an outsider to hop through it; today only its own TCP port is mapped (`backlog/feat-cadre-host-wan-grant-reachability`), and a machine reachable only on a home network makes this work on that network and nowhere else.
- **Two parties, two relays.** Once each side relays through its own machine, the two ends are on different relays — the shape nothing has ever tested (`backlog/feat-scenario-two-relay-circuit`).

## Expected behaviour

- A phone that has been lent a node by a machine at home becomes reachable through that node, with no relay configured anywhere.
- An invitation minted on such a phone carries addresses that route through the home machine, and an outsider can redeem it.
- A phone with neither a lent node nor a configured relay says so in plain language instead of failing.

## Related

- `backlog/feat-scenario-two-relay-circuit` — the two-relay shape this makes ordinary.
- `backlog/feat-cadre-host-wan-grant-reachability` — reaching the home machine from outside the home.
- `backlog/debt-strand-relay-redrive-on-party-run-relay-unscenarioed` — recovery after a party-run relay restarts, which this would put on a data path.
