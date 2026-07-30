description: The owner's own device had vanished from the self-hosted manager's trust-circle list after an earlier fix; this restores it by writing down a "this is me" label at startup.
files:
  - packages/cadre-host/src/bin/host.ts (self-labelling step, ~line 347-370)
  - packages/cadre-host/src/auth/__tests__/trust-circle-integration.test.ts (seeds the self label directly, mirroring what host.ts now writes)
  - docs/cadre-host.md (Trust circle section — corrected to describe the current self-labelling behavior)
difficulty: easy
---

# Trust-circle listing drops the owner's own device row — fixed

## What was done

Implemented the fix per the ticket's design direction, unchanged in approach:

In `packages/cadre-host/src/bin/host.ts`, inside the `hostOwnsCadre(cfg)` branch
(founder role), right after constructing the `OwnerNodeClient`-backed
`TrustCircleService`:

- Named the `TrustCircleStore` instance (`trustCircleStore`) instead of
  constructing it inline, so it can be reused for the self-label write.
- Added a best-effort step: call `owner.getPeerId()`, and if there's no
  existing local label for that peer ID, write one via
  `trustCircleStore.addMember({ peerId, label: 'This device', addedAt, self: true })`.
- Wrapped in try/catch — a spawn/identity failure logs
  (`self trust-circle label failed: ...`) and does not crash startup, matching
  the existing best-effort pattern used for owner-node spawn and NAT start
  just above/below it in the same function.

This does not touch `TrustCircleService`/`CadreNodeLike` — the interface
widening the ticket explicitly ruled out was avoided. `list()`'s existing
splice-back-self-from-local-label logic (already landed by the parent ticket)
picks this label up unchanged.

Updated `trust-circle-integration.test.ts`: since that test constructs
`TrustCircleService` directly against a real `CadreNode` (no
`OwnerNodeClient`/`bin/host.ts` in the loop), the production self-labelling
never runs for it. Seeded the same label by hand in `beforeEach` right after
`host.registerSelf()`, mirroring what `bin/host.ts` would have written. Both
previously-failing assertions (member count including self; self row surviving
after the other member is removed) now pass unchanged — no assertion text was
loosened.

Corrected `docs/cadre-host.md`'s Trust circle section, which previously said
the owner node "self-registers... and appears in the listing as an unlabeled
member" — no longer true post the parent ticket's authorized-vs-addressable
split. It now describes the actual mechanism: `list()` reads the *authorized*
set (which excludes self by design), and cadre-host writes a local `self: true`
label ("This device") for the owner's own peer ID at startup so `list()` can
splice it back in, labelled.

## Testing

- `yarn tsc --noEmit -p .` in `packages/cadre-host` — clean, no errors.
- `yarn vitest run` in `packages/cadre-host` — 54 files, 450 passed, 3 skipped
  (pre-existing skips, unrelated). Both previously-failing integration tests
  (`issues → redeems → lists against the real control DB (listMembers path)`,
  `removes a member from CadrePeer`) now pass.

## Gaps / things a reviewer should look at

- The self-label write happens once at startup, inside the same try/catch as
  the rest of the founder-role setup. It is *not* re-attempted if
  `owner.getPeerId()` fails on that one call (e.g. owner node still starting
  up) — a fresh install where the owner node is slow to come up could start
  with the self row still missing from the listing until the next `cadre-host`
  restart. The ticket described this as acceptable ("best-effort ... on first
  successful list()" was offered as an alternative timing but not required);
  worth a second opinion on whether call-time retry (e.g. lazily in
  `TrustCircleService.list()`, via a callback the caller supplies) is worth
  the added complexity, or whether restart-heals-it is fine given `addMember`
  is idempotent and this is a cosmetic listing gap, not a security boundary.
- No new unit test was added directly against the `bin/host.ts` self-labelling
  snippet itself (it's inline in the CLI entrypoint's `start` action, which
  has no existing unit-test harness — the integration test only exercises
  `TrustCircleService` in isolation with the label pre-seeded by hand). If
  `bin/host.ts` grows more inline logic like this, it may be worth factoring
  the CLI's `start` action into a testable function.
