----
description: Review the IPv4-mapped IPv6 and NAT64 SSRF hardening applied to coturn's denied-peer-ip list and the README binary validation step.
files: ops/docker/coturn/turnserver.conf, ops/docker/coturn/README.md
prereq: webrtc-stun-turn-infrastructure
difficulty: easy
----

## What was implemented

Two files were edited to close TURN SSRF bypass vectors and document binary config validation.

### `ops/docker/coturn/turnserver.conf`

The IPv6 deny block was expanded from 3 entries to 7:

```
# IPv6 — loopback, unspecified, unique-local (fc00::/7), link-local (fe80::/10),
# IPv4-mapped (::ffff:0:0/96), and NAT64 well-known + local-use prefixes
# (64:ff9b::/96, 64:ff9b:1::/48 — RFC 6052/8215). Without these, a TURN client
# on a dual-stack socket can reach private IPv4 services via ::ffff:<private> or
# 64:ff9b::<private> even when all v4 literals are denied.
denied-peer-ip=::
denied-peer-ip=::1
denied-peer-ip=::ffff:0:0-::ffff:ffff:ffff
denied-peer-ip=64:ff9b::-64:ff9b::ffff:ffff
denied-peer-ip=64:ff9b:1::-64:ff9b:1:ffff:ffff:ffff:ffff:ffff
denied-peer-ip=fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff
denied-peer-ip=fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff
```

The section header comment was also updated to accurately claim coverage of "IPv4-mapped and NAT64 prefixes".

### `ops/docker/coturn/README.md`

A new "Config parse check" subsection was added under **Validate** with a two-step render + `timeout 3 docker run` one-liner and a `grep` filter for error lines.

## Testing notes / known gaps

- The binary check (`timeout 3 docker run coturn/coturn ...`) was **not run** during implement — it requires Docker and a live coturn image pull. The README step is the prescribed manual validation path.
- The COTURN_RENDER_ONLY render step was also not executed (no running entrypoint.sh environment). The template substitution variables (`${LISTENING_PORT}`, etc.) remain as-is in the conf template; rendered output should be verified manually per the README instructions.
- Coturn range notation (`start-end`) for IPv6 has been used consistently with the pre-existing entries — reviewers should confirm coturn accepts these specific ranges against an actual binary.
- `64:ff9b:1::/48` end address was computed as `64:ff9b:1:ffff:ffff:ffff:ffff:ffff` — verify this is the correct last address for that /48.
