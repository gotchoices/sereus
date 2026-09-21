description: Two parties cannot form a strand over a relay once each outbound WebSocket frame is held 10 ms — the joiner's FRET announce to the host times out, the cohort stays at one member, and `addStrand` fails with `StrandAwaitingFirstSyncError`. Reported as issue #13 with a reproduction that runs in this repo. A real WAN hop costs far more than 10 ms, so if the threshold is anywhere near this, phone-to-phone over a relay cannot work outside a LAN.
files:
  - packages/integration-tests/src/scenarios/blind-relay-phone-to-phone-e2e.integration.ts (the scenario to run under injected latency)
  - packages/integration-tests/src/harness/ws-latency.ts (to be added — the injector from the issue)
  - ../Fret/packages/fret/src/service/fret-service.ts (`MAINTENANCE_RPC_TIMEOUT_MS` = 2000, `sendAnnouncementsRateLimited` ~line 1608 — the prime suspect; separate repo)
  - packages/cadre-core/src/strand-instance-manager.ts (~line 651, the only place sereus chooses a FRET profile)
repro: reported by the filer as deterministic at the boundary (10 ms fails twice, 5 ms passes); NOT yet reproduced here
----

# Strand formation fails at 10 ms of per-frame outbound latency

Filed as **gotchoices/sereus#13** by `kjeib`, 2026-09-20, against the blind-relay phone-to-phone
topology. Read the issue first — it is specific, it rules out several explanations, and it carries
a reproduction that needs no device.

## What the filer measured

Two parties in one process, `listenAddrs: []` plus `relayAddrs`, closed strand, bound invitation,
a real relay from `ops/docker/libp2p-infra`. Every outbound WebSocket frame held by a fixed delay:

| per-frame delay | outcome |
|---|---|
| 0 ms | passes, host's row readable on the joiner in 2.8 s |
| 5 ms | passes |
| 10 ms | `StrandAwaitingFirstSyncError`, 2 of 2 runs |
| 20 / 40 / 50 ms | `StrandAwaitingFirstSyncError` |
| 150 ms | the joiner never gets a relay reservation within 60 s |

Formation itself succeeds: the seed carries four relayed strand addresses and the membership key,
and the joiner merges the address book. What fails is the next step:

```
fret:error announce to 12D3KooW… : timeout       (also seen: unreachable)
findCluster:done key=… peers=1 addressless=0 selfRelayOnly=0
cohort:membership … serves=1 … cohort=1
```

`addressless=0` and `selfRelayOnly=0` say the joiner holds usable addresses for everything it knows
about, so this is not discovery and not a relay-only dead end. The announce to the host's strand
node times out, the host never enters the joiner's ring, the cohort stays at one, and first sync has
nobody to read from.

The same diagnostics appear on a Galaxy S7 joining a Node host over Wi-Fi through the same relay,
where dials that do connect take 1.6 s to 39 s. Two failures previously treated as separate —
`Formation dial-connect timed out after 5000ms`, and the node losing its relay reservation — also
reproduce as the delay rises.

## First hypothesis: FRET's maintenance budget is a LAN budget, and a dial sits inside it

`../Fret/packages/fret/src/service/fret-service.ts`:

- `MAINTENANCE_RPC_TIMEOUT_MS = 2000` is the whole-RPC budget for ping and announce. Its comment
  justifies 2 s on the grounds that "a ping is a ~50-byte round trip and an announce is a
  fire-and-forget push with no reply of substance" — true of the payload, and true of the time only
  when the link is fast and the connection already exists.
- `sendAnnouncementsRateLimited` (~line 1608) passes `dial: true` with that same budget. Every
  announce target is *chosen* to prefer non-connected peers, so the common case is that a dial —
  over a relay: reservation, connect, Noise handshake, muxer, identify — must complete inside 2 s.
  At 10 ms per outbound frame that is tens of frames deep before the announce payload moves.

If that is right, the cascade is worse than one lost announce. The same 2 s budget bounds the
stabilization ping (`MAINTENANCE_RPC_TIMEOUT_MS` again). Repeated `timeout` outcomes record contact
strikes, a peer with enough strikes becomes `dead`, and `isDoomedDial` then refuses to dial it at
all — so a peer that is merely far away gets permanently classified as unreachable, and no later
tick recovers it. That would explain why the failure is stable rather than intermittent, and why
raising the delay takes out the relay reservation too.

This is a hypothesis from reading, not a measurement. It has not been confirmed, and a competing
explanation — that the budget is fine and something in the relayed dial path is quadratic in frame
count — is not ruled out.

## Constraint: the suspect code is in another repo

FRET lives in `../Fret`, which this repo must not build or modify. If the cause is in FRET, the
output is a report to its maintainers with the measurement attached, plus whatever mitigation is
available on the sereus side (a profile choice, a pre-connection before announce, or a retry that
survives the first timeout). Check what FRET exposes before assuming anything is tunable from here:
the constants above are `private static readonly`, and `strand-instance-manager.ts` line 651 —
`fretProfile: config.profile === 'storage' ? 'core' : 'edge'` — is the only FRET knob sereus sets.

## TODO

- Add `packages/integration-tests/src/harness/ws-latency.ts` from the issue (tabs, no `any`, and
  keep `bufferedAmount` truthful so libp2p's backpressure still works — the filer's version is
  careful about this and the reason is worth preserving in a comment). Gate it on
  `WS_SEND_DELAY_MS` so it is a no-op at 0.
- Reproduce: run `blind-relay-phone-to-phone-e2e` at 0, 5 and 10 ms and confirm the boundary. If it
  does not reproduce, say so on the ticket with what differs from the filer's harness (they used a
  near-transcription of the scenario, not the scenario itself) before going further.
- Instrument the failing run with FRET's logs (`DEBUG=fret:*`) and answer: how long does the announce
  dial actually take, does it exceed 2 s, and does the host peer end up `dead` in the joiner's store?
- Decide where the fix belongs. If it is FRET's, produce the report (a `blocked/` ticket — posting to
  another project's tracker is a human's call, as with `report-libp2p-websockets-buffered-amount`)
  and a separate ticket for any sereus-side mitigation.
- Consider whether a latency-injected variant of this scenario belongs in the permanent suite. It
  would guard the class, not just this bug. Weigh it against the runtime it adds.
- The filer offers a PR bumping `ops/docker/libp2p-infra` from libp2p 2.x to 3.x to match clients
  (they report no behavioural change, and it clears a spurious `TimeoutNaNWarning`). That is a
  separate question from this bug; note it for the maintainer rather than folding it in.
