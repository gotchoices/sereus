description: Two parties can form a private strand together and each sees the other as a member, but nothing written into it ever reaches the other side — and the joiner cannot even read back its own message. The joiner's reads fail with "Block default/Message is unavailable (cohort-unreachable)".
files:
  - packages/cadre-core/src/strand-instance-manager.ts (strand runtime, cohort/bootstrap for a formed strand)
  - packages/cadre-core/src/cadre-node.ts (`formStrand` ~6886, `recordCrossPartyStrandAddrs`)
  - packages/quereus-plugin-sereus (strand block storage / cohort resolution)
  - packages/integration-tests/src/scenarios/strand-formation-e2e.integration.ts (closest existing coverage)
repro: verified
----

# A strand shared across parties carries membership but no data

## What was run (device + PC, 2026-09-16)

- Phone (party `3333aaaa-…0030`), reachable through a loopback circuit relay
  (`Reachable: Yes — via relay`), created a **closed** strand and minted an invitation.
- A second cadre on the PC (its own party id, its own always-on node, `storage` profile) redeemed it:
  `formStrand` succeeded in **2290 ms** through the relay circuit, returned a membership key, and the
  strand attached locally (`status: active`, 50 ms).
- The phone's status bar then read `Connected · 2 strand(s) · 2 member(s)` — so the joiner's `Member`
  row reached the phone.

## The failure

Neither side's `Message` rows reach the other, in either direction:

- Party B inserted a `Member` row and one message, both reported success. Its very next read —
  four seconds later, its own local database — returned **0 messages**. Its own write was not
  readable by itself.
- Party B's reads then failed repeatedly with:
  `Error during query on table 'Message': Query failed: Block default/Message is unavailable (cohort-unreachable): the repo could not determine whether it exists`
  before going quiet again at 0 messages.
- The phone sent two messages into the same strand. Both appear on the phone (with correct
  timestamps) and **never appear on party B**.
- The relay showed live circuits throughout (`reservations=3 connections=5`), and membership had
  already crossed the same path, so this is not "the two nodes never met".

## Why it matters

This is the whole point of a strand: the invitation, consent handshake and membership all work, and
then the shared data does not move. A user would see a chat where the other person is present and
silent.

## Where to look

- `Block default/Message is unavailable (cohort-unreachable)` is the joiner failing to resolve the
  cohort for that block. Does a strand created by `formStrand` give the joiner a cohort/bootstrap set
  that includes the founder, or does it come up with an empty cohort that can answer nothing?
- Party B not reading back **its own** insert points at the same thing: if the table's block cohort
  cannot be resolved, a local write may be accepted into a transaction that never commits anywhere
  readable.
- Compare with the open-strand path on one party, which converges (a drone joining an open strand
  shares messages) — the difference is `formStrand`'s cross-party provisioning.
- Related known behaviour from the same night's suite runs: a live read on a node that cannot reach
  its cohort fails outright rather than serving what it holds
  (`optimystic backlog/more-design/a-live-read-on-an-isolated-node-fails-instead-of-serving-what-it-holds`).
  That explains the shape of the error, not why the cohort is unreachable while a circuit is up.

## Reproducing without a phone

The phone is not essential — what it provides is a relay-only, no-listener party. A headless version
would be: party A behind a dedicated relay (`packages/integration-tests/src/harness/dedicated-relay.ts`),
party B direct, A founds a closed strand and mints an invitation, B redeems it with `formStrand`, then
each writes a `Message` and both read. The scripts used on the device are attached to this ticket's
scratch notes if wanted; they are a straight port of `strand-formation-e2e` plus a real relay.
