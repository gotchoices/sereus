description: The owner's own device had vanished from the self-hosted manager's trust-circle list; it now shows again, labelled "This device", and the label survives restarts and identity changes.
files:
  - packages/cadre-host/src/auth/self-label.ts (new — the self-labelling step, extracted from the CLI)
  - packages/cadre-host/src/auth/__tests__/self-label.test.ts (new — unit tests for it)
  - packages/cadre-host/src/bin/host.ts (calls ensureSelfLabel after NAT start)
  - packages/cadre-host/src/auth/trust-circle.ts (NOTE on removeMember re: removing your own device)
  - packages/cadre-host/src/auth/index.ts (exports)
  - packages/cadre-host/src/auth/__tests__/trust-circle-integration.test.ts (uses ensureSelfLabel instead of a hand-seeded row)
  - docs/cadre-host.md (Trust circle → "The owner's own device in the listing")
---

# Trust-circle listing drops the owner's own device row — done

## What the problem was

A prior fix made the trust-circle listing show only devices an owner key
vouched for. A node's own address record isn't vouched for by anyone, so the
owner's own machine silently disappeared from its own device list.

## What ships

The listing (`TrustCircleService.list()`) already splices in any local label
flagged `self: true`. What was missing was anything writing that label — so
cadre-host now writes it at startup:

- `packages/cadre-host/src/auth/self-label.ts` — `ensureSelfLabel({ store, getPeerId })`:
  reads the owner node's peer ID and records a `self: true` local label
  (`"This device"`). Idempotent — an existing label for that peer ID is left
  alone, so an admin rename survives restarts. A label that exists but lacks
  the flag gets stamped (without the flag `list()` would prune it). Stale
  `self` labels for a *different* peer ID are dropped, so replacing the node
  identity doesn't leave a phantom "This device" row that `list()` would show
  forever and never prune.
- `bin/host.ts` calls it once in the founder branch, after `natService.start()`,
  inside its own try/catch. Failure logs (`self trust-circle label failed: …`)
  and startup continues; the next start heals it.
- `docs/cadre-host.md` gained a short "The owner's own device in the listing"
  subsection replacing the stale claim that the owner node "self-registers …
  and appears in the listing as an unlabeled member".

## Review findings

The implement stage's own version of this landed the same behaviour inline in
`bin/host.ts`. Reviewed the diff first, then the handoff.

**Fixed in this pass (minor):**

- *Untestable placement.* The self-labelling was inline in the CLI's `start`
  action, which has no unit-test harness — the implementer flagged this as a
  gap. Extracted to `auth/self-label.ts` and covered by six unit tests (writes
  the label; preserves an admin rename; stamps an unflagged pre-existing row;
  drops a stale self row; no-op on an empty peer ID; propagates a `getPeerId`
  throw). The integration test now calls the same function instead of
  hand-seeding a duplicate copy of the row — one source of truth for the shape.
- *Stale self label was permanent.* `list()` adds every `self` row to its
  "seen" set, so the prune step can never remove one. If the node identity were
  ever replaced, the old peer ID would keep showing as "This device" forever.
  `ensureSelfLabel` now drops `self` rows whose peer ID isn't the current one.
- *Row without the flag lost its label.* A pre-existing label for the owner's
  peer ID with no `self` flag was skipped by the old `if (!getMember(...))`
  guard, and then pruned by `list()` (not authorized, not self) — losing the
  admin's name for the device. Now the flag is stamped onto it, keeping the
  label.
- *Startup race, narrowed.* The old call sat immediately after the owner-node
  spawn; on a slow first start `getPeerId()` could return before the node's
  admin surface answered, leaving the row missing until the next restart. The
  call moved after `natService.start()`, which already retries against the
  freshly spawned node until it accepts — so the peer ID is normally there on
  the first try. Still best-effort by design (cosmetic listing gap, not a
  membership change), so no retry loop was added.
- *Doc prose.* The Trust circle paragraph had become one six-line run-on
  sentence. Split into its own subsection.

**Filed as new tickets:** none. Nothing found needed work outside this ticket's
scope.

**Tripwires recorded (not tickets):**

- Removing your own device through the API is not blocked. The local UI hides
  the **Remove** button on the `self` row, but `DELETE /auth/members/<ownPeerId>`
  (and `cadre-host trust revoke <ownPeerId>`) will delete the node's own
  `CadrePeer` row. cadre-core re-registers self on node start, so a restart
  heals it, and the surface is loopback-only — nuisance, not a breach. Parked as
  a `NOTE:` on `TrustCircleService.removeMember` naming the two conditions that
  would make it real (self-registration stops being automatic, or the removal
  path gains a non-loopback caller).

**Checked, nothing found:**

- Startup ordering — the owner node is spawned (awaited) before the label write;
  donor-only mode never reaches it, correctly (no owner node, no listing).
- Store semantics — `addMember` upserts, `self` round-trips through
  `trust-circle.json`, and the atomic write-then-rename path is unchanged.
- `list()` splice/prune logic — untouched by this ticket and already covered by
  the parent ticket's tests; re-read to confirm the label written here is the
  shape it expects.
- The UI and CLI listing renderers both already handle `self` (`[self]` marker,
  hidden Remove button); no change needed.
- Error handling — `getPeerId()` returns `''` when the node isn't ready and
  throws `OwnerNodeUnavailableError` on transport failure; both paths covered.
- No resource-cleanup surface (no timers, handles, or subscriptions added).

## Verification

- `yarn lint` (repo root) — clean.
- `yarn tsc --noEmit -p .` in `packages/cadre-host` — clean.
- `yarn vitest run` in `packages/cadre-host` — 55 files, 456 passed, 3 skipped
  (pre-existing skips, unrelated). Up 6 tests from the implement stage's 450;
  no assertions were loosened or skipped.
