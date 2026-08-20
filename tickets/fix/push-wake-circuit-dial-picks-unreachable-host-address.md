----
description: A test that sends a wake-up message to a phone reachable only through a relay passes on its own but times out when the whole test suite runs together, because the sender tries to reach the phone at a local network address of the developer's machine that nothing can actually answer on.
files: packages/integration-tests/src/scenarios/push-wake-e2e.integration.ts, packages/cadre-core/src/control-stream.ts, packages/cadre-core/src/peer-addr-book.ts, packages/cadre-core/src/relay-addrs.ts
difficulty: medium
repro: verified
----

# `push-wake-e2e` circuit-relay case: wake dial goes to a host virtual-adapter address under whole-suite load

## The observation

```
FAIL src/scenarios/push-wake-e2e.integration.ts
  > delivers a wake to a NAT'd receiver over a circuit-relay (signaling-first) dial
Error: Wake dial /ip4/10.255.0.1/tcp/4001/ws timed out after 10000ms
  ❯ Timeout.<anonymous> ../cadre-core/src/control-stream.ts:67:14
```

Measured 2026-08-20 in a full root `yarn test` run (integration suite: 8 failed / 242 passed /
1 expected fail of 251). Log: `tickets/.logs/garden-compat-full-test.log`.

**It does not reproduce in isolation.** Three consecutive `-t "circuit-relay"` runs immediately
afterwards: green, 2.6-2.9 s each. The review pass that had just hardened this scenario measured
it green four consecutive times. So the trigger is whole-suite conditions, not the scenario.

## Why this is filed as new rather than pre-existing

This is deliberately *not* being folded into the documented intermittent set in
`tickets/.pre-existing-known.md`, for two reasons:

- **The fingerprint is new.** The tracked entries for this test (lines 111-112, 344) are a schema
  revision error or a 30 s `waitForCadrePeerConverged` timeout, folded under
  `control-db-cross-node-convergence-halted`. A 10 s wake-dial timeout against a specific
  interface address is a different failure.
- **It was green in a full-suite run earlier the same day**, at
  `tickets/.logs/garden-integration-2026-08-20-final.log` (6 failed of 251, this test not among
  them). Between that run and this one, the only changes were the compatibility sweep
  (`retire-metric-alias-cadre-peers-connected`, `retire-form-strand-string-overload`,
  `retire-host-config-v1-upgrade`, `retire-rn-legacy-identity-migration`,
  `correct-legacy-wording-on-current-paths`, `publish-deprecated-strand-proto-decision`).

**Be honest about the evidence here.** One green and one red full-suite observation is not enough
to call this either a regression from that sweep or a pre-existing intermittent. Establishing
which is the first job of this ticket, not an assumption to inherit. `git stash`-free ways to
check: run the suite at `d3c7c2a` (before the sweep) and at HEAD, several times each, and compare
rates. If it reds at both, it is an intermittent that predates the sweep and this ticket becomes
"make the dial candidate selection robust". If it only reds after, find which change did it.

## The specific thing to explain

`10.255.0.1` is not a peer address in the test topology — it is a virtual-adapter address on the
development host (the Hyper-V / WSL `vEthernet` range). The receiver in this scenario is supposed
to be reachable **only** over a circuit address; the scenario was hardened during
`push-wake-scenario-still-configures-a-relay-listener` to assert exactly that — that every live
address on the receiver is a circuit address.

So there are two candidate explanations and they call for different fixes:

1. **The receiver really does acquire a direct address under load**, and the assertion that should
   have caught it either runs at the wrong moment or checks the wrong node. That would make the
   assertion weaker than it reads, which matters beyond this test.
2. **The sender's dial-candidate selection reaches for an address the receiver never advertised** —
   a stale peer-store entry, or a candidate list assembled from local interfaces rather than from
   what the peer announced. `packages/cadre-core/src/peer-addr-book.ts` is the place to start.

Determine which before changing anything. A fix that only raises the 10 s timeout would hide
either one.

## Why it matters beyond the test

If explanation 2 holds, the same selection runs in production: a node behind NAT would have wake
dials spent on unreachable host-local addresses, with a 10 s stall each. That is a real-user
symptom, not a test artefact — which is the reason this is in `fix/` rather than `backlog/`.

Note also that a bare `/ip4/10.255.0.1/...` candidate is **host-specific**. A machine without a
Hyper-V/WSL adapter may never produce it, so this can look green on other developers' machines and
in CI while still being wrong. Do not treat a green run elsewhere as evidence the cause is gone.

## Do not chase these

The other seven failures in the same run are documented and owned — see
`tickets/.pre-existing-known.md`: `strand-formation-concurrent-redemption` (3, →
`secondary-index-seek-blind-to-sibling-rows`), `control-delete-while-alone-convergence` (1) and
`push-wake-e2e`'s control-DB-replication case (1) (→ `control-db-cross-node-convergence-halted`
class), `control-cohort-edge-carries-data` (1, → `control-peer-row-refresh-invisible-to-third-node`),
and `control-cohort-three-node-isolation` (1, intermittent boot race).
