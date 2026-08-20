----
description: A recent change made it an error to name a relay directly in a node's listen addresses, because doing so breaks startup. One test scenario still configures a node that way, so it now fails immediately instead of testing what it is meant to test.
files: packages/integration-tests/src/scenarios/push-wake-e2e.integration.ts, packages/cadre-core/src/relay-addrs.ts, packages/cadre-core/src/types.ts
difficulty: easy
repro: verified
----

# `push-wake-e2e`'s NAT'd receiver still uses the rejected `listenAddrs` relay shape

## What happens

```
$ yarn vitest run src/scenarios/push-wake-e2e.integration.ts -t "circuit-relay"
 × delivers a wake to a NAT'd receiver over a circuit-relay (signaling-first) dial
   → network.listenAddrs names a relay directly (/ip4/127.0.0.1/tcp/49675/ws/p2p/12D3…/p2p-circuit),
     which a control node cannot listen on: libp2p would dial that relay during control-database
     bring-up, when the node accepts no connections. Move the relay to network.relayAddrs, which
     reserves after bring-up.
   ❯ rejectConfiguredCircuitListenAddrs ../cadre-core/src/relay-addrs.ts:160:11
```

Deterministic — it fails in 1.4 s, before the scenario reaches any push-wake behaviour, so the test
currently proves nothing about push-wake either way.

## Why

`control-db-bring-up-runs-before-first-connection` (review commit `370ad30`) made control-database
bring-up run before the node opens any connection, and added
`rejectConfiguredCircuitListenAddrs` to fail loudly on the one configuration that cannot work under
that ordering: a hand-written `<relay>/p2p-circuit` entry in `network.listenAddrs`. libp2p dials
that relay from inside `listen()`, the bring-up quiet period denies exactly that dial, and
`libp2p.start()` aborts with an `UnsupportedListenAddressesError` that names nothing useful.

**The guard is correct and should stay.** What was missed is that
`push-wake-e2e.integration.ts:344` still configures its receiver the old way:

```ts
listenAddrs: [`${lAddr}/p2p-circuit`],
```

The ticket that added the guard updated `packages/cadre-cli/README.md`, `example.cadre.yaml`, and
`relay-only-control-addr.integration.ts`, but not this scenario. Its validation ran three
integration scenarios, and this was not one of them.

This is the only remaining live site. A repo-wide sweep for `p2p-circuit` in a listen position
finds everything else either using the bare `/p2p-circuit` search entry (allowed — that is the
route the guard explicitly permits) or asserting the rejection on purpose:

- `relay-only-control-addr.integration.ts:271,397` — bare search entry
- `reference-app-web/src/lib/cadre-web.ts:357` — bare search entry
- `cadre-node-control-node-options.spec.ts:511`, `cadre-node-announce-addrs-warning.spec.ts:103` —
  deliberately exercise the rejected shape

## What the fix has to preserve

Moving the relay from `network.listenAddrs` to `network.relayAddrs` is the prescribed replacement —
same relay, reservation driven after bring-up. But the scenario's name is a claim about behaviour
("a NAT'd receiver over a circuit-relay, signaling-first dial"), so the work is not done when the
error goes away:

- The receiver must still end up reachable **only** over a circuit address — assert that, rather
  than assuming it, so this cannot silently degrade into a direct-dial test later.
- `relayAddrs` reserves at the *end* of `start()` and a relay that grants no reservation on the
  first attempt (~10 s) fails startup. Check whether the scenario's relay is up and willing at that
  point in its setup, and whether its timings still hold.
- Confirm the sender still reaches the receiver through the relay after the ordering change, which
  is the actual thing the scenario exists to measure.

## Do not chase these while you are in here

Two other failures in the same suite run are **documented pre-existing** and belong to the
`control-db-cross-node-convergence-halted` class in `tickets/.pre-existing-known.md` (lines
111-113) — do not re-triage them, and do not let them block this ticket:

- `push-wake-e2e` → "wakes a member whose authorization and address were learned by control-DB
  replication, not local seeding" (`Block … unavailable (claimed-elsewhere)`)
- `control-delete-while-alone-convergence` (both tests)

Also documented and unrelated: `strand-formation-concurrent-redemption` (3 cases →
`secondary-index-seek-blind-to-sibling-rows`), `control-cohort-edge-carries-data` (→
`control-peer-row-refresh-invisible-to-third-node`), and `control-cohort-three-node-isolation`
(intermittent boot race).

Full-suite measurement this was found in: 8 failed / 242 passed / 1 expected fail of 251,
`tickets/.logs/garden-integration-2026-08-20.log`.
