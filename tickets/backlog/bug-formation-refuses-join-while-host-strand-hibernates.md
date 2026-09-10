----
description: When the host of a private workspace has hibernation turned on and the workspace has gone to sleep, anyone redeeming a valid join invitation is told "unavailable, retry" — and nothing the joiner does can wake it, so the retry only succeeds if the host happens to wake for some other reason.
files: packages/cadre-core/src/cadre-node.ts (issueStrandMembershipInvite, wakeStrand), packages/cadre-core/src/strand-formation-manager.ts (provisionAsResponder), packages/cadre-core/src/hibernation-manager.ts, packages/cadre-core/src/strand-wake-service.ts
repro: static
severity: moderate
likelihood: unusual
----

# A closed-strand join is refused while the host's strand is hibernating, and the joiner cannot wake it

## Background

Since `strand-formation-membership-invite`, a bound closed-strand redemption (someone joining a private workspace through the formation handshake) makes the host issue a single-use membership invitation against its **live** strand database: `CadreNode.issueStrandMembershipInvite`. When the host's strand instance has no live runtime, that method throws, and the formation manager answers the joiner with `MEMBERSHIP_INVITE_UNAVAILABLE_REASON` ('Strand membership invitation unavailable, retry'), leaving the join token unspent.

The formation handshake runs on the host's always-on control network node, so it is reachable while the strand itself is hibernating.

## The defect

With hibernation enabled, an idle strand goes to sleep (for the default `interactive` latency hint: idle after 5 minutes, hibernating 15 minutes after that). A joiner redeeming an invitation after that point is refused with "retry", but:

- the formation path never wakes the strand;
- the push-wake receiver (`StrandWakeService`) only accepts wakes from the host's own cadre members (`isAuthorizedMember`), so the joiner — a different party — cannot wake it either;
- the only other wake is the host's own check-in schedule, which backs off from 30 seconds toward an hour, during which the runtime is live only for a short window.

So a joiner's retry succeeds only if it happens to land inside a host check-in window. From the joiner's side the invitation looks broken.

## Reach

Hibernation is off unless an embedder enables it: `CadreNode` defaults `config.hibernation ?? { enabled: false }`, and both reference apps pass `hibernation: { enabled: false }` explicitly. So the reference apps and default embedders are unaffected. It bites any embedder or `cadre-cli` configuration that turns hibernation on and hosts closed strands.

## Expected behavior

A redemption that has already passed token and disclosure validation is a real signal that the host should be serving the strand — the joiner is about to sync from it. The host should wake the strand (the coalesced `CadreNode.wakeStrand` path, the same one push-wake and service-wake use), bounded by a timeout, and then issue the invitation, rather than refusing. Only if the wake fails or times out should it fall back to the retryable rejection.

Constraints worth preserving:

- Wake only after the token and disclosure checks pass, so an unauthenticated caller cannot force a strand awake.
- Keep the "issuance failure leaves the join token unspent" property.
- The wake should count as activity so the strand does not re-hibernate before the joiner's first sync arrives.

`issueStrandMembershipInvite` already notes it cannot tell "hibernating" from "never launched"; this fix needs that distinction (a hibernating instance is known to `strandManager.getInstance` but has no database), and "never launched" should keep rejecting.

## Confirming it

Not observed — read from the code. A cadre-core spec: host node with hibernation enabled and short custom timeouts, publish a closed strand, let it hibernate, redeem a bound formation invitation from a second node. Today: rejected with the retry reason. After the fix: approved with a membership invitation and the strand active.
