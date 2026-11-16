# Sereus

Sereus is a way for people and organisations to share SQL databases without a server that holds them. Parties connect by invitation, each shared database (a strand) lives on the participants' own devices, and those devices replicate the data to each other and enforce its rules. An app developer writes a schema in SQL and reads and writes the strand with SQL; Sereus handles identity, membership, replication and transport.

## Core concepts

- A **party** is a person or organisation. Its **cadre** is the set of nodes it runs: phone apps, browser tabs, home machines, servers.
- A cadre shares a private **control database**, which records the party's machines, its owner keys and the strands it takes part in.
- An **owner key** is a signing key a person holds. Its signature authorizes changes to the control database.
- A **strand** is an invitation-only SQL database shared among parties, on a network of its own. The application it runs is its **sApp**.
- Every member party serves a strand from its own nodes. No central server or global identity directory exists.

[Concepts](docs/concepts.md) explains the model and holds the glossary. The [documentation index](docs/README.md) lists every document by task and by subsystem.

## A first program

[Getting started](docs/getting-started.md) builds a Node.js program in which two parties share a database. Its central calls, excerpted from that walkthrough:

```js
// Party A founds a strand and invites.
const founded = await a.foundStrand({ strandId, type: 'o', sAppConfig: sApp });
const invitation = await a.createOpenInvitation(sApp.id, 24 * 60 * 60 * 1000);
const invitationText = a.encodeInvitation(invitation);

// Party B redeems the invitation, then both read and write with SQL.
const formed = await b.formStrand(b.decodeInvitation(invitationText), {
	partyId: b.partyId,
	purpose: 'getting started',
});
await aDb.exec('insert into App.Note (Id, Author, Body) values (?, ?, ?)', ['n1', 'a', 'written on A']);
```

The excerpt omits starting the nodes, publishing the invitation and attaching the strand on B; the walkthrough has every step.

## Packages

| Package | Purpose |
| --- | --- |
| [`@serfab/cadre-core`](packages/cadre-core) | The library that runs a cadre node: the control network, strand lifecycle, membership, invitations, and the edge node for phone and browser apps. cadre-cli, cadre-host, cadre-rn and the reference apps are built on it. |
| [`@serfab/cadre-cli`](packages/cadre-cli) | The `cadre` command: one headless always-on node from a config file, operator commands, and the node's Docker image. |
| [`@serfab/cadre-host`](packages/cadre-host) | Runs always-on nodes on a home machine for cadres owned by phones. A per-user service with a local web UI, UPnP port mapping, dynamic DNS and signed updates. Nodes join by QR claim or invitation. |
| [`@serfab/cadre-provider`](packages/cadre-provider) | Reference service for renting out nodes: an HTTP API with API-key and OAuth sign-in that runs each node as a Docker container. |
| [`@serfab/cadre-rn`](packages/cadre-rn) | React Native kit: phone node, secure key storage, polyfills, Metro configuration and native crypto. Imported by subpath only. |
| [`@serfab/quereus-plugin-sereus`](packages/quereus-plugin-sereus) | Quereus plugin that opens a strand as a SQL database. cadre-core uses it; tools and tests can use it directly. |
| [`@serfab/config-check`](packages/config-check) | Strict, dependency-free checking of a parsed config file, used by cadre-cli and cadre-provider. |
| [`reference-app-rn`](packages/reference-app-rn) | React Native sample chat app. |
| [`reference-app-ns`](packages/reference-app-ns) | NativeScript sample chat app (Android). |
| [`reference-app-web`](packages/reference-app-web) | Svelte and Vite sample chat app for the browser. |
| [`integration-tests`](packages/integration-tests) | Scenarios that run real nodes over real transports. Not published. |

[Architecture](docs/architecture.md) shows what depends on what.

## Technology stack

- [Quereus](https://github.com/gotchoices/quereus): the SQL engine. Schemas, constraints and queries.
- [Optimystic](https://github.com/gotchoices/Optimystic): the storage engine. Blocks, replication and distributed transactions.
- FRET (`p2p-fret`): the distributed hash table Optimystic uses to find the nodes that hold a block.
- [libp2p](https://libp2p.io/): connections, encryption and circuit relays.

## Repository layout

- `packages/`: the libraries and apps in the table.
- `docs/`: documentation. Start at the [index](docs/README.md). `docs/web/` is the source of the public site.
- `schemas/`: Quereus schemas. `control.qsql` (the control database), `strand.qsql` (the tables every strand carries), `chat.qsql` and `chat-simple.qsql` (sample app schemas).
- `ops/`: tooling for operating a relay.
- `scripts/`, `test-harness/`: release and check scripts, and test infrastructure shared across packages.
- `tickets/`, `tess/`: the ticket workflow; see [`tess/agent-rules/tickets.md`](tess/agent-rules/tickets.md).

## Contributing

The repository uses Yarn 4 workspaces. The root `package.json` links `@quereus/quereus` and the `@optimystic/*` packages to sibling checkouts, so clone `quereus` and `optimystic` beside this repository first.

```sh
yarn install
yarn build
yarn lint
yarn typecheck
yarn test
```

[Testing](docs/contributing/testing.md) says what each command needs and which of them a change must pass.

`.yarnrc.yml` is committed and holds no secret. It selects the `node-modules` linker, because Plug'n'Play breaks native modules and the stale-build guard, and it carries peer-dependency patches for React Native. Publishing needs an npm token, which stays out of the repository: set it with `yarn config set npmAuthToken <token> --home`, or export `YARN_NPM_AUTH_TOKEN`.

## Operating a relay

Nodes behind NAT are reached through a libp2p relay. [`ops/README.md`](ops/README.md) is the entry point for running one.

## Status

Sereus is under active development, and its APIs still change between releases. Each subsystem document ends with a "Limits and accepted tradeoffs" section that states what the shipped system does not guarantee; read the ones for the parts an app depends on before building on Sereus. Tests known to fail are recorded in `tickets/.pre-existing-known.md`, which [Testing](docs/contributing/testing.md) explains how to read.

## Credits

Sereus is a project of the GotChoices Foundation.
