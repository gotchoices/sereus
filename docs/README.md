# Sereus documentation

An index of the documentation by task and by folder. Every reader starts with [Concepts](concepts.md), which defines the terms the other documents use.

## I want to…

| Goal | Start here | Then |
| --- | --- | --- |
| Build an app | [Getting started](getting-started.md) | [Writing an app schema](schema-guide.md), the [API guide](api.md), and the platform guide for [React Native](platforms/react-native.md), [NativeScript](platforms/nativescript.md) or [the browser](platforms/browser.md) |
| Add a device or a second app to a cadre | [Adding and removing machines](cadre/membership.md) | [Several apps in one cadre](cadre/apps.md), [Owner keys](cadre/owner-keys.md) and [Removing a machine](cadre/removing-machines.md) |
| Run a node at home or on a server | [cadre-host README](../packages/cadre-host/README.md) for a home machine, [cadre-cli README](../packages/cadre-cli/README.md) for a server | [Which side dials](cadre/membership.md#which-side-dials) to choose how the node joins |
| Rent out nodes | [cadre-provider README](../packages/cadre-provider/README.md) | [Provider-hosted nodes](hosting/provider.md) |
| Operate a relay | [Operating Sereus relay infrastructure](../ops/README.md) | [Relays](network/relay.md) |
| Work on this repository | [Testing](contributing/testing.md) | [Gates](contributing/gates.md) and the root [`AGENTS.md`](../AGENTS.md) |
| Understand a subsystem | [Architecture](architecture.md) | The document it links to for that subsystem |

## The documents

### Top level

- [Concepts](concepts.md): the model and the glossary.
- [Architecture](architecture.md): the components, the packages and how they fit.
- [Getting started](getting-started.md): two parties sharing a SQL database, step by step.
- [cadre-core API guide](api.md): what each call promises, with events and errors.
- [Formation approval hook](formation-approval-hook.md): the HTTP contract of a service that approves strand joins.
- [Writing an app schema](schema-guide.md): tables, constraints and access rules for an sApp.

### cadre/: one party's control network and machines

- [The control schema](cadre/control-schema.md): the control tables, row authorization, schema versions.
- [Control database replication](cadre/control-replication.md): cluster sizes, catch-up, read and write retry.
- [How a party's machines converge](cadre/control-convergence.md): auto-connect, writes made while alone, change subscriptions.
- [Who a node trusts and admits](cadre/control-security.md): the anchor, seed trust, the connection gate, the protocol guard.
- [Owner keys](cadre/owner-keys.md): the signer, export and import, owner grants, removal.
- [Adding and removing machines](cadre/membership.md): seeds, claims, cadre invitations.
- [Removing a machine](cadre/removing-machines.md): the removal transaction, what the removed machine keeps, key replacement in closed strands.
- [Several apps in one cadre](cadre/apps.md): an app joining an existing cadre and moving its strands.
- [The cadre node](cadre/node.md): node classes, strand filter, configuration, keys, storage, the edge node.
- [A node's storage](cadre/node-storage.md): scope keys, when storage is opened, who closes it, the read cache, each platform's opener, the allotment.

### strands/

- [Strands: model and lifecycle](strands/lifecycle.md): the entry document for strands.
- [Inviting and joining](strands/formation.md): formation invitations, the protocol, the first-sync rule.
- [Closed-strand membership](strands/membership.md): members, managers, invitations, removal.
- [Closed-strand keys and what a joiner keeps](strands/keys.md): the read secret, membership keys, join records.
- [Writing to a strand](strands/writes.md): commit durability and offline mode.
- [App schemas](strands/app-schema.md): versions, upgrades, change notifications.
- [Strand hibernation and wake](strands/hibernation.md): states, wake paths, push wake.

### network/

- [Relays](network/relay.md): reservations and whom a relay serves.
- [How a strand's nodes find each other](network/strand-addressing.md): address resolution, saved network state, redial.
- [Deadlines and the link budget](network/deadlines.md): how deadlines derive from one declared round trip.

### hosting/

- [cadre-host design](hosting/cadre-host.md): the home-machine manager, its nodes, NAT and updates.
- [cadre-host management API](hosting/cadre-host-api.md): routes, events and writable settings.
- [Provider-hosted nodes](hosting/provider.md): how a rented node joins and what the provider sees.

### platforms/

- [React Native](platforms/react-native.md), [NativeScript](platforms/nativescript.md), [browser](platforms/browser.md): what an app on each platform must provide.
- [The reference apps](platforms/reference-apps.md): the three sample chat apps and their screens.

### contributing/

- [Testing](contributing/testing.md): commands, what a ticket stage runs, scenario conventions.
- [Gates](contributing/gates.md): what each automated check covers and cannot catch.
- [Releasing](contributing/releasing.md): publishing to npm and recovering a partial release.
- [Topology coverage map](contributing/topology-coverage.md): which scenario covers which network shape.
- [Device testing](contributing/device-testing.md): running the reference apps on devices.

### Outside `docs/`

- Package READMEs own install, run and reference material: [cadre-core](../packages/cadre-core/README.md), [cadre-cli](../packages/cadre-cli/README.md), [cadre-host](../packages/cadre-host/README.md), [cadre-provider](../packages/cadre-provider/README.md), [cadre-rn](../packages/cadre-rn/README.md), [quereus-plugin-sereus](../packages/quereus-plugin-sereus/README.md), [config-check](../packages/config-check/README.md), and the reference apps for [React Native](../packages/reference-app-rn/README.md), [NativeScript](../packages/reference-app-ns/README.md) and [the browser](../packages/reference-app-web/README.md).
- [`ops/`](../ops/README.md) holds the relay runbook and procedures.

[`web/`](web/README.md) in this folder is the source of the public website, not part of this documentation.

## Designs and work state

[`design/`](design/) holds designs that are not built. Each begins with a banner saying so, and nothing in them describes shipped behaviour.

- [Cadre control consistency model](design/control-consistency.md): committing control changes locally and replicating afterwards.
- [Sereus push network](design/push-network.md): waking phones without giving each node an app's push credentials.
- [Strand contracts](design/strand-contracts.md): human agreements attached to strands.

The other documents describe the system as it is. Current work, open defects and plans are in `tickets/` at the repository root, not here.
