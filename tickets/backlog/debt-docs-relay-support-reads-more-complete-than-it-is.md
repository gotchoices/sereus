---
description: The docs say relay is supported, which is true for a machine acting as a relay and false for a phone trying to be reachable through one. Someone planning a phone-hosted setup can read the docs and get a design that cannot work.
files: docs/strands.md, docs/cadre-host.md, docs/architecture.md, docs/reference-app-rn.md
---

# "Relay is supported" is true for servers and false for phones

Relay support is split across two halves that live in different documents, and the split
is never stated:

| half | status |
| --- | --- |
| relay **server** (forwarding for others) | implemented, default-on for the storage profile ([`docs/strands.md`](../../docs/strands.md)) |
| relay **client reservation** (making a NAT'd node reachable) — cadre-cli | implemented (`CADRE_RELAY_ADDRS` / `network.relayAddrs`) |
| relay **client reservation** — cadre-host | deferred ([`docs/cadre-host.md`](../../docs/cadre-host.md), "Circuit-relay client (deferred)") |
| relay **client reservation** — the web reference app | implemented (`VITE_RELAY_ADDR` / `localStorage "relay-addr"`, via `CadreNode.reserveRelays`) |
| relay **client reservation** — the React Native reference app | implemented (`EXPO_PUBLIC_RELAY_ADDR` / Settings → Relay, via `network.relayAddrs`) |
| relay **client reservation** — the NativeScript reference app (`packages/reference-app-ns`) | never used; that app also has no invitation flow at all, so it is dial-out only |

A reader who takes "relay is supported" at face value plans an architecture where a phone
is dialed through a relay. The sentence that would have told them where that does and does
not work is in a different document about a different package.

> **Updated 2026-09-15** by `phone-becomes-reachable-through-a-relay`: the single "the phone
> apps — never used" row above became false and has been corrected in place, split into one
> row per reference app (three, once the review pass added the NativeScript one the split had
> dropped). The web and React Native apps now reserve as relay clients, and `docs/reference-app-rn.md`
> gained a "Reachability: configuring a relay" section. What this ticket still owns is
> unchanged: no single document states the matrix, `cadre-host` is still the deferred half,
> and `architecture.md` still does not say where inbound-to-phone works. The two
> `cadre-host.md` fixes below are also untouched.

`cadre-host.md` is honest in its own section; the problem is that no document states the
matrix, and the two documents a phone developer reads (`architecture.md`,
`reference-app-rn.md`) are not among them.

## The work

State the split once, where a reader deciding an architecture will meet it, and cross-link
from the per-package documents. Say explicitly where inbound-to-phone **does** work (both
reference apps, given a configured relay) and where it does not (`cadre-host`), so nobody
plans on the wrong half.

Two small fixes to make while in there:

- `cadre-host.md:273` links the deferred client work as
  `backlog/4-relay-bootstrap-infrastructure` pointing at `../tickets/backlog/`; the file is
  actually in [`tickets/backlog/later/`](../backlog/later/4-relay-bootstrap-infrastructure.md).
- `cadre-host.md:322` says circuit addresses appear "once the relay-client work lands" —
  worth confirming that is still the only gate now that cadre-cli's client half is in.

## Provenance

Raised in an outside documentation review of the published `v0.11.0` tree (2026-08-19),
item 8. Verified against HEAD 2026-08-22.
