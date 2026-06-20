----
description: Before enabling self-hosted TURN, close the SSRF gap in coturn's denied-peer-ip set (IPv4-mapped IPv6 ::ffff:0:0/96 is currently not denied) and validate the full denied-peer-ip set with the real coturn binary (turnserver -n). Dormant while TURN is off; a hard prerequisite before TURN_ENABLED=true.
prereq: webrtc-stun-turn-infrastructure
files: ops/docker/coturn/turnserver.conf, ops/docker/coturn/entrypoint.sh, ops/docker/coturn/README.md
difficulty: easy
----

## Problem

`webrtc-stun-turn-infrastructure` ships a `denied-peer-ip` SSRF allow/deny set in
`ops/docker/coturn/turnserver.conf` whose comment claims it denies "every
non-public IPv4/IPv6 range so a relayed peer can never reach internal services."
That claim is **incomplete** for a dual-stack TURN deployment:

- **IPv4-mapped IPv6 is not denied.** The set denies RFC1918/CGNAT/etc. as IPv4
  literals, and denies IPv6 loopback/ULA/link-local, but does **not** deny the
  IPv4-mapped range `::ffff:0:0/96` (e.g. `::ffff:10.0.0.1`). On a coturn bound to
  a dual-stack socket, a TURN client can request a peer at `::ffff:<private-v4>`
  and reach internal IPv4 services the v4 deny rules were meant to block — a known
  TURN SSRF bypass.
- **The deny set has never been parsed by the real coturn binary.** coturn is not
  installed in the agent/CI environment, so the implement/review passes only
  validated config *structurally* (template render + grep). A malformed
  `denied-peer-ip` range (especially the IPv6 ranges) could be silently rejected
  or mis-parsed at startup. This must be confirmed with `turnserver -n -c <active>`
  (dry-run config check) on a real coturn before trusting it in production.

This is **dormant** while TURN stays off (STUN never relays, so `denied-peer-ip`
is inert), but it is a **hard prerequisite** before flipping `TURN_ENABLED=true`.

## Requirements / specifications

- Add a `denied-peer-ip` entry covering the IPv4-mapped IPv6 range
  (`::ffff:0:0/96`, i.e. `::ffff:0.0.0.0`–`::ffff:255.255.255.255`) in coturn's
  accepted syntax. Consider also `::/128` (unspecified) and any NAT64
  (`64:ff9b::/96`) range relevant to the deploy posture.
- Validate the **complete** rendered active config (TURN-enabled variant) with the
  actual coturn binary via `turnserver -n -c <active>` (no-process dry run) — not
  just grep. Capture the command/output in the coturn README so it is repeatable.
- Reconcile the deny-set comment in `turnserver.conf` with whatever is actually
  enforced (don't claim coverage the rules don't provide).
- Cross-check against coturn's own built-in protections so the explicit deny set
  and coturn defaults don't contradict each other.

## Use cases

- An operator enables TURN; a relayed (potentially hostile) peer cannot pivot to
  the host's private network over either IPv4 or IPv4-mapped IPv6.

## References

- `ops/docker/coturn/turnserver.conf` (the `# --- Abuse / SSRF controls ---` block).
- `tickets/backlog/turn-credential-issuance-service.md` (the other TURN-enablement gate).
- coturn `denied-peer-ip` / `allowed-peer-ip` docs; STUN/TURN SSRF guidance.
