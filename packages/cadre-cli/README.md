# @serfab/cadre-cli

`cadre` runs one headless, always-on Sereus cadre node (a drone) on a server, a home machine or in a container. It also carries the operator commands that put the node into a cadre, report its state, and make owner-signed changes from a server that holds an owner key.

Cadre, party, owner key, seed and strand are defined in the [glossary](https://github.com/gotchoices/sereus/blob/master/docs/concepts.md#glossary). To run several nodes on a home machine from a local web UI, use [`@serfab/cadre-host`](https://github.com/gotchoices/sereus/blob/master/packages/cadre-host/README.md), which starts this CLI once per node.

## Prerequisites

- Node.js 20.19 or later.
- A machine that the cadre's other machines can reach ([Ports](#ports)).
- One way into a cadre: a Sereus app on the owner's phone to claim the node, or a seed, a cadre invitation or an owner grant from a machine that holds an owner key. [Which side dials](https://github.com/gotchoices/sereus/blob/master/docs/cadre/membership.md#which-side-dials) compares these. A server can also found a party of its own.
- For `cadre service`, systemd or launchd. For the container, Docker with Compose.

## Install

Globally, where the command is `cadre`:

```bash
npm install -g @serfab/cadre-cli
```

Or in a folder of its own, where the command is `npx cadre`:

```bash
mkdir my-node && cd my-node
npm init -y && npm install @serfab/cadre-cli
```

The npm package holds `dist` and `src` only. The other files this README names are linked in the repository: [`example.cadre.yaml`](https://github.com/gotchoices/sereus/blob/master/packages/cadre-cli/example.cadre.yaml), [`contrib/cadre-node.service`](https://github.com/gotchoices/sereus/blob/master/packages/cadre-cli/contrib/cadre-node.service) and [`docker/`](https://github.com/gotchoices/sereus/tree/master/packages/cadre-cli/docker).

To build from a clone:

```bash
# needs ../optimystic and ../quereus cloned and built: the root package.json links their packages
corepack enable && yarn install
yarn workspaces foreach -Rt --from '@serfab/cadre-cli' run build
node packages/cadre-cli/dist/bin/cadre.js --help
```

## Quick Start

This sets up an always-on node and adds it to the cadre on a phone by scanning a code.

```bash
mkdir my-node && cd my-node
npm init -y && npm install @serfab/cadre-cli
npx cadre init --public my-node.example.com
npx cadre start
```

`--public` is the name or address at which phones reach this machine from outside its network; leave it out for a node that phones reach on the LAN only. `start` keeps running and prints `✓ Awaiting claim`.

In a second terminal in the same folder:

```bash
npx cadre status        # expect "Running: true" and "Health: healthy"
npx cadre code --qr     # scan this with the Sereus app on the phone that owns the cadre
```

When the phone has claimed the node, the first terminal prints `✓ Claimed by owner <key> into party <id>` and then `✓ Restarted into party <id>`, and `curl -s http://localhost:8080/status` shows `"claim": "claimed"`. Every later `cadre start` serves the phone's cadre. To run the node at boot, stop it and follow what `npx cadre service` prints.

## Ports

| Port | Open it to |
|---|---|
| 4001, libp2p TCP | Servers and desktop nodes that dial this node |
| 4002, libp2p WebSocket | Phones and browsers, which have no TCP transport. Forward it for phones away from home |
| 8080, health and status; 9090, Prometheus metrics | Loopback or a management network only |
| `--admin-port`, admin channel | Nothing: it binds 127.0.0.1, and only when asked for |

`cadre init` and the Docker image listen on 4001 and 4002. `example.cadre.yaml` listens on TCP 4001 only, so a phone cannot dial a node configured from it until `network.listenAddrs` gains a `/ws` entry or `cadre start --ws-port` is given.

The health and metrics servers bind every interface and have no bind-address option. Keep them behind a firewall: `/status` reveals the node's addresses and party, and the health port serves `POST /seed` when `CADRE_SEED_TOKEN` is set.

## Waiting to be claimed

A node started with a claim secret belongs to nobody until an owner's device dials it and proves knowledge of the secret; the node then joins that owner's cadre ([Claiming a node](https://github.com/gotchoices/sereus/blob/master/docs/cadre/membership.md#claiming-a-node)). A phone cannot be dialled, so an always-on node joins a phone's cadre this way.

`cadre init` sets this up. By hand, the config needs:

```yaml
controlNetwork:
  partyId: unclaimed        # a placeholder; the claim names the party
  bootstrapNodes: []
claim:
  secretFile: /var/lib/cadre/claim.secret   # base64url of 32 random bytes, and nothing else
```

The secret comes from that file or from `CADRE_CLAIM_SECRET`, never from a flag, because a flag value shows in the process list. Setting both is refused.

At the claim the node writes `claim.json` in the node-state directory (`nodeState.dir`, by default the config file's folder) and restarts into the claimed party inside the same process; if that fails, the process exits non-zero. Every later start serves the party in `claim.json` and ignores the config's `partyId`, and an unreadable `claim.json` stops the start.

The first owner whose proof verifies owns the node, so show the code only to the device that should claim it. A claim secret or a claim on record cannot be combined with `--owner`, `--seed`, `--invitation`, `--owner-grant`, `--pin-owner-key` or their environment forms.

## Join with a seed

Use this when a server that holds an owner key is running and one of the two machines can dial the other.

```bash
# 1. On the new machine B: prints B's peer ID, writes node-b.key and node-b.id
cadre enroll create --output . --name node-b

# 2. On the owner machine A, already running as
#      CADRE_STARTUP_TOKEN=<token> cadre start --owner --admin-port 7070 -c cadre.yaml
#    stdout: the seed. stderr: the party ID for B's config, the owner key to pin,
#    and the addresses the seed tells B to dial
CADRE_STARTUP_TOKEN=<token> cadre enroll add "$(cat node-b.id)" --admin-port 7070 > node-b.seed

# 3. On machine B, whose config names the same controlNetwork.partyId as A's
cadre start -c cadre.yaml --identity-file node-b.key --pin-owner-key <owner key> --seed "$(cat node-b.seed)"
```

`cadre enroll add` has the running owner node admit the peer and mint its seed. The seed tells B to dial the addresses the owner advertises. When B cannot reach those, give the owner a public address (`network.appendAnnounceAddrs`) or a relay (`network.relayAddrs`) and restart it before `enroll add`, or pass `--addr <B's multiaddr>` so that the owner dials B.

A node whose store lists no owner rejects a seed unless its signer is pinned with `--pin-owner-key` or `CADRE_OWNER_KEYS` ([Seed trust policies](https://github.com/gotchoices/sereus/blob/master/docs/cadre/control-security.md#seed-trust-policies)). A seed that does not decode, or names another party than the config, stops the start. One refused later is reported and the node keeps running.

## Join by invitation

A cadre invitation is redeemed at any member, so the owner that minted it may be offline when the machine joins. It admits a machine and grants no ownership ([Cadre invitations](https://github.com/gotchoices/sereus/blob/master/docs/cadre/membership.md#cadre-invitations)).

```bash
# 1. On the new machine B
cadre enroll create --output . --name node-b

# 2. On the owner machine A, running with --owner --admin-port 7070 and CADRE_STARTUP_TOKEN set
CADRE_STARTUP_TOKEN=<token> cadre enroll invite --peer-id "$(cat node-b.id)" --admin-port 7070 > node-b.invitation

# 3. On machine B, whose config names the same controlNetwork.partyId as A's.
#    The invitation carries a private key; the variable keeps it out of the process list.
CADRE_INVITATION="$(cat node-b.invitation)" cadre start -c cadre.yaml --identity-file node-b.key
```

`--invitation <encoded>` takes the same value as `CADRE_INVITATION`. An invitation needs a node identity and cannot be combined with `--seed` or `--owner`.

The node redeems the invitation right after it starts. A failure is reported and the node keeps running. `/status` reports the outcome as `node.invitation`, which `cadre status` prints: `pending`, then `accepted` or `failed`. A failure carries an `error`, ending in the member's refusal code such as `(invite-spent)`, and `retryable`, true when starting again with the same invitation may succeed. Starting a member again with the invitation still set writes nothing.

## Make this server an owner

An owner key belongs to a person, not a machine, so a server normally holds none ([What an owner key is](https://github.com/gotchoices/sereus/blob/master/docs/cadre/owner-keys.md#what-an-owner-key-is)). With `cadre start --owner` the server keeps an owner key in the **owner key file** and signs the cadre's owner writes with it: admitting and inviting machines, removing strands, enrolling approver keys.

```bash
cadre start -c cadre.yaml --owner
cadre start -c cadre.yaml --owner --owner-label "office server"   # the label of a founding key
```

The owner key file is `owner.keyFile`, by default `owner.key` in the node-state directory, and is never the identity key file. `--owner` creates it when it is missing. Anyone who can read it controls the cadre: keep it private and back it up with `cadre owner-key export`.

What `--owner` does depends on the owner keys this node's store lists for the party:

- **None:** the key founds the party, labelled `--owner-label` (default `server <hostname>`, at most 64 characters).
- **The key is an owner:** the node signs with it.
- **Other owners only:** the start fails, naming the key. Add it from a device that holds an owner key, import one of the party's keys with `cadre owner-key import`, or start with an owner grant.

`--owner` needs a node identity.

### With an owner grant

An owner grant makes a server an owner without copying an existing owner key onto it. An owner mints it with `cadre enroll owner-grant` or in an app, and the server redeems it for the key in its own owner key file ([Owner grants](https://github.com/gotchoices/sereus/blob/master/docs/cadre/owner-keys.md#owner-grants)).

```bash
CADRE_OWNER_GRANT="$(cat server.grant)" cadre start -c cadre.yaml --identity-file node.key
```

- **A server that is already a member** needs a connection to another machine of the cadre; with none the redemption fails as `alone`, which is retryable.
- **A server that is not a member** is also admitted as a machine, at any member the grant names. A seed or an invitation beside the grant is refused.
- **Afterwards** the node runs as `--owner` does. Replace the grant with `--owner` in the service definition, so that the grant text does not stay readable there.

`/status` reports the redemption as `node.ownerGrant`, in the shape of `node.invitation`. On an accepted grant, `ownerWired: false` means the key's row has not reached this node yet; the next start signs with it.

## Removed from the cadre

An owner can remove this machine from its cadre ([Removing a machine](https://github.com/gotchoices/sereus/blob/master/docs/cadre/removing-machines.md)). When the running node learns of it, `cadre start` writes `removed.<partyId>.json` into the node-state directory, stops the node and prints a warning. A node that was offline when it was removed may never learn of it.

The process and its health server keep running, because a supervisor would restart a process that exited. `/status` reports `node.removed` and `status: unhealthy`. Every later `cadre start` for that party finds the file and does the same.

To start fresh, delete the node-state directory; a node set up by `cadre init` then waits to be claimed again. To rejoin after an owner has added the machine back, delete only `removed.<partyId>.json`.

## Command reference

Every command prints its options with `--help`. Commands that read a config take `-c, --config <path>` (default `cadre.yaml`), in YAML or JSON.

### cadre init

Sets up a folder for a node that waits to be claimed: identity key, claim secret, a config with absolute paths, and empty `state/` and `data/` directories. It adds `start` and `code` scripts to a `package.json` that lacks them. It refuses, writing nothing, when one of its files already exists.

- `--dir <path>`: The node's folder, created when missing. Default: the current folder.
- `--port <port>`, `--ws-port <port>`: libp2p TCP and WebSocket ports. Default `4001` and `4002`.
- `--public <addr>`: Where phones reach the node from outside: `host`, `host:port`, `[ipv6]:port`, or a multiaddr such as `/dns4/node.example.com/tcp/443/wss`. The port defaults to `--ws-port`. Repeatable.

Each `--public` becomes a `network.appendAnnounceAddrs` entry.

### cadre start

Starts the node and runs until SIGINT or SIGTERM, then stops its servers, the node and its storage. A configuration error or a refused combination of options prints `Failed to start cadre node: …` and exits with code 1.

- `-d, --debug`: Enable the `cadre:*` and `sereus:*` debug logs.
- `--identity-file <path>`: The node identity key file. Overrides `identity.keyFile` and `CADRE_KEY_FILE`.
- `--ws-port <port>`: Append `/ip4/0.0.0.0/tcp/<port>/ws` to the listen addresses.
- `--health-port <port>`, `--metrics-port <port>`: Server ports, default `8080` and `9090`. `CADRE_HEALTH_PORT` and `CADRE_METRICS_PORT` override the flags.
- `--no-health-server`: Start neither server. `cadre status`, `cadre code` and `POST /seed` then cannot reach the node.
- `--seed <encoded>`: Apply a seed at start-up ([Join with a seed](#join-with-a-seed)).
- `--pin-owner-key <b64url>`: Trust this owner key as a seed signer on a node that lists no owner. Repeatable; added to `CADRE_OWNER_KEYS`.
- `--listen-for-seeds`: Accept a seed that a member delivers by dialling this node ([Seed delivery protocol](https://github.com/gotchoices/sereus/blob/master/docs/cadre/membership.md#seed-delivery-protocol)). A node with a claim secret listens without this flag.
- `--invitation <encoded>`, `--owner-grant <encoded>`: Redeem a cadre invitation or an owner grant at start-up. `CADRE_INVITATION` and `CADRE_OWNER_GRANT` carry the same values.
- `--owner`, `--owner-label <text>`: Hold an owner key for the party, and label it when it founds the party ([Make this server an owner](#make-this-server-an-owner)).
- `--owner-key-file <path>`: The owner key file, over `owner.keyFile`. Only with `--owner` or an owner grant.
- `--admin-port <port>`: Bind the [admin channel](#admin-channel) on 127.0.0.1. Requires `CADRE_STARTUP_TOKEN`. `CADRE_ADMIN_PORT` overrides the flag.
- `--startup-token-file <path>`: Write `CADRE_STARTUP_TOKEN` to this file before any port is bound, for an orchestrator that checks a live process is the one it started.

### cadre code

Prints the node code that the owner's phone scans to claim this node: `sereus-join:1.<base64url>`, holding the peer ID, addresses and claim secret. Only the code goes to stdout.

The command reads the peer ID and addresses from the running node's `/status`. It exits with code 3 when no node answers, and refuses a node that is not waiting to be claimed. It reads the secret itself, from `claim.secretFile` or `CADRE_CLAIM_SECRET`, so a node started with a different secret refuses the code. By default the code carries public names from `network.appendAnnounceAddrs`, then the machine's primary LAN address.

- `--lan <ip>`, `--no-lan`: Use this LAN address instead of the primary one, or none.
- `--addr <multiaddr>`: Put exactly these addresses in the code, in order. Repeatable.
- `--all`: Keep every address the node reports, including TCP addresses, Docker bridges and VPN interfaces.
- `--qr`, `--png <file>`, `--svg <file>`: Also draw a QR code in the terminal, or write it as an image with mode 600, because it carries the secret.
- `--open`: Open the image in the desktop's viewer; without an image option, a temporary PNG.
- `--link <url>`: Print `<url>#sereus-join:1.…` and encode that in the QR code. A browser never sends the fragment to a server.

`cadre code` and `cadre status` find the node with `--health-host <host>` (default `localhost`), `--health-port <port>` (default `8080`; `CADRE_HEALTH_PORT` overrides the flag) and `--timeout <ms>` (default `2000`).

### cadre service

Prints a service definition that runs this node's `cadre start` at boot and restarts it when it fails, then prints on stderr the commands that install it. It writes no file. Stop a copy of the node running in a terminal first, because both would bind the same ports. `--name <name>` (default `cadre-node`) names the service, and `--health-port` and `--metrics-port` are passed on to `cadre start`.

- **Linux (default):** a `systemctl --user` unit, installed without root.

  ```bash
  mkdir -p ~/.config/systemd/user
  npx cadre service > ~/.config/systemd/user/cadre-node.service
  systemctl --user daemon-reload && systemctl --user enable --now cadre-node
  sudo loginctl enable-linger $USER   # start at boot, keep running after logout
  ```

- **Linux, `--system`:** a system unit installed with sudo and run as the current account.
- **macOS:** a launchd agent, `~/Library/LaunchAgents/org.sereus.cadre-node.plist`, logging into the node folder.

The systemd unit applies no file-system sandboxing; [Linux server deployment](#linux-server-deployment) is the sandboxed layout. The command fails on Windows.

### cadre status

Prints the config file's summary and the live state of a running node, read from its `/status` endpoint. A missing or invalid config is not fatal: the command warns and still queries the node. It exits with code 3 when no node answers. `--json` prints `{ config, runtime }`, where `runtime.reachable` says whether a node answered.

### cadre enroll

#### cadre enroll create

Creates a node identity: `<name>.key`, the private key with mode 600, and `<name>.id`, the peer ID. `-o, --output <path>` is the directory (default `.`) and `--name <name>` the file prefix (default `cadre-peer`). The key file is a libp2p protobuf-encoded private key, the only format `identity.keyFile` accepts. An existing key file is never overwritten.

#### cadre enroll add

`cadre enroll add <peerId>` has a running owner node admit a machine, and prints the seed that machine starts with ([Join with a seed](#join-with-a-seed)). It and the next two commands reach the owner node's admin channel with:

- `--admin-port <port>`, else `CADRE_ADMIN_PORT`.
- `--token-file <path>`, a file holding the admin token as `cadre start --startup-token-file` writes it, else `CADRE_STARTUP_TOKEN`. The token is never a flag value.
- `--timeout <ms>` per request, default `30000`.

`--addr <multiaddr>` (repeatable) gives the new machine's dialable address, so that the owner dials it. `--json` prints `{ peerId, partyId, signerKey, seedAddrs, encodedSeed, warnings }` instead of the bare seed.

#### cadre enroll invite

Has a running owner node mint a cadre invitation and prints it ([Join by invitation](#join-by-invitation)). Stderr describes the invitation and lists the member addresses a device will try.

- `--peer-id <id>` admits only that device. Without it, whichever device redeems first is admitted.
- `--ttl <duration>` is the lifetime, such as `30m`, `24h` or `7d`. Default `24h`.
- `--uses <n>` is how many devices may redeem it. Default `1`.
- `--json` prints `{ invitation, encoded }`.

#### cadre enroll owner-grant

Has a running owner node mint an owner grant and prints it. Whoever holds the grant can become an owner of the cadre until it is used, expires or is withdrawn.

- `--label <text>` is the label every key the grant seats carries, at most 64 characters.
- `--ttl <duration>` is the lifetime, default `15m`. `never` makes a backup grant with no expiry, to be kept as carefully as an owner key. It names the cadre's machine addresses as they are when it is minted, and stops working if all of them change.
- `--uses <n>` is how many keys it may make owners. Default `1`.
- `--json` prints `{ grant, encoded, reach, warnings }`.

#### cadre enroll register

Verifies an owner's signature over a peer ID, offline: it contacts no network and registers nothing. `-p, --peer-id`, `-a, --owner-key`, `-s, --signature` and `-b, --bootstrap` are all required.

### cadre owner-key

Shows, exports or imports the key in the owner key file ([Exporting and importing an owner key](https://github.com/gotchoices/sereus/blob/master/docs/cadre/owner-keys.md#exporting-and-importing-an-owner-key)). Each subcommand takes `--owner-key-file <path>` and otherwise finds the file as `cadre start` does.

A passphrase comes from `--passphrase-file <path>` or `CADRE_OWNER_KEY_PASSPHRASE`, never from an argument, which shell history and the process list would keep. Giving both is refused.

#### cadre owner-key show

Prints the public key, the 8-character fingerprint the apps show, and the file path. `--json` prints `{ publicKey, fingerprint, file }`.

#### cadre owner-key export

Prints the key as text on stdout. The text is the private key: whoever holds it is an owner of every cadre that lists the key. `--passphrase-file` locks the export, and `--label <text>` names it.

#### cadre owner-key import

`cadre owner-key import [text]` stores an exported key in the owner key file. It reads the text from stdin when the argument is `-` or absent, which keeps an unlocked key out of shell history. The command refuses a file that holds a different key. An export from the Sereus apps imports the same way.

```bash
cadre owner-key export --passphrase-file ./passphrase > owner-key.txt
cadre owner-key import --passphrase-file ./passphrase < owner-key.txt
```

### cadre strand

`cadre strand` and `cadre validation-key` do not talk to a running node. Each starts a node of its own from the config, waits up to 30 seconds to connect to the control network, acts and stops ([Limits](#limits)). Both take `--json` and `-d, --debug`.

#### cadre strand list

Lists the strands the command's node runs, each with its status, latency hint, peer count, last activity and sApp. `cadre strands` and a bare `cadre strand` are the same command.

#### cadre strand remove

`cadre strand remove <strandId>` deletes this party's `Strand` row, so every node of the party stops running the strand. Other parties in the strand are unaffected, and the strand's stored data stays on disk. The write is owner-signed: the owner key file must hold one of the party's owner keys.

- A **closed** strand is refused without `--yes`, with exit code 1. Its row holds the only copy of this party's membership key for that strand, without which the party can never admit another member.
- A strand with no row reports "nothing to do" and exits 0. The command does not wait for the control database to sync, so it may not see a row that exists.
- A removal committed while the node has no control-network connection stays on this machine ([Deletes made while alone](https://github.com/gotchoices/sereus/blob/master/docs/cadre/control-convergence.md#deletes-made-while-alone)).

### cadre validation-key

A formation invitation may carry a validation URL: a web hook run by an outside approver, who must sign off before the invitation is redeemed ([Formation approval hook](https://github.com/gotchoices/sereus/blob/master/docs/formation-approval-hook.md)). These commands manage the approver keys the party trusts; a party with none enrolled cannot use such invitations. `add` and `remove` are owner-signed.

#### cadre validation-key list

Prints the enrolled approver keys, one per line, or a JSON array under `--json`.

#### cadre validation-key add

`cadre validation-key add <key>` enrolls a base64url Ed25519 public key.

#### cadre validation-key remove

`cadre validation-key remove <key>` removes a key. To rotate, add the new key first: removing the last enrolled key leaves every outstanding invitation that needs approval unredeemable until a key is enrolled. Joins the removed key already approved stay valid.

## Configuration

`cadre start` reads one YAML or JSON file; [`example.cadre.yaml`](https://github.com/gotchoices/sereus/blob/master/packages/cadre-cli/example.cadre.yaml) is a commented example. Every key is checked at start, after the environment variables have been written over the file. An unknown key, a wrong type or a missing required key stops the node, with one error that lists every problem and its source: the file, or a `CADRE_*` variable.

| Key | Variable | Meaning |
|---|---|---|
| `controlNetwork.partyId` | `CADRE_PARTY_ID` | Required. The party's ID; a placeholder on a node waiting to be claimed |
| `controlNetwork.bootstrapNodes` | `CADRE_BOOTSTRAP_NODES` | Required. Multiaddrs of the party's machines to dial at start; `[]` when there are none |
| `nodeClass` | `CADRE_NODE_CLASS` | Required. `server` for an always-on node, else `device` ([Node classes](https://github.com/gotchoices/sereus/blob/master/docs/cadre/node.md#node-classes)) |
| `roles` | four `CADRE_ROLE_*` variables | Overrides of the decisions `nodeClass` presets, one role at a time ([Node roles](#node-roles)) |
| `identity.keyFile` | `CADRE_KEY_FILE` | The node's private key file. Without it the node has a new peer ID on every start |
| `nodeState.dir` | `CADRE_NODE_STATE_DIR` | Directory for the node's own durable files. Default: the config file's directory |
| `storage.type`, `storage.path`, `storage.allotmentBytes` | `CADRE_STORAGE_TYPE`, `CADRE_STORAGE_PATH`, `CADRE_STORAGE_ALLOTMENT` | `file` or `memory`, the data directory that `file` requires, and the storage allotment in bytes (below) |
| `strandFilter` | `CADRE_STRAND_FILTER` | The strands this node runs: `all` (default), `none`, `{ sAppId: "…" }` or `{ strandId: "…" }`; JSON in the variable ([Strand filtering](https://github.com/gotchoices/sereus/blob/master/docs/cadre/node.md#strand-filtering)) |
| `hibernation.enabled`, `hibernation.defaultLatencyHint` | `CADRE_HIBERNATION_ENABLED`, `CADRE_LATENCY_HINT` | Whether idle strands hibernate (they do not when the block is absent), and the default hint: `realtime`, `interactive`, `background` or `archive` ([States](https://github.com/gotchoices/sereus/blob/master/docs/strands/hibernation.md#states)) |
| `strandWatchInterval` | `CADRE_STRAND_WATCH_INTERVAL` | The longest the strand watcher goes without re-reading its tables. Default `300000` ms |
| `owner.keyFile` | `CADRE_OWNER_KEY_FILE` | The owner key file. Default: `owner.key` in the node-state directory |
| `claim.secretFile` | `CADRE_CLAIM_SECRET_FILE` | File holding the claim secret |

`strandReactivity` and `push` (variable `CADRE_PUSH`) have sections of their own. `storage.type` and `hibernation.enabled` are required when their block is present. Relative paths in `identity.keyFile`, `owner.keyFile` and `claim.secretFile` resolve against the working directory, not the config file's directory.

`storage.allotmentBytes` bounds **each** network this node serves rather than the machine: the control network and every strand are given the figure in full, so a node running N strands can hold up to (N+1) times it. A `file` store is bounded by the filesystem's free space as well, whichever is smaller. It must be a whole number above zero, and only a `file` store may have one — nothing measures a `memory` store, so naming one there is refused rather than ignored. Left out, the node measures only against the free space the filesystem reports. [The storage allotment](https://github.com/gotchoices/sereus/blob/master/docs/cadre/node-storage.md#the-storage-allotment) has what the node does as it fills.

### Node roles

`nodeClass` is a preset rather than a classification: it settles four decisions — the node's **roles** — that the optional `roles` block can each set on its own. A role left out of the block keeps the class's value, and `roles: {}` means the same as no block at all.

```yaml
nodeClass: server
roles:                      # optional, and so is every role in it
  alwaysOn: true            # true or false
  overlayTier: core         # 'edge' or 'core'
  reactivity: forwarder     # 'forwarder' or 'subscriber'
  strandCohortMember: true  # true or false
```

| Role | Variable |
|---|---|
| `alwaysOn` | `CADRE_ROLE_ALWAYS_ON` |
| `overlayTier` | `CADRE_ROLE_OVERLAY_TIER` |
| `reactivity` | `CADRE_ROLE_REACTIVITY` |
| `strandCohortMember` | `CADRE_ROLE_STRAND_COHORT_MEMBER` |

[Node classes](https://github.com/gotchoices/sereus/blob/master/docs/cadre/node.md#node-classes) says what each role decides, what the presets are, and what `alwaysOn` turns on. `cadre status` prints the resolved roles beside the class, so an operator sees what the node is doing and not only which roles were overridden.

- **A misspelled role, or a value outside a role's own set, stops the node**, in the same report as the rest of the file's problems, rather than falling back to the preset.
- **`strandCohortMember: false` runs every strand as a client**: the node reads and writes each strand through the machines that store it, keeps no strand data under `storage.path`, and is in no strand's cluster. It then hosts no storage replicas, so a strand no app on the machine has claimed is only announced. A client needs a serving machine reachable to open a strand. See [A node that holds no strand blocks](https://github.com/gotchoices/sereus/blob/master/docs/cadre/node.md#a-node-that-holds-no-strand-blocks).

### Listen and announce addresses

| Key | Variable | Meaning |
|---|---|---|
| `network.listenAddrs` | `CADRE_LISTEN_ADDRS` | Multiaddrs to bind. Default: one TCP port chosen by the OS |
| `network.appendAnnounceAddrs` | `CADRE_APPEND_ANNOUNCE_ADDRS` | Addresses to advertise as well: how to publish a forwarded or public address |
| `network.announceAddrs` | `CADRE_ANNOUNCE_ADDRS` | Addresses to advertise instead of all others, a relay address included |
| `network.relayAddrs` | `CADRE_RELAY_ADDRS` | Circuit relays to reserve a slot on, each a dial address ending in the relay's peer ID |
| `network.webrtc` | `CADRE_WEBRTC` | Offer a WebRTC address as well, so peers reaching this node through a relay can go direct. Needs a relay. Default: off |
| `network.stunUrls` | `CADRE_STUN_URLS` | Comma-separated `stun:` URLs for `network.webrtc`, replacing the ones derived from the relays |
| `network.enableRelay` | `CADRE_ENABLE_RELAY` | Run a circuit-relay server. Default: the `alwaysOn` role, so on for a `server` and off for a `device` unless [`roles`](#node-roles) says otherwise |

Three more keys have no variable: `network.unauthorizedRelayReservationCap` (default `8`), `network.linkRoundTripMs` (default `3500`; set the same value on every machine of a party) and `network.cohortQueryTimeoutMs` (default: two link round trips). [Configuration](https://github.com/gotchoices/sereus/blob/master/docs/cadre/node.md#configuration) and [Deadlines and the link budget](https://github.com/gotchoices/sereus/blob/master/docs/network/deadlines.md) say what they govern.

- **Bindable transports.** A config file can bind TCP and WebSocket (`/ws`, `/wss`) addresses only. WebRTC has `network.webrtc` instead; a `/webrtc` entry written into `listenAddrs` is refused, since the flag is what also supplies the transport and the ICE servers.
- **Relays.** Name a relay in `relayAddrs`, not as a `/p2p-circuit` listen address. When no named relay grants a reservation on the first attempt, the start fails ([Relays](https://github.com/gotchoices/sereus/blob/master/docs/network/relay.md)).
- **Strand nodes.** The configured ports and announce addresses belong to the machine's control node. Each strand's node binds an OS-assigned port, so a forwarded port does not reach it.

### Direct connections over WebRTC

`network.webrtc: true` gives the node a WebRTC address alongside its relayed one, so a peer that reached it through a relay can move the connection onto a direct path and take those bytes off the relay ([Direct connections over WebRTC](https://github.com/gotchoices/sereus/blob/master/docs/network/relay.md#direct-connections-over-webrtc)). It is worth turning on for a machine behind NAT that other machines can only reach through a relay, and worth nothing on one with a public or forwarded address, which peers already dial directly.

It needs `network.relayAddrs`: WebRTC's connection setup is signalled over the relayed connection, so with no relay the node logs one line at start and runs unchanged. Off is the default, including in the Docker image.

**Platform support.** The transport is `@libp2p/webrtc`, which loads a `node-datachannel` native binary. Prebuilt binaries ship for Linux x64 and arm64 (both glibc and musl, so Alpine is covered), macOS x64 and arm64, and Windows x64 and arm64. An install never fails for want of one — the binaries are optional dependencies filtered by platform — but on a platform with no binary (32-bit ARM, for instance) a node with `network.webrtc: true` fails at start with an error naming `node-datachannel` and the platform. With the flag off, nothing WebRTC-related is loaded at all, so such a platform is unaffected.

### Strand change notifications

`strandReactivity` turns on change notifications on this node's strand nodes, so that an app on another machine is told when a strand table it watches changes, instead of polling. It is off when absent.

```yaml
strandReactivity:
  enabled: true          # required
  strandIds:             # optional; absent or empty means every strand this node runs
    - "<strand id>"
```

It takes effect at a restart or at the strand's next wake from hibernation, and should be enabled on every machine serving the strand. [Change notifications](https://github.com/gotchoices/sereus/blob/master/docs/strands/app-schema.md#change-notifications) says what enabling exposes and costs.

### Push credentials

A `push` block gives the node the FCM and APNs credentials with which a node wakes the party's suspended phones ([Push wake](https://github.com/gotchoices/sereus/blob/master/docs/strands/hibernation.md#push-wake)). The credentials alone send nothing: a node sends a wake only when the program that runs it reports strand activity with `CadreNode.notifyStrandActivity`, and `cadre start` never does (ticket `passive-strand-activity-fanout-detector`).

```yaml
push:
  fcm:
    projectId: my-firebase-project
    clientEmail: push@my-firebase-project.iam.gserviceaccount.com
    privateKey: "-----BEGIN PRIVATE KEY-----\n…"
  apns:
    keyId: ABC123DEFG
    teamId: TEAM123456
    bundleId: org.example.app
    privateKey: "-----BEGIN PRIVATE KEY-----\n…"
    production: true       # false or absent: Apple's sandbox host
  cooldownMs: 300000       # optional: minimum gap between wakes for one peer and strand
  debounceMs: 10000        # optional: window in which repeated activity on a strand sends one wake
```

Either platform block may be omitted. A block that is present must carry every field shown except `production`; a partial block stops the start. `CADRE_PUSH` supplies the whole block as one JSON object. Keep a config file that holds these keys readable by the node's account only.

### Environment variables

A variable overrides the config file. Lists are comma-separated, and booleans are `true`, `false`, `1` or `0`. A variable that is set but empty counts as unset, so a Compose default such as `${CADRE_ENABLE_RELAY:-}` does not override the file. An unrecognised `CADRE_*` variable stops the start, except names beginning `CADRE_HOST_`, which belong to cadre-host.

Besides the variables in the [Configuration](#configuration) tables, the commands read ten directly, each described with its option or route: `CADRE_HEALTH_PORT`, `CADRE_METRICS_PORT`, `CADRE_ADMIN_PORT`, `CADRE_STARTUP_TOKEN`, `CADRE_SEED_TOKEN`, `CADRE_OWNER_KEYS` (comma-separated owner keys to pin), `CADRE_CLAIM_SECRET`, `CADRE_INVITATION`, `CADRE_OWNER_GRANT` and `CADRE_OWNER_KEY_PASSPHRASE`.

`CADRE_CONFIG`, `CADRE_CONFIG_FILE` and `CADRE_DEBUG` are accepted too: the systemd unit and the Docker entrypoint read them.

## HTTP endpoints

### Health and status

Served on the health port without a credential.

- `GET /health`, `GET /`: 200 with `{ "status": "healthy" }` while the node runs. 503 with `starting` before that, or `unhealthy` on a node removed from its cadre.
- `GET /ready`: 200 with `{ "ready": true }` while the node runs, else 503.
- `GET /status`: 200 with the status object.

The status object is `HealthStatus` in [`src/server/health.ts`](src/server/health.ts). Besides the node's addresses, its party, and its strand and connection counts, it carries under `node` the `claim` state (`none`, `awaiting` or `claimed`, with `claimedBy`) and the `invitation`, `ownerGrant` and `removed` records.

### Metrics

`GET /metrics` on the metrics port answers in Prometheus text format: `cadre_node_running`, `cadre_node_uptime_seconds`, and gauges named `cadre_strands_*` (total and by state) and `cadre_connections_*` (total, relayed, direct, stuck on a relay, and by transport).

### Seed delivery

`POST /seed` on the health port exists only when `CADRE_SEED_TOKEN` is set. An orchestrator uses it to deliver a seed to a running node.

```bash
curl -X POST http://localhost:8080/seed \
  -H "Authorization: Bearer $CADRE_SEED_TOKEN" -H 'Content-Type: application/json' \
  -d '{"seed":"<encoded seed>"}'
```

It answers 200 with the result of applying the seed, 400 when the seed is malformed or refused, 401 without a matching token, and 413 for a body over 256 KiB. The token decides who may deliver a seed; the seed's signer must still be an owner key the node trusts or has pinned.

### Admin channel

`cadre start --admin-port <port>` binds an HTTP server on 127.0.0.1 for the `cadre enroll` commands and cadre-host. Every request carries `Authorization: Bearer <CADRE_STARTUP_TOKEN>`. Answers are `{ "ok": true, "data": … }` or `{ "ok": false, "error": { "code", "message" } }`, with the codes `not_authorized` (401), `bad_request` (400), `confirmation_required` (428), `not_ready` (503: the node is not started, or holds no owner key for a route that signs) and `internal` (500).

The routes, all under `/admin`, are `GET identity`, `GET multiaddrs`, `GET members[/:peerId]`, `DELETE members/:peerId`, `GET authorized-members[/:peerId]`, `POST add-drone`, `GET` and `POST invites`, `DELETE invites/:key`, `GET` and `POST owner-grants`, `DELETE owner-grants/:key`, `GET strands`, `DELETE strands/:id` (a closed strand needs `?confirm=1`) and `PUT invite-addresses`. The `AdminServer` comment in [`src/server/admin-server.ts`](src/server/admin-server.ts) gives each route's purpose, request body and answer.

## Files it writes

- **In the node's folder,** from `cadre init`: `cadre.yaml`, `cadre-peer.key` (identity key), `cadre-peer.id` (peer ID) and `claim.secret`.
- **In the node-state directory:**
  - `claim.json`: the claim's party, owner key and time, never the secret.
  - `removed.<partyId>.json`: the removal on record.
  - `owner.key`: the owner key, created by `cadre start --owner`, an owner grant or `cadre owner-key import`.
  - `trusted-owners.<partyId>.json`, `bootstrap-peers.<partyId>.json`, `enrolled-machines.<partyId>.json`, `strand-network.<partyId>.json`: the node's own stores ([Node-local state](https://github.com/gotchoices/sereus/blob/master/docs/cadre/node.md#node-local-state)).
- **Under `storage.path`:** a directory per strand and one for the control database, each holding that database's blocks, the node-local records that must survive a restart, the blob pieces this machine holds (`optimystic-pieces/`) and a `store.lock` naming the process that has the directory open.

Key and secret files are written with mode 600.

Back up the identity key, the owner key file if there is one, and the node-state directory. Losing the identity key changes the node's peer ID, and the cadre then no longer recognises the machine.

## Linux server deployment

For a single account, `cadre init` and [`cadre service`](#cadre-service) are enough. This layout is the sandboxed alternative: a dedicated `cadre` system account, the config in `/etc/cadre`, and everything the node writes in `/var/lib/cadre`. The unit, [`contrib/cadre-node.service`](https://github.com/gotchoices/sereus/blob/master/packages/cadre-cli/contrib/cadre-node.service), is fetched from the repository because the npm package does not carry it.

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin cadre
sudo mkdir -p /opt/cadre /etc/cadre /var/lib/cadre/data
sudo chown -R cadre:cadre /var/lib/cadre
cd /opt/cadre && sudo npm init -y && sudo npm install @serfab/cadre-cli

# identity key and claim secret, owned by the service account
sudo -u cadre /opt/cadre/node_modules/.bin/cadre enroll create --output /var/lib/cadre --name cadre-peer
sudo -u cadre sh -c 'umask 077 && node -e "console.log(require(\"crypto\").randomBytes(32).toString(\"base64url\"))" > /var/lib/cadre/claim.secret'

# config for a node that waits to be claimed
sudo tee /etc/cadre/cadre.yaml >/dev/null <<'EOF'
identity:
  keyFile: /var/lib/cadre/cadre-peer.key
controlNetwork:
  partyId: unclaimed
  bootstrapNodes: []
nodeClass: server
claim:
  secretFile: /var/lib/cadre/claim.secret
nodeState:
  dir: /var/lib/cadre
storage:
  type: file
  path: /var/lib/cadre/data
network:
  listenAddrs:
    - /ip4/0.0.0.0/tcp/4001
    - /ip4/0.0.0.0/tcp/4002/ws
  # appendAnnounceAddrs:                     # the name at which phones reach this machine
  #   - /dns4/node.example.com/tcp/4002/ws
EOF
sudo chown root:cadre /etc/cadre/cadre.yaml && sudo chmod 640 /etc/cadre/cadre.yaml

# the unit; it runs /usr/bin/node, so edit its ExecStart when Node.js is installed elsewhere
sudo curl -fsSL https://raw.githubusercontent.com/gotchoices/sereus/master/packages/cadre-cli/contrib/cadre-node.service \
  -o /etc/systemd/system/cadre-node.service
sudo systemctl daemon-reload
sudo systemctl enable --now cadre-node
journalctl -u cadre-node -f                                                            # expect "✓ Awaiting claim"
sudo -u cadre /opt/cadre/node_modules/.bin/cadre code -c /etc/cadre/cadre.yaml --qr    # the code to scan
```

- **Another way in.** For a seed, an invitation or an owner grant, set `controlNetwork.partyId` to the party's ID and remove the `claim` block. Put `CADRE_INVITATION` or `CADRE_OWNER_GRANT` in a drop-in (`sudo systemctl edit cadre-node`) for the first start and remove it afterwards.
- **The sandbox.** The unit runs the node as `cadre` with `ProtectSystem=strict`: the node can write only under `/var/lib/cadre`, which is why `nodeState.dir` is set.

## Docker

The image is built from a clone of the repository and needs no sibling repositories.

```bash
git clone https://github.com/gotchoices/sereus.git
cd sereus/packages/cadre-cli/docker
cp env.example .env          # set CADRE_PARTY_ID; CADRE_BOOTSTRAP_NODES may stay empty
docker compose up -d --build
docker compose logs -f cadre-node
```

- **Data.** The volume `sereus_cadre_data`, mounted at `/data`, holds the config (`cadre.yaml`), the identity key (`cadre-peer.key`), the storage and the node-state files. The entrypoint creates the key and the config on the first start, and the `CADRE_*` variables override the file on every start.
- **Ports and addresses.** 4001 and 4002 are published on all host interfaces, 8080 and 9090 on 127.0.0.1; `env.example` documents the `HOST_*` variables that change them. The node reports the container's addresses, so publish the host's with `CADRE_APPEND_ANNOUNCE_ADDRS`, including a `/ws` address for phones.
- **Joining.** Every variable in `.env` reaches the node: `CADRE_CLAIM_SECRET` (with `CADRE_PARTY_ID=unclaimed`), `CADRE_INVITATION` and `CADRE_OWNER_GRANT` work as they do outside a container.

To restore a backed-up identity key, stop the node and copy the file back to the same path.

```bash
docker compose cp cadre-node:/data/cadre-peer.key ./cadre-peer.key.bak    # back up the identity key
# other commands run inside the container, against the generated config:
docker compose exec cadre-node node /app/packages/cadre-cli/dist/bin/cadre.js code -c /data/cadre.yaml --qr
```

## Programmatic use

The package exports its config loader (`resolveConfig`, `loadValidatedConfig`), its HTTP servers (`HealthServer`, `AdminServer`) and its commands. `resolveConfig` returns the file's `storage` and `push` blocks as written; `src/commands/start-node.ts` shows how `cadre start` turns them into what `CadreNode` takes. A node with a health server and no storage block:

```typescript
import { resolveConfig, HealthServer } from '@serfab/cadre-cli';
import { CadreNode } from '@serfab/cadre-core';
import { nodeDefaultTransports } from '@serfab/cadre-core/node-default-transports';

const config = await resolveConfig('cadre.yaml');
const node = new CadreNode({
	privateKey: config.privateKey,
	controlNetwork: config.controlNetwork,
	nodeClass: config.nodeClass,
	strandFilter: config.strandFilter,
	network: { ...config.network, defaultTransports: nodeDefaultTransports },
	hibernation: config.hibernation,
	strandWatchInterval: config.strandWatchInterval,
});

const health = new HealthServer({ healthPort: 8080, metricsPort: 9090, nodeClass: config.nodeClass });
health.attach(node);
await health.start();

node.on('control:connected', () => console.log('Connected'));
await node.start();
```

## Limits

- **`cadre strand` and `cadre validation-key` cannot run beside a running node on the same file store.** They start a second node from the config, and a file store is owned by one process at a time. Stop the node first, or use the running node's admin channel for strands; it has no route for approver keys.
- **A seed is passed on the command line only.** `--seed` has no file or environment form, a seed grows with the number of machines it names, and Windows caps a command line near 32,000 characters.
- **A start-up invitation or owner grant is tried once.** The node does not retry a `retryable` failure; start it again.
- **The identity key file carries no checksum.** A file damaged inside the key bytes still loads, as a different peer ID (ticket `debt-identity-key-file-has-no-integrity-check`).

## License

MIT
