description: The routing library our shared workspaces use to find and reconnect members gives each reconnect attempt a fixed two seconds, too short to open a connection through a relay on a slow phone link, so two phones that restart may never find each other again. The fix belongs in that library, which this repository may not change.
files: ../Fret/packages/fret/src/service/fret-service.ts (MAINTENANCE_RPC_TIMEOUT_MS ~339; sendPing call sites ~1686, ~1764, ~2592, ~2812), packages/cadre-core/src/link-budget.ts (relayedDialBudgetMs, optimysticDialLimits)
----
# Upstream (FRET): maintenance pings dial within a 2 s whole-call budget

**Blocked on:** a dependency outside this repo (`../Fret`, read-only per `tickets/rules/sibling-repos.md`). Unblocks when FRET dials peers it has to reconnect to on a budget that can cover a relayed dial on the host's declared link, and Sereus adopts that release. Filed in `../Fret` as `tickets/fix/maintenance-ping-dial-budget-below-a-relayed-dial`.

## The finding

`FretService` pings a peer with `dial: true` and `timeoutMs: MAINTENANCE_RPC_TIMEOUT_MS` (2000 ms) — a budget for the whole call, opening the connection included. The constant's comment reasons about a ping on an open connection ("a ~50-byte round trip"); it does not cover the dial. On a strand whose members reach each other only through a relay, after a restart these pings are the only thing that redials a peer (Sereus's side of that is `implement/strand-peers-redial-on-the-declared-link-budget`), and a relayed dial on a slow link takes longer than 2 s, so the connection is never re-established.

Evidence (Sereus scratch arm of `joiner-first-commit-over-slow-relay.integration.ts`, 20 ms per-frame cap, event loop 70% busy, `DEBUG=libp2p:connection-manager:dial-queue*`): after the joiner restarted, both strand nodes dialed each other 32 times over 180 s; every attempt was aborted 2.05 s after it started, almost all as `EncryptionFailedError: This operation was aborted` (the Noise handshake over the circuit). The one successful relayed connection in that run took about 9 s to open. Sereus declares a 3.5 s link round trip by default and budgets a relayed dial at 21.5 s (`relayedDialBudgetMs`); libp2p's own per-address limit, which Sereus sets through Optimystic, is 39 s.

## Proposed text for FRET's ticket

"A maintenance ping that has to OPEN a connection is bounded by the 2 s maintenance budget, which a relayed dial on a slow link cannot meet, so FRET never reconnects such a peer. Split the budget: keep 2 s for the exchange on an open connection, and bound the dial by a host-supplied dial budget (a `dialTimeoutMs` option, defaulting to today's behaviour), or skip the dial in maintenance (`dial: 'never'`) and leave reconnection to a path with a link-sized budget."

Alternatives considered: raising the constant outright (rejected: a long ping holds a stabilization tick open, which the constant's comment rightly guards against); doing nothing upstream (Sereus's redial supervisor then remains the only reconnection path, which works but duplicates what FRET is for).

## What Sereus does when it lands

- Adopt the release; pass the declared link's relayed-dial budget if FRET takes an option.
- Re-run the slow-restart arm (`strand-peers-redial-on-the-declared-link-budget` adds it) with Sereus's own redial disabled, to see whether FRET alone now reconnects; if it does, decide whether Sereus's supervisor stays as a backstop or goes.

## Resolved upstream

FRET `maintenance-redial-off-the-tick` (p2p-fret 1.1.0) moved the redial off the stabilization tick with its own `dialTimeoutMs`, and Optimystic 1.15.0 (`0-fret-dial-timeout-from-the-node-dial-timeout`, filed from here) sets it from the node's `connectionManager.dialTimeout` (39 s on Sereus's declared link). Adopted in 35a0bf08; `joiner-first-commit-over-slow-relay`'s two restart arms pass (336 s, 200 s). Not done: re-running those arms with Sereus's own strand redial disabled, to measure FRET's redial alone.
