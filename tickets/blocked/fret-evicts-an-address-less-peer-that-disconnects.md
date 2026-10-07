description: Always-on cadre members keep treating a phone that went offline as present, because the peer-discovery library only gives up on a peer after failing to dial it, and a phone has no address to dial. The library is a separate project; this ticket carries the proposed rule for a human to take across.
architecture: docs/architecture.md#enrollment-flow-invitation-redeemed-at-any-member
files: ../Fret/packages/fret/src/service/fret-service.ts (`nearProbeTargets`, `applyContactFailure`, `applyContactStrike`, `noteDisconnected`, the `peer:disconnect` listener, `sendLeaveToNeighbors`, `handleLeave`; read-only sibling), ../Fret/packages/fret/src/service/libp2p-fret-service.ts (`stop`), ../Fret/docs/fret.md ("Stabilization and churn handling" → failure detection; "Leave"), node_modules/libp2p/dist/src/components.js (`_invokeStartableMethod`), packages/integration-tests/src/scenarios/cadre-invite-any-member.integration.ts
repro: verified
difficulty: medium
----

**Blocked: a dependency outside this repo.** `../Fret` (the `p2p-fret` package, at v1.0.1, commit `3ff4f38`) is a read-only sibling. This unblocks when FRET ships the two-arm rule below and this workspace links a build that carries it. Nothing on FRET's own board (`../Fret/tickets/`) covers either arm as of 2026-10-07.

# A peer with no address never fails a contact, so it is never marked dead

## What was measured (2026-10-07)

A scratch scenario (owner A admits one always-on member M, A stops, M's FRET table entry for A is dumped once a second) ran in two shapes. Logs: `tickets/.logs/phone-owner-never-leaves-members-cohort.phone.log` and `...addressed.log`.

| Owner A | M's entry for A after the stop | A left M's control cohort after |
| --- | --- | --- |
| no listen address (`listenAddrs: []`) | `disconnected`, `member`, `contactFailures: 0` for the whole 45 s | not within 45 s (the implement pass saw the same over 300 s) |
| loopback WebSocket port | strikes at 1.5 s, 3.0 s, 4.5 s, then `dead` | 5.05 s |

In **both** shapes A's own leave notice failed: FRET logged `sendLeave to <M>: unreachable` during `A.stop()`, which completed in 8 ms. So M never hears a graceful departure either; only the dead verdict ever removes A, and only the addressed shape can reach it.

## Why

FRET marks a peer `dead` after `deadAfterFailures` (3) failed contacts spaced at least 500 ms apart, and only `dead` removes a peer from every ring view (`isLiveMember`). A contact is an outbound RPC; the near-probe pass selects its targets with `isDialable` (connected, or the peerStore holds an address), so a peer that is neither is never contacted, never fails, and stays a live member. A `peer:disconnect` is deliberately not a strike. A phone dials out and listens nowhere, so from a member's side it has no address and, once its connection drops, no way to be contacted.

The leave notice fails for a separate reason: libp2p's `components.stop()` runs every component's `stop()` under one `Promise.all`, and the connection manager's `stop()` closes every connection at once. FRET's facade sends leave notices inside `stop()`, after `discovery.stop()` and `unregisterRpcHandlers()`, by which time the connections are gone.

## Proposed rule (recommended default)

**Arm 1 — a near live member that cannot be contacted counts as a failed contact, once per tick.** In `nearProbeTargets` (or the pass that consumes it), a live member in the near window that `isDialable` rejects is routed through `applyContactFailure` instead of being dropped silently: it is a peer the pass would have probed and could not even attempt. The 500 ms spacing in `applyContactStrike` already makes each 1.5 s tick an independent observation, so the peer is `dead` after three ticks, the same ~5 s the addressed shape takes today. Recovery is unchanged: `peer:connect` and any inbound RPC call `noteProofOfLife`, which is exactly how an address-less peer comes back (it reconnects itself). The dead arm of the re-probe pass filters on dialability, so the peer is not probed while dead and costs nothing. The documented rule that an idle disconnect is not a strike stays true: the strike is for "cannot be contacted", observed per tick, not for the disconnect event.

Why not strike on the disconnect itself: one event cannot reach a threshold of three spaced observations, and a phone that reconnects within a tick or two should never be struck at all.

**Arm 2 — leave notices go out before connections close.** The facade implements `beforeStop()` (libp2p runs `beforeStop` across every component before any `stop`) and sends the leave fan-out there, or the core service's `stop()` is split so the fan-out precedes the connection manager's close. `handleLeave` then removes the departing peer at once. This is the graceful path only; a phone that is killed or loses network sends nothing, so arm 1 is the one the household shape depends on. Arm 2 is cheap and makes graceful departures immediate for every shape.

One thing arm 2 exposes, for the FRET change to decide: after `handleLeave` removes an entry, a later `peer:update` for that peer (any peerStore write: tags, protocols, addresses) re-creates it and `classifyByProtocols` labels it `member` again from the identify protocols the peerStore still holds. No sereus path writes to a departed phone's record today (`mergePeerAddrs` skips an empty address list), so this is a tripwire, not a defect here.

## Alternatives rejected

- **Optimystic's `findCluster` drops address-less members.** Declined by design in optimystic's own comment (shrinking the cohort below `clusterSize` puts the supermajority out of reach). It would also drop a *connected* phone: an inbound connection's address is not publishable, so a connected phone is address-less in the member's view yet reachable over the open connection.
- **cadre-core marks the entry dead itself** on `peer:disconnect` of a peer the peerStore holds no address for, through the public `FretService.getStore()` (`update(id, { state: 'dead' })`). This works today without a sibling change: `isLiveMember` honours the state, `noteDisconnected` never overwrites `dead`, and `peer:connect` resurrects. But it reaches past FRET's contact-strike seam from a consumer and duplicates the liveness rule outside the library that owns it, and it would have to be removed when FRET lands its own. Offered as an interim only if the household shape must work before a FRET release; the human decides.
- **The control write excludes unreachable cohort members.** Optimystic owns the commit; cadre-core cannot shrink the cohort a write is offered to.

## If nothing is done

The any-member invitation feature works only for owners with a listen address (an always-on owner machine). A phone owner's members cannot save any control change until the phone returns: admitting a device by invitation, `addDrone`, a self-address republish. Each attempt waits the whole commit budget (about 50 s) and fails with `Some peers did not complete: <A>`.

## Reversibility

Both arms are additive and change no wire format. Arm 1 adds strikes only for peers that could not have been probed anyway; arm 2 moves an existing fan-out earlier in shutdown.

## Reproduce here

In `cadre-invite-any-member.integration.ts`, pass `listenAddrs: []` in `buildA` and run the file: the wait "the stopped owner leaves <member>'s control cohort" times out. For the table-entry view, re-create the scratch scenario described above (owner plus one member, dump `fret.ensure().getStore().getById(aPeerId)` once a second after `A.stop()`) with `DEBUG='optimystic:fret*,sereus:integration:cohort'`.

The sereus-side follow-up (scenario switched to a phone-shaped owner, architecture doc stating the eviction rule) is `tickets/implement/phone-owner-never-leaves-members-cohort`, which names this ticket as its prerequisite.
