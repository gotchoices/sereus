description: A node that is told to use a forwarding server refuses to start when that server is unreachable. That is right for a machine an operator set up, and wrong for a phone, which has to start even with no network. Add a setting that makes the forwarding server optional instead of required.
files: packages/cadre-core/src/types.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/relay-addrs.ts, packages/cadre-core/test/cadre-node-relay-boot-failure.spec.ts, packages/cadre-core/test/cadre-node-control-node-options.spec.ts, docs/architecture.md
difficulty: easy
----

# `network.relayAddrs` gets an optional posture

## Terms

- **Relay** (circuit relay) — a libp2p node that forwards traffic on behalf of a node that cannot accept incoming connections. The forwarded-for node holds a **reservation** on the relay, and the `/p2p-circuit` address that reservation produces is the only address a phone or a browser tab ever has.
- `network.relayAddrs` — the `CadreNodeConfig` field naming the relays a node reserves on.

## The problem

`network.relayAddrs` is fail-fast in two separate ways, both deliberate and both documented in `relay-addrs.ts`'s module comment and on the field in `types.ts`:

1. a malformed entry throws when the config resolves (`relayCircuitAddrs`), and
2. a first reservation attempt that lands no `/p2p-circuit` address throws `RelayReservationFailedError` out of `CadreNode.start()` (`cadre-node.ts` → `driveControlRelayReservation`).

For `cadre-cli` the second one is correct: an operator who names a relay is saying this machine is not useful without it, so a dead relay should stop the boot loudly rather than leave a node nobody can reach.

It is the wrong answer for an edge node. `reference-app-web` says so in as many words in `cadre-web.ts`: it deliberately does *not* set `network.relayAddrs`, and calls `CadreNode.reserveRelays()` instead, because "a browser tab must still boot solo when its relay is down". But `reserveRelays` reaches the **control node only** — a strand node gets its supervised per-relay reservation from `network.relayAddrs` and from nothing else (`strand-network-config.ts` → `strandNodeAddrs`, `strand-instance-manager.ts` → `startRelaySupervisors`). That same comment in `cadre-web.ts` already records the gap and points at this plan ticket.

So today an edge node can have a fail-soft startup **or** reachable strand nodes, not both. Cross-party strand formation needs both: the invitee dials the host's control node from the invitation's bootstrap addresses, and then the host's strand nodes from the addresses the formation result carries (`strand-formation-cross-party-seed.integration.ts`). That is what `phone-becomes-reachable-through-a-relay` is blocked on.

## The change

Add one field to `NetworkConfig`:

```ts
/**
 * Must a relay named in {@link relayAddrs} have granted a reservation before
 * `start()` is allowed to succeed? Default `true` …
 */
requireRelay?: boolean;
```

`driveControlRelayReservation` is the only place that reads it: when the first attempt settles at a status other than `reserved` and `requireRelay` is `false`, log the status and return instead of throwing. Nothing else changes — the bare `/p2p-circuit` search listener is still added (`resolveListenAddrs`), the supervisor `reserveRelays` started still retries on its own backoff (2 s doubling to 60 s, `relay-reservation.ts`), and the node still gains its circuit address the moment the relay comes back.

Two things stay fail-fast at **both** postures, on purpose, and the field's doc comment should say so:

- **A malformed `relayAddrs` entry still throws at config resolution.** A typo is an operator error whatever the posture, and the alternative is a field that silently does nothing.
- **A `<relay>/p2p-circuit` entry hand-written into `listenAddrs` is still rejected** on the control node (`rejectConfiguredCircuitListenAddrs`). That rejection is about the listener *shape*, not about whether reachability is required.

A caller that sets `requireRelay: false` has to ask `CadreNode.getRelayReservationState()` whether the node is actually dialable, rather than inferring it from `start()` having resolved. Say that on the field.

## Why a field and not a change of default

`cadre-cli`'s existing behaviour is a decision somebody made for a reason that is written down (`relay-addrs.ts`: "Naming a relay that is down still means the control node does not come up"). The two node kinds genuinely want opposite answers, so the posture belongs in the config next to the addresses it governs. `requireRelay` mirrors the naming of `requireSignedSchemas`, which already sits on `CadreNodeConfig` for the same "fail-closed unless the embedder opts out" reason.

## Edge cases & interactions

- **`requireRelay: false` with an empty or absent `relayAddrs`.** `driveControlRelayReservation` already returns early on an empty list, so the flag is inert: no listener, no supervisor, `getRelayReservationState().status === 'none'`.
- **`requireRelay: true` (or absent) must behave exactly as today.** `cadre-node-relay-boot-failure.spec.ts` already pins the whole failed-start contract — rejection, `isRunning === false`, posture cleared to `none`, control database null, `control:disconnected` emitted after `control:connected`. That spec must keep passing untouched.
- **A failed-but-tolerated start leaves a live supervisor.** With `requireRelay: false` the node stays up, so `stop()` — not `cleanup()` — is what stops the supervisor. Confirm `CadreNode.stop()` stops `relayReserveSupervisor` on this path, so a stopped node leaves nothing dialing a relay.
- **The relay comes back later.** The supervisor re-drives on its own; assert the posture moves from `retrying` to `reserved` and that `getMultiaddrs()` gains a `/p2p-circuit` entry without anyone calling `reserveRelays` again.
- **An explicit `reserveRelays()` call afterwards.** It stops the boot supervisor and replaces it (`reserveRelays` stops first, unconditionally). A `requireRelay: false` node that a caller later re-points at a different relay list must end with exactly one supervisor.
- **Strand nodes are unaffected either way.** They are already fail-soft (`awaitFirstRelayAttempts` never throws). This change must not make a strand launch fail, and `requireRelay` must not propagate into a strand node's posture.
- **Bring-up ordering is unchanged.** The reservation is still driven at the very end of `start()`, after the control database is built against a cohort of one. Do not move it.

## Tests

In `cadre-core/test/`:

- a node with `network: { listenAddrs: [], relayAddrs: [<dead relay>], requireRelay: false }` **starts** — `start()` resolves, `isRunning === true`, `getControlDatabase()` is non-null, and `getRelayReservationState().status` is `retrying` (not `error`, not `none`) with a non-null `retryAtMs`;
- `stop()` on that node resolves and leaves the posture at `none`, with no supervisor still driving;
- the existing dead-relay spec, unchanged, still rejects with `RelayReservationFailedError` when `requireRelay` is absent, and also when it is explicitly `true`;
- a malformed `relayAddrs` entry throws at start with `requireRelay: false` — the validation half is not softened;
- `cadre-node-control-node-options.spec.ts`: the resolved listen set still carries the bare `/p2p-circuit` search entry when `requireRelay` is `false`, so a tolerated start still has somewhere for a later reservation to land.

## TODO

- Add `requireRelay?: boolean` to `NetworkConfig` in `packages/cadre-core/src/types.ts`, documented as above: default `true`, what it does and does not soften, and that a `false` caller must read `getRelayReservationState()` to learn whether it is dialable.
- Read it in `driveControlRelayReservation` (`packages/cadre-core/src/cadre-node.ts`): log-and-return instead of throwing when the first attempt did not land and `requireRelay === false`. Keep the `RelayReservationFailedError` path byte-for-byte for the default posture.
- Update the fail-fast paragraph in `relay-addrs.ts`'s module comment and the `relayAddrs` doc comment in `types.ts` so both postures are described in one place.
- Add the specs listed above; confirm `cadre-node-relay-boot-failure.spec.ts` passes unmodified.
- `docs/architecture.md` (Relay Integration): note that a configured relay can be required or optional, and which node kinds use which.
- Run `yarn workspace @serfab/cadre-core test`, `yarn workspace @serfab/cadre-core typecheck`, `yarn lint`.
