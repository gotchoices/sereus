description: When someone hand-configures how long strand formation may take, the same number is applied to both the joining side and the hosting side, so both give up at the same instant and the joiner sees a bare connection timeout instead of the clear reason the host was about to send.
files: packages/cadre-core/src/strand-formation-manager.ts, packages/cadre-core/src/strand-formation-protocol.ts, packages/cadre-core/src/strand-solicitation.ts
difficulty: easy
----

## What is wrong

Strand formation is a two-party exchange. The **host** (responder) does the real work —
database writes plus, for invitations that require sign-off, an outbound HTTP call to an
approval hook. The **joiner** (initiator) sits waiting for the host's answer.

The design deliberately staggers the deadlines so each layer can fail and *report* before
the layer above it gives up:

```
approval hook (10 s)  <  host does the work (12 s)  <  joiner waits for a reply (15 s)  <  whole session (30 s)
```

The 3-second gap between "host gives up" and "joiner gives up" is the travel time for the
host's rejection message to reach the joiner. Without it, the host writes `"Formation
provisioning timed out"` onto a stream the joiner has already abandoned, and the joiner
reports a generic read timeout instead — indistinguishable from the host being offline.

The defaults are correct. The problem is the override: `StrandFormationManagerConfig` has a
single `provisionTimeoutMs` field, and `StrandFormationManager` passes that one value to
**both** the host-side listener and the joiner-side dialer. Setting it to, say, 8000 gives
the host 8 s to answer and the joiner 8 s to wait — zero travel budget, and the two sides
race. Every deadline below and above stays at its default, so the ladder is broken only in
the middle.

The field's own doc comment names the ladder it cannot produce, which is how the mismatch
survived review.

## Why it has not bitten anyone

Nothing in the repository sets it. `provisionTimeoutMs` reaches the manager only through
`StrandSolicitationServiceOptions.formationConfig`, which no production caller and no test
populates — every real deployment runs on the defaults. It is a trap laid for the first
operator or test that tunes the budget, not a live bug.

## What "fixed" looks like

Configuring formation budgets should not be able to silently collapse the ladder. Either:

- the joiner's wait is derived from the host's budget with the travel margin added
  automatically (so one knob stays one knob and the ordering is structural), or
- the two become separate, separately-named settings, and a nonsensical pairing is rejected
  or clamped-with-a-warning the way `resolveProvisionTimeoutMs` already handles a budget
  that would outlive the session.

Either way the `provisionTimeoutMs` doc comment must stop describing an ordering the code
does not enforce, and a test should assert that a configured budget still leaves the joiner
waiting strictly longer than the host works.
