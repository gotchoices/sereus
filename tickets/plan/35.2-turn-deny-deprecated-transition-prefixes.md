----
description: The TURN relay's address deny-list closes the modern IPv6-to-private-IPv4 bypasses but not the older, mostly-deprecated transition mechanisms (6to4, Teredo) that can also encode a private IPv4 target.
files: ops/docker/coturn/turnserver.conf
prereq: turn-ssrf-peer-deny-hardening
difficulty: easy
----

## Context

`turn-ssrf-peer-deny-hardening` added `denied-peer-ip` entries for IPv4-mapped
(`::ffff:0:0/96`) and NAT64 (`64:ff9b::/96`, `64:ff9b:1::/48`) so a TURN relay
peer cannot reach private IPv4 services through an IPv6 encoding. The conf
comment claims coverage of "every non-public IPv6 range."

That claim is not literally exhaustive: two **deprecated** IPv6 transition
prefixes also embed/encode an IPv4 address and are not in the deny set:

- **6to4 — `2002::/16` (RFC 3056).** `2002:<v4>::` encodes a public IPv4 in
  bits 16-48; an operator could in principle target `2002:0a00:0001::`
  (10.0.0.1). 6to4 anycast was deprecated by RFC 7526, and the 6to4 relay
  destination `192.88.99.0/24` is already in the IPv4 deny block, so the
  realistic exposure is low.
- **Teredo — `2001:0000::/32` (RFC 4380).** Encodes a Teredo server + client
  public IPv4 (obfuscated). Requires a Teredo tunnel in path.

Both require a specific transition gateway/relay to be present and routable from
the coturn host, which modern deployments rarely have — hence this is a
**defense-in-depth / accuracy** follow-up, not an active vulnerability like the
NAT64 case that motivated the parent ticket.

## What to decide / do

- Decide whether to add `denied-peer-ip` ranges for `2002::/16` and
  `2001:0000::/32` (start–end notation, consistent with the existing entries),
  or to instead **soften the conf comment** to say "every non-public range that
  is reachable in practice" and explicitly enumerate what is and isn't covered.
- If adding the ranges, validate them against a real coturn binary (the README
  "Config parse check") — coturn must accept the start–end forms.
- Consider whether the deny-list approach should eventually be replaced by an
  allow-list posture (only permit the relay's intended egress), which would make
  the transition-prefix enumeration moot. Note the tradeoff if so.

Expected ranges, if added:

```
denied-peer-ip=2002::-2002:ffff:ffff:ffff:ffff:ffff:ffff:ffff   # 6to4 (2002::/16)
denied-peer-ip=2001::-2001:0:ffff:ffff:ffff:ffff:ffff:ffff       # Teredo (2001:0000::/32)
```
