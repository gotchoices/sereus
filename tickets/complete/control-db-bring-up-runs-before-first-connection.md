---
description: A machine that could only reach the network through a relay failed to finish starting up when it booted before the relay had learned it was a member. Every node now builds its own copy of the shared database while it is still alone, and only reaches out afterwards.
files: packages/cadre-core/src/relay-addrs.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/membership-connection-gater.ts, packages/cadre-core/src/relay-reservation.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/relay-addrs.spec.ts, packages/cadre-core/test/cadre-node-relay-boot-failure.spec.ts, packages/cadre-core/test/cadre-node-control-node-options.spec.ts, packages/cadre-core/test/membership-connection-gater.spec.ts, packages/cadre-core/test/strand-instance-manager-announce-addrs.spec.ts, packages/integration-tests/src/harness/slow-raw-storage.ts, packages/integration-tests/src/scenarios/relay-only-control-addr.integration.ts, packages/integration-tests/src/scenarios/control-bring-up-quiet-period.integration.ts, docs/architecture.md, packages/cadre-cli/README.md, packages/cadre-cli/example.cadre.yaml
---

# Complete: control-database bring-up runs before the first connection

## What shipped

A node used to build its control database — the party's shared membership tables —
right after its network layer came up, and building it is not a local operation: it
is a long chain of block probes that consult the node's Optimystic cohort, which
includes every connected same-party peer. A sibling that had not yet replicated the
booting node's `CadrePeer` row correctly refused those probes, so bring-up died with
`BlockUnavailableError` and `start()` rejected. Retrying could never converge, because
the thing that clears the refusal is the booting node's own row reaching the sibling,
and writing that row needs the database the retry is building.

Two changes fix it, both about ORDERING rather than retrying:

- **`network.relayAddrs` reserves after bring-up.** It now resolves to libp2p's bare
  `/p2p-circuit` SEARCH listener, which opens no connection, and `CadreNode.start()`
  drives the reservation explicitly at the very end
  (`driveControlRelayReservation`) — after `ControlDatabase.initialize()`, ahead of
  self-registration so the first published row already carries the circuit address.
  A first attempt that does not land throws `RelayReservationFailedError`, which keeps
  the field fail-fast with a message that names the relay and the actual reason.
  Strand nodes stay on the per-relay CONFIGURED listener: nothing drives an explicit
  reservation for them, and their protocol ids are namespaced so a relay is never in
  a strand's cohort.
- **A bring-up quiet period on the connection gate.** While
  `ControlDatabase.initialize()` is in flight the membership gater denies both
  `denyDialPeer` and `denyInboundEncryptedConnection` before consulting the per-peer
  policy at all. That turns "nothing should connect here" from an accident of ordering
  into a property, and it is what catches the `controlNetwork.bootstrapNodes` arm,
  where `@libp2p/bootstrap` fires ~1 s after `libp2p.start()`.

Full design rationale lives in the code: `relay-addrs.ts` and `relay-reservation.ts`
module docs, `membership-connection-gater.ts` → "The bring-up quiet period",
`CadreNode.driveControlRelayReservation`, and `docs/architecture.md` →
"Reservations are requested explicitly, not discovered".

## Review findings

Read the implement diff (25 files, `85715c3`) before the handoff summary. Then traced
each claim to its site, checked the three in-repo consumers of the changed seams, and
re-ran everything.

### Fixed in this pass

**1. A failed relay reservation left a half-dead node behind it.** `cleanup()` was not
the complete teardown — `stop()` privately held the relay-supervisor stop and the
`_running = false` reset. That was harmless while nothing after `_running = true`
could throw, and this ticket made something throw there: `driveControlRelayReservation`
runs at the end of `start()`. So a node whose relay was down rejected `start()` and
then reported `isRunning === true` over a torn-down libp2p node (an embedder's retry
early-returns "already running" and silently does nothing), while a reservation retry
loop kept dialing that stopped node on an unref'd timer nothing would ever clear —
precisely the failure `stop()`'s own comment says it exists to prevent. Reachable
today by any operator whose `CADRE_RELAY_ADDRS` relay is down.

Fixed at the invariant rather than the instance: `cleanup()` now owns the whole
teardown (supervisor stop first, before the control node goes down; posture reset;
`_running = false` last, after the steps that early-return when it is false), and
`stop()` adds only the `control:disconnected` emit. Any future throw after
`_running = true` is now safe by construction. Side effect worth noting:
`bug-relay-drive-not-cancellable`'s second arm already asserted "`CadreNode.stop()`/
`cleanup()` already stop the supervisor" — that sentence was wrong when written and
is true now, so that ticket's stated premise holds.

**2. `control:connected` was emitted and then `start()` rejected, with no closing
edge.** Named as gap 4 of the handoff and accepted there as a cost; it is not one.
`cadre-cli`'s `node-session.ts` resolves its startup wait on that exact event, and an
embedder driving UI from the pair was left showing "connected" for a node that never
came up. `start()`'s catch now emits `control:disconnected` when it had already
emitted the connected edge.

Both are pinned by a new `packages/cadre-core/test/cadre-node-relay-boot-failure.spec.ts`:
a node whose only reachability is a relay on a refused port rejects with
`RelayReservationFailedError`, ends up `isRunning === false` with reservation status
`none` and no control database, emits exactly `[connected, disconnected]`, and can be
started again rather than the failure being sticky.

**3. A hand-written `<relay>/p2p-circuit` entry in `network.listenAddrs` could no
longer boot a control node — silently, and with an unreadable error.** That is the
CONFIGURED listener shape, which libp2p dials from inside `listen()`; the new quiet
period denies exactly that dial, and the transport manager's default `FATAL_ALL`
turns the refusal into `UnsupportedListenAddressesError` out of `libp2p.start()`.
Traced through `@libp2p/circuit-relay-v2`'s `listener.js` → `openConnection` →
`libp2p/dist/src/connection-manager/dial-queue.js:263`. The config surface is real —
`circuitRelayTargets()` and `warnIfAnnounceAddrsDiscardRelay` both handle it, and the
diff added a unit test asserting it still produces announce targets.

Resolved by CLOSING the surface loudly instead of restoring it: `resolveListenAddrs`
on the `'search'` route now throws at config resolution, naming the offending entries
and pointing at `network.relayAddrs`, which is an exact replacement (same relay,
reservation driven after bring-up). Making it work instead would mean folding such
entries into the reservation drive across several sites — a design change, not a
review fix. **A maintainer who wants the surface back should reverse this rather than
re-derive it**; the reasoning is recorded at the site
(`relay-addrs.ts` → `rejectConfiguredCircuitListenAddrs`). No existing test broke —
`warnIfAnnounceAddrsDiscardRelay` resolves on the configured route and runs earlier in
`start()`, so its spec is untouched. Docs updated where the surface was described:
`docs/architecture.md`'s `NetworkConfig` listing, `example.cadre.yaml`,
`cadre-cli/README.md`'s `CADRE_LISTEN_ADDRS` row.

**4. Gap 5 of the handoff — strand nodes kept on the configured route by reasoning,
not by a test — is now pinned.** One case in
`strand-instance-manager-announce-addrs.spec.ts` (whose mocks already record exactly
what reaches `createLibp2pNode`, so no fourth copy of that boilerplate): an inherited
`relayAddrs` resolves to `<relay>/p2p-circuit`, not the bare search entry. Without it,
a future "unify the two routes" edit leaves every NAT'd strand node holding a pending
reservation nobody fills, undialable and silent.

### Recorded as a tripwire, not a ticket

- **The quiet period ends at `initialize()`, not at the end of `start()`** (gap 2 of
  the handoff). The awaited control-DB work after it — `strandWatcher.start()`'s first
  poll — can therefore run against a cohort a connection just joined. Genuinely
  conditional: every block that poll reads was created locally by the `initialize()`
  above, so a refusing sibling has nothing to refuse. `NOTE:` parked at the clear site
  in `cadre-node.ts` → `start()`, including the reason NOT to naively move the clear
  later — `handleStrandAdded` runs inside `strandWatcher.start()` and seeds each strand
  node from CONNECTED siblings, so a longer window trades a bring-up hazard for
  boot-time strand seeds that are always empty.

### Checked and found clean — no action

- **`denyDialPeer` composition** (gap 3). Deny-from-either is correct and unit-tested,
  and it is inert for a policy without `bringUpInFlight`. Checked every in-repo gater
  supplier: `reference-app-web` passes `{ denyDialMultiaddr }` only, the
  integration harness passes test gaters whose deny hooks still win, and strand nodes
  get no membership gater at all. Nothing relied on the hook being absent.
- **Gap 1, the four-link convergence chain for a node authorized after it booted.**
  Not re-derived. The measurement behind its withdrawal is already an arm on
  `bug-control-reads-not-retried-on-transient-failure`, the scenario file's header
  states the withdrawal and why, and the surviving link-2 assertion is real coverage.
  Filing anything further would duplicate an open ticket.
- **Source hygiene.** `cadre-node.ts` is 5478 lines and already carries
  `debt-cadre-node-single-file-size` in `backlog/`; this pass's net addition is ~50
  lines, all inside existing methods, so it is evidence on that ticket rather than a
  new one. `relay-addrs.ts` (218) and `membership-connection-gater.ts` (533) are fine.
  The new helpers are single-purpose and named rather than commented blocks.
- **`slow-raw-storage.ts`.** 128 lines of pure delegation with one added behaviour;
  it makes the bootstrap arm deterministic instead of a race, and the scenario's
  elapsed-time assertion keeps it from going vacuous.
- **Docs.** Read every file the change touched plus the ones it should have: the two
  module docs, `NetworkConfig.relayAddrs`, `docs/architecture.md`'s route table,
  connection-gate bullet and `NetworkConfig` listing, both READMEs,
  `example.cadre.yaml`, `cadre-web.ts`. The "two routes are alternatives" warning is
  gone everywhere it appeared. `docs/testing.md` needed nothing — it documents the
  build-freshness guard, not the harness module list.
- **Pre-existing failure.** `control-cohort-cold-start-retry.integration.ts` was
  already triaged by the runner in `b7fecd4` into `tickets/fix/cold-start-redial-assertion-has-no-teeth`;
  `.pre-existing-error.md` is gone. Nothing re-reported.

## Validation

`yarn lint` clean. `@serfab/cadre-core`, `@serfab/cadre-cli` and
`@serfab/integration-tests` all build. `yarn workspace @serfab/cadre-core test` —
**1644 passed, 1 skipped, 104 files** (up 6 tests / 1 file from the handoff's 1638).
From `packages/integration-tests`, `yarn vitest run` over
`relay-only-control-addr`, `control-stream-authz`, `membership-connection-gater`,
`control-bring-up-quiet-period` and `control-cohort-auto-convergence` — **12 passed**,
with the quiet-period scenario's anti-vacuity check reporting bring-up at 2600 ms
against the 1000 ms bootstrap fuse.
