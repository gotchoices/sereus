---
description: Browser peers in the Tier 2 e2e see a ~15 % `protocol-client dial:fail` rate (215 fails out of 1438 dial attempts in a single ~30 s test run). This is the root-cause layer below `cluster-tx:consensus-broadcast-error`: the in-line broadcast retry added in `web-e2e-tier2-consensus-broadcast-race` opens a fresh stream against the same libp2p connection and still fails, suggesting the underlying circuit-relay reservation has expired or the relay torn down the slot. Need to investigate reservation lifetime / renewal in the browser libp2p config and confirm reservations survive across the lifetime of a Tier 2 e2e run (~60 s wall-clock per spec).
files: ../optimystic/packages/db-p2p/src/libp2p-node-base.ts, packages/reference-app-web/src/lib/optimystic.ts
---

## Problem

The Tier 2 e2e debug trace shows persistent dial failures from browser peers to service peers, despite both having advertised circuit-relay-v2 addresses and despite a relay reservation succeeding at startup. The `cluster-tx:consensus-broadcast-retry` event proves the in-line retry attempts the dial again moments later and **still fails** — and it fails fast enough that the failure isn't a TCP handshake timeout, suggesting the relay has revoked or expired the reservation between successful dials.

## What to research

- Default reservation TTL in the circuit-relay-v2 server (`@libp2p/circuit-relay-v2`); how it surfaces to the client; whether the client auto-renews.
- Whether the reference-peer service nodes (with `--relay` enabled by default per `reference-peer-cluster-size-cli` fallout) respect a configurable reservation duration / limit count.
- Whether browser peers re-request reservations periodically. Likely answer: they don't, and the reservation silently expires after the libp2p default (~15 min in spec, often shorter in practice).
- Whether the failure mode is reservation expiry, reservation limit-reached, hop disabled by relay, or something else entirely. The `dial:fail` event includes a reason field — find it in `protocol-client` and surface it in the debug log.

## Expected behavior

A browser peer that holds a relay reservation for the duration of a Tier 2 e2e run should be reliably dialable through that relay for the full run. The reservation should auto-renew before expiry, or the dial path should re-acquire a reservation on failure before giving up.

## Specifications (sketch — refine during the fix-stage research)

- Surface `dial:fail` reason in the `protocol-client` debug log so a future regression is diagnosable from the e2e trace alone.
- Either bump the relay-server reservation TTL on the reference-peer service nodes, or implement client-side renewal in the libp2p-node-base browser config, whichever is closer to upstream-spec behavior.
- Add an integration test that holds a browser peer ↔ service peer connection open for 90 s and asserts the dial path remains reliable through that window.

## Acceptance

- `dial:fail` rate in `C:\Temp\tier2-run<N>.log` drops below 1 % across a 60 s Tier 2 spec run.
- A `dial:fail` event includes a `reason` field with the upstream libp2p error.

## Context

Spawned during review of `web-e2e-tier2-consensus-broadcast-race`. Trace evidence cited in that ticket's complete file (1223 `dial:ok` vs 215 `dial:fail` in run 1).
