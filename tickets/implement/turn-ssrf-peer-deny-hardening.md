----
description: Close the IPv4-mapped IPv6 SSRF bypass in coturn's denied-peer-ip list, add NAT64 deny coverage, reconcile the comment, and document a manual binary validation step in the README.
files: ops/docker/coturn/turnserver.conf, ops/docker/coturn/README.md
prereq: webrtc-stun-turn-infrastructure
difficulty: easy
----

## Problem (reproduced / researched)

`turnserver.conf` denies every RFC 1918/CGNAT/special-use **IPv4** range
(lines 51-64) and IPv6 loopback/ULA/link-local (lines 66-69), but is **missing**:

1. **`::ffff:0:0/96` — IPv4-mapped IPv6.** On a dual-stack coturn socket a TURN
   client can request a relay peer at `::ffff:10.0.0.1` (or any other
   `::ffff:<private-v4>`) and reach internal IPv4 services that the v4 rules were
   meant to block. This is a known TURN SSRF bypass.

2. **`64:ff9b::/96` — NAT64 well-known prefix (RFC 6052).** A peer at
   `64:ff9b::10.x.x.x` is the NAT64 encoding of a private IPv4 address. Any
   deployment that traverses a NAT64 gateway is vulnerable to the same pivot.

3. **`64:ff9b:1::/48` — NAT64 local-use prefix (RFC 8215).** Same principle;
   used by operators who deploy NAT64 with a site-local prefix.

The comment above the deny block claims it covers "every non-public IPv4/IPv6
range" — that is inaccurate until all three gaps are closed.

Additionally, the deny set has never been passed through the real coturn binary.
The README's "Validate" section only covers a live STUN check, not a config
parse-error check.

## Fix

### `ops/docker/coturn/turnserver.conf`

**Extend the IPv6 block** with three new `denied-peer-ip` entries and correct the
comment.  coturn uses start–end range notation (not CIDR).

Replace the current IPv6 comment + three entries (loopback / ULA / link-local):

```
# IPv6 — loopback, unique-local (fc00::/7), link-local (fe80::/10).
denied-peer-ip=::1
denied-peer-ip=fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff
denied-peer-ip=fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff
```

with:

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

Also update the section header comment to say "every non-public IPv4/IPv6 range,
**including IPv4-mapped and NAT64 prefixes**".

### `ops/docker/coturn/README.md` — add binary validation step

coturn has no `--dry-run` / `--check-config` flag.  The only way to confirm the
deny set parses correctly is to start coturn against the rendered config and
inspect stdout for errors before it finishes binding.  Add a subsection under
**Validate**:

```
### Config parse check (requires Docker / a coturn binary)

Render the active config locally, then run coturn briefly against it:

```bash
# 1. Render
COTURN_RENDER_ONLY=1 LISTENING_PORT=3478 HOST_BIND_IP=0.0.0.0 \
  REALM=sereus TURN_ENABLED=true TURN_SECRET=fake-secret-for-validation \
  COTURN_TEMPLATE=./turnserver.conf COTURN_ACTIVE_CONF=/tmp/active.conf \
  bash ./entrypoint.sh

# 2. Binary check (Docker; kill after a second — we only need the parse output)
timeout 3 docker run --rm \
  -v /tmp/active.conf:/etc/coturn/turnserver.conf \
  coturn/coturn turnserver -c /etc/coturn/turnserver.conf 2>&1 | \
  grep -Ei '(error|warning|fatal|denied.peer|unknown|cannot)' || true
```

A clean parse shows only startup/bind lines; any `Unknown config option` or
`ERROR` line indicates a rejected directive (fix before enabling TURN).
```

## Coturn built-in vs explicit rules

coturn's `no-loopback-peers` blocks `127.0.0.1` and `::1` specifically.  The
explicit `denied-peer-ip` entries are additive and do not conflict — they extend
coverage to ULA, link-local, mapped, and NAT64 ranges that coturn's built-ins do
not cover.  The new `denied-peer-ip=::` (unspecified address) is belt-and-suspenders;
it is not the same as loopback and coturn does not block it by default.

## TODO

- Edit `ops/docker/coturn/turnserver.conf`:
  - Replace the IPv6 comment block with the expanded version above (loopback,
    unspecified, `::ffff:0:0/96`, NAT64, ULA, link-local — 7 entries).
  - Update the section header comment to mention IPv4-mapped and NAT64.
- Edit `ops/docker/coturn/README.md`:
  - Add "Config parse check" subsection under **Validate** with the
    render + `timeout 3 docker run` one-liner and grep filter.
- Verify the rendered template (COTURN_RENDER_ONLY=1) contains the new entries
  with no placeholder leakage.
- Run the binary check locally against the TURN-enabled rendered config and
  confirm no `Unknown config option` / `ERROR` lines from coturn.
