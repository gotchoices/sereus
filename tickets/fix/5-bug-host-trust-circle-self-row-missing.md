description: Following the fix that stops strangers from appearing in the self-hosted manager's trust-circle list, the owner's own device now silently disappears from that same list — nothing writes down "this row is me" anymore.
files:
  - packages/cadre-host/src/auth/trust-circle.ts (list() — already splices in any local label flagged `self`, see below; needs a *writer*, not a *reader* change)
  - packages/cadre-host/src/bin/host.ts (owner-node spawn site, ~line 326-354 — `owner` is an `OwnerNodeClient` and already has `getPeerId()`)
  - packages/cadre-host/src/owner/owner-node-client.ts (getPeerId() already implemented, hits `/admin/identity`)
  - packages/cadre-host/src/auth/trust-circle-store.ts (TrustCircleStore.addMember — where the write would land)
  - packages/cadre-host/src/auth/__tests__/trust-circle-integration.test.ts (2 tests currently failing — see below)
difficulty: easy
---

# Trust-circle listing drops the owner's own device row

## Context — what already landed

The parent ticket (`bug-host-trust-circle-lists-unauthorized-peers`) is fixed:
`TrustCircleService.list()` in `packages/cadre-host/src/auth/trust-circle.ts` now
calls `cadreNode.listAuthorizedMembers()` (the real, owner-vouched membership
set) instead of `cadreNode.listMembers()` (the addressable set — any device
that wrote its own row). `CadreNodeLike` gained `listAuthorizedMembers` /
`isAuthorizedMember`; `OwnerNodeClient` already implemented both (hits
`/admin/authorized-members`), so no client-side change was needed there.
`removeMember` still uses the addressable `isMember()` on purpose (removing a
row that exists is the point of that call) — untouched.

New unit tests in `packages/cadre-host/src/auth/__tests__/trust-circle.test.ts`
(`excludes addressable-only peers nobody authorized`, `keeps the self row even
though the authorized set excludes self`) pass. Full `yarn vitest run` in
`packages/cadre-host` and `yarn tsc --noEmit` are green **except** the two
tests below.

## The gap

`cadre-core`'s `listAuthorizedMembers()` deliberately filters out the node's
own peer ID (`packages/cadre-core/src/cadre-node.ts` ~line 3192: `row.peerId
!== selfPeerId`) — a node's self-published address row is not something it
"authorized," so it never appears in the authorized set. Before this fix,
that didn't matter: `list()` read the *addressable* set, which does include
self, so the owner's own device always showed up (unlabeled — falling back to
bare peerId — unless something had labelled it).

The current `list()` (post-fix) splices a self row back in from the **local**
label store: it looks for any `TrustCircleStore` member row with `self: true`
and, if the authorized set didn't already surface that peer, adds it. That
part is done and tested (`trust-circle.ts` around the `authorizedMembers`
merge block).

What's missing: **nothing in production code ever writes `self: true` into
`trust-circle.json`.** Grepped the whole repo — the `self` flag only appears
in test fixtures (`trust-circle.test.ts`, `trust-circle-store.test.ts`,
`cli-invite.smoke.test.ts`, `status-route.test.ts`) and in the type
(`TrustCircleMember.self` in `packages/cadre-host/src/auth/types.ts`). So
today, in a real running `cadre-host` with `ownCadre.enabled`, the owner's own
device now vanishes from `TrustCircleService.list()` entirely — no local
label exists to splice back in.

This regressed `trust-circle-integration.test.ts` (stands up a real
`CadreNode`, calls `host.registerSelf()`, then asserts the self peer shows up
in `service.list()`):
- `issues → redeems → lists against the real control DB (listMembers path)` —
  expects 2 members (self + redeemed phone), now gets 1.
- `removes a member from CadrePeer` — expects the self row to remain after
  removing the other member, now gets 0.

Both failures are a direct, understood consequence of this ticket's own
change, not pre-existing — don't route them through the
`.pre-existing-error.md` path.

## Expected behavior

The owner's own device keeps appearing in the trust-circle listing (flagged
`self`, as before), without reintroducing the addressable-surface bug the
parent ticket fixed (i.e. don't go back to trusting the addressable set for
this).

## Design direction

`OwnerNodeClient` already implements `getPeerId()` (declared under the NAT
`CadreNodeLike` in `owner-node-client.ts`, hits `GET /admin/identity`).
`bin/host.ts` already holds an `owner: OwnerNodeClient` instance at the
site where `TrustCircleService` is constructed (~line 345-350). The natural
fix is: after spawning the owner node (or lazily, on first successful
`list()`), fetch `owner.getPeerId()` and — if there's no existing local label
for that peer — write one with `self: true` via
`TrustCircleStore.addMember()`. Idempotent: `addMember` is a keyed upsert, so
calling this on every startup (or even every `list()`, best-effort) is safe
and self-healing if the label file is ever wiped.

Do **not** add `getPeerId()` to the trust-circle `CadreNodeLike` interface
itself (`auth/trust-circle.ts`) — `trust-circle-integration.test.ts`
constructs `TrustCircleService` with a real `CadreNode` (not
`OwnerNodeClient`) as the `cadreNode`, bypassing the admin-channel client
entirely for test purposes, and `CadreNode` has no async `getPeerId()` (only
a synchronous `.peerId` getter). Widening the interface would break that
test's typing. Keep the self-labelling as something the *caller* (`bin/host.ts`,
or a small helper it calls) does using the `OwnerNodeClient` it already has,
not something `TrustCircleService` pulls through `CadreNodeLike`.

`trust-circle-integration.test.ts` will need updating either way: it
constructs `TrustCircleService` directly against a real `CadreNode` with no
`OwnerNodeClient` in the loop, so the `bin/host.ts`-level self-labelling
won't run for it. Simplest fix there: after `host.registerSelf()`, add
`store.addMember({ peerId: host.peerId!.toString(), label: 'This device',
addedAt: new Date().toISOString(), self: true })` directly in the test's
`beforeEach`, mirroring what the production self-labelling would have
written, then the existing assertions (member count, self peer present after
removal of the other member) should pass unchanged.

## TODO

- Add a small self-labelling step in `packages/cadre-host/src/bin/host.ts` (or
  a helper `TrustCircleService`/`TrustCircleStore` method it calls), using
  `owner.getPeerId()` to learn the local peer ID and
  `TrustCircleStore.addMember(..., { self: true })` to record it — idempotent,
  best-effort (must not crash startup if the owner node isn't ready yet).
- Update `packages/cadre-host/src/auth/__tests__/trust-circle-integration.test.ts`
  to seed the self label the same way (see Design direction above), so both
  currently-failing tests pass again.
- Re-run `yarn vitest run` and `yarn tsc --noEmit -p .` in `packages/cadre-host`
  to confirm the full suite is green.
- Skim `docs/cadre-host.md`'s trust-circle section for any wording that
  implies self-labelling already happens automatically, and correct it if so.
