---
description: Two connection tests fail because they hand a second machine the details it needs to join, but never actually add it to the group's member list first — so the first machine correctly refuses its call. Fix the tests to add the member first, the way real onboarding does.
files: packages/integration-tests/src/scenarios/control-write-while-alone-convergence.integration.ts, packages/integration-tests/src/scenarios/control-cohort-auto-convergence.integration.ts, packages/integration-tests/src/scenarios/control-db-two-node-convergence.integration.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/membership-connection-gater.ts, packages/cadre-core/src/seed-bootstrap.ts
difficulty: easy
---

# Reader node must be vouched before it dials the owner

## What was wrong

Both failing scenarios boot an owner node **A** and a reader node **B**, then expect B to
connect to A and read replicated rows. Neither scenario ever makes B a member of the party.

A's inbound connection gate (`admitInboundControlConnection`,
`packages/cadre-core/src/cadre-node.ts:841`) admits an unknown peer only while A has **no**
authorized members at all — the cold-start carve-out at line 849. The moment A vouches its
first member, that carve-out closes and every un-vouched dialer is refused. Both scenarios
call `A.authorizePeer(X)` for a third peer X, which closes the carve-out, and B is then
denied.

Confirmed by running `control-cohort-auto-convergence` with `DEBUG='sereus:cadre*'`:

```
refreshAuthorizedControlPeers(applySeed): 0 authorized peer(s)
refreshAuthorizedControlPeers(authorizePeer): 1 authorized peer(s)
admitInboundControlConnection: DENYING inbound from 12D3KooWS5whX8Sq… — not an authorized
  member and no enrollment path open
```

B's seed dial lands microseconds after `authorizePeer(X)` flipped the set to non-empty, so B
never gets a connection at all.

This also explains why only **one** of the two assertions in
`control-write-while-alone-convergence` fails. Its `DeviceToken` sibling passes because that
test never calls `authorizePeer`, so A's authorized set stays empty and the cold-start
carve-out keeps admitting B — passing by accident, not by design.

The gate is behaving correctly. The scenarios are modelling an onboarding flow that does not
exist in production.

## What production actually does

Every onboarding helper in `packages/cadre-core/src/seed-bootstrap.ts` vouches the new node
**before** minting it a seed:

- `addDrone` (line 1022) — `authorizePeer(drone)` then `createSeed()`
- `acceptPhone` (line 1118) — validate token then `authorizePeer(phone)`
- `addPhoneWithRelay` (line 1149) — `authorizePeer(phone)` then `createSeed()`

`docs/architecture.md` documents the same ordering in its enrollment sequence diagrams
(lines 218, 246, 266). The bare `createSeed()` / `applySeed()` pair the two scenarios use
skips the vouch step, which is not a production path.

The third scenario in this family, `control-db-two-node-convergence.integration.ts`, already
got this treatment: its `bootPair` calls `await A.authorizePeer(B.peerId!.toString())` with a
comment explaining the gate (line 149). That scenario passes. The two failing ones were never
brought in line.

## The fix

Apply the same vouch to both scenarios, before B dials.

**`control-write-while-alone-convergence.integration.ts`** — in `bootPair`, after `B.start()`:

```ts
// A vouches B so A's inbound connection gate admits B's dial once A's authorized
// set is non-empty (mirrors `bootPair` in control-db-two-node-convergence).
await A.authorizePeer(B.peerId!.toString());
```

**`control-cohort-auto-convergence.integration.ts`** — immediately before `A.createSeed()`:

```ts
// Production onboarding vouches the new node BEFORE handing it a seed
// (addDrone / acceptPhone / addPhoneWithRelay in seed-bootstrap.ts, and the
// enrollment sequences in docs/architecture.md). Without it A's inbound gate
// refuses B's cold-start seed dial.
await A.authorizePeer(B.peerId!.toString());
```

Verified during the fix stage: with those two additions all three tests in the two files pass,
and fast — cohort-auto in **1.8 s** (was a 45 s timeout), write-while-alone in **0.7 s** (was a
15 s timeout), DeviceToken still green at 0.7 s.

Vouching B does **not** compromise what either scenario proves:

- `control-cohort-auto-convergence` still performs **zero manual control dials** — vouching is
  a control-DB write, not a dial. Its whole claim (B reaches convergence through the production
  cold-start path only) is intact and is in fact now *more* faithful to production.
- `control-write-while-alone` still has A genuinely alone at write time. B's `CadrePeer` row is
  written with no multiaddrs (`authorizePeer(peerId)` with no address argument) and B's
  self-published addresses can never reach A without a connection, so A's own reconcile pass has
  no address for B and cannot dial it. The `getConnections().length === 0` assertion holds
  deterministically, not by luck.

## Update the scenario doc comments

Both files open with a long header comment that currently mis-describes the setup. Correct
them as part of the change:

- `control-cohort-auto-convergence.integration.ts` — its "Honesty note (for reviewers)" block
  explains that the first connection necessarily comes from the cold-start path. Extend it to
  say that the owner also vouches B first, because that is what production onboarding does, and
  that this is a control-DB write rather than a dial so the "no manual dial" claim is unaffected.
- `control-write-while-alone-convergence.integration.ts` — its `bootPair` doc says the pair boots
  "DISCONNECTED"; keep that but note the vouch and why the gate needs it.

## Out of scope

The production cold-start gap this investigation surfaced — a node whose one and only seed dial
fails has no way to retry — is tracked separately as `cold-start-control-redial`. Do not
attempt it here; this ticket is the two-line scenario correction plus comments.

`bug-strand-three-party-replication` is a different subsystem and stays untouched.

## TODO

- [ ] Add `await A.authorizePeer(B.peerId!.toString())` to `bootPair` in
      `control-write-while-alone-convergence.integration.ts`.
- [ ] Add the same vouch before `A.createSeed()` in
      `control-cohort-auto-convergence.integration.ts`.
- [ ] Update both scenario header comments as described above.
- [ ] Run both files: `npx vitest run src/scenarios/control-write-while-alone-convergence.integration.ts src/scenarios/control-cohort-auto-convergence.integration.ts --reporter=verbose` from `packages/integration-tests` — expect 3 passed.
- [ ] Run the full integration suite and confirm it is no worse than the current baseline
      (24 of 27 files pass; `bug-strand-three-party-replication` is the expected remaining failure,
      and these two files should move into the passing column).
