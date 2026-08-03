----
description: The script operators run to check a deployed relay only confirms the relay says it supports relaying — it never actually relays anything through it. A misconfigured relay passes the check while silently dropping all traffic.
prereq:
files: ops/test/check-node.mjs, ops/test/README.md, ops/docker/libp2p-infra/src/main.ts
difficulty: medium
----

# The relay ops check does not prove a relay actually carries traffic

## What operators have today

`ops/test/check-node.mjs --relay` (documented in `ops/test/README.md` and in the
relay/bootstrap-relay quickstarts) dials the target node, runs identify, and then
does one thing for `--relay`: it looks at the protocol strings identify returned
and passes if any of them contains both "circuit" and "relay"
(`ops/test/check-node.mjs:165`, `:236`). The script's own output calls it
"heuristic".

That check passes on a relay that is configured to drop every byte it carries.

## Why that matters now

A relay hands each client a *reservation*. libp2p's circuit-relay library
defaults to stamping a small cap (~128 KiB / 2 minutes) onto every connection
made through that reservation, and libp2p then treats such a connection as
"limited": most protocol handlers refuse limited connections outright, so the
traffic disappears without an error the operator can see.

The deployed image now turns that default off, and exposes it as an environment
variable (`RELAY_APPLY_DEFAULT_LIMIT` — see
`ops/docker/libp2p-infra/README.md`). So the setting is now something an
operator can get wrong, on a per-host basis, with no signal: the relay comes up,
logs its peer ID, advertises the relay protocol, and passes the ops check —
while every cadre node that reserves on it silently loses connectivity.

There is no automated check anywhere in the repo — ops or unit — that would
catch this. The loopback relay tests in `packages/cadre-core/test/` stand up
their own relay with library defaults and opt every stream into limited
connections explicitly, so they exercise a configuration the deployment does not
use and would stay green either way.

## Expected behaviour

An operator who has just brought up a relay can run one command against it and
learn whether real traffic survives the trip, not merely whether the relay
claims to speak the relay protocol. Concretely, the check should reserve a slot
on the target relay from a scratch peer, have a second scratch peer dial the
first through the relay's circuit address, open an ordinary protocol stream with
no limited-connection opt-in, exchange a payload, and report the outcome — plus
whatever limit the relay stamped on the connection, so the operator can see the
configured cap rather than infer it.

Failure should be legible: "this relay is applying a 128 KiB / 120 s cap; cadre
traffic through it will be dropped — check `RELAY_APPLY_DEFAULT_LIMIT`" is the
message that saves the debugging session.

## Constraints worth knowing

- The existing scripts under `ops/test/` are deliberately dependency-light and
  are run by hand against **deployed** hosts, not in CI. A check that needs a
  live relay is consistent with that; it is not agent-runnable, and the README
  already marks the STUN check the same way.
- The relay's client-capacity setting (`RELAY_MAX_RESERVATIONS`) is the other
  half of the same configuration surface — reporting the relay's remaining
  capacity, if it can be observed, would be a natural companion but is
  secondary.
- Worth considering as a second arm at the same site: run the same reserve-and-
  relay exercise entirely on loopback against a locally spawned relay, so the
  repo gains one automated regression guard for the deployed relay's
  configuration that does not need a deployed host.
