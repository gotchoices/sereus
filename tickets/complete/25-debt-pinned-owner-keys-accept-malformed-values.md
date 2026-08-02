description: A typo in an operator-supplied trusted-owner key used to be accepted at startup and only surface much later as "this node won't join", with no message pointing at the typo. That gap is now closed, and every rejection names the offending key.
files: packages/cadre-cli/src/commands/start.ts, packages/cadre-cli/test/start-pins.spec.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/test/cadre-node-trusted-owners.spec.ts, packages/cadre-core/src/ed25519-key.ts, packages/cadre-core/test/ed25519-key.spec.ts, packages/cadre-provider/src/server/routes.ts, packages/cadre-provider/README.md, packages/cadre-cli/README.md, docs/architecture.md, docs/STATUS.md
----

# Pinned owner keys reject malformed values at the point of entry

## What shipped

All three places a pinned owner key can enter the system run the same
base64url/32-byte shape check the replicated control keys already had
(`requireEd25519PublicKeyB64`, `packages/cadre-core/src/ed25519-key.ts`):

1. **`--pin-owner-key` flag / `CADRE_OWNER_KEYS` env** — `validatePinnedOwnerKeys`
   (`packages/cadre-cli/src/commands/start.ts:63`) runs before the trust policy is built
   (line 119, ahead of `pinnedKeyTrustPolicy` at 120), so a malformed key reaches neither the
   policy nor the node config. The failure is caught by the `start` action's try/catch →
   `console.error` naming the bad value → `process.exit(1)`. `collectPinnedOwnerKeys`
   (trim/dedupe) stays validation-free on purpose so it unit-tests against plain strings.
2. **`CadreNodeConfig.trustedOwners.pinnedKeys`** — validated in
   `initializeTrustedOwnerStore()` (`cadre-node.ts`) before any pin is trusted.
3. **`CadreInvite.ownerKeys`** — validated in `trustOwnerKeys()` before any key is trusted.

**Decision: whole-batch atomicity.** A malformed key anywhere in a batch rejects the entire
call before a single key is anchored — matching the persisted trusted-owner store's existing
`unusableEntry: 'discard-all'` policy, and avoiding silently anchoring fewer owners than an
invite claimed. Rationale lives in `trustOwnerKeys()`'s docstring.

## Review findings

### Verified from the implement handoff's own checklist

- `validatePinnedOwnerKeys` does run before `pinnedKeyTrustPolicy` — confirmed at
  `start.ts:119–121`.
- The atomicity test genuinely asserts absence, not just rejection:
  `expect(node.getTrustedOwnerStore()!.has(goodKey)).toBe(false)` after the mixed-batch
  rejection. The claim holds.
- Scope: the code landed in commit `45f954c` (labelled `ticket(plan)`) rather than in
  `17d1bf8` (`ticket(implement)`, which moved only the ticket file). Content is the four
  files claimed; the fifth listed file (`ed25519-key.ts`) was untouched by that pass.
  Process note only — no stray edits elsewhere.

### Fixed in this pass (minor)

- **A wrong-length key was rejected without being named.** The length branch of
  `requireEd25519PublicKeyB64` read `(decoded to 24 bytes)` with no mention of *which*
  value — directly undercutting this ticket's stated goal, and useless with several pins in
  one batch. Both rejection branches now quote the offending value.
- **The echoed value was unbounded, and this change made that reachable from remote input.**
  The function carried a `NOTE` saying to cap the echo "if one ever takes the value from a
  remote peer". This ticket tripped exactly that condition: an invite's `ownerKeys` and a
  `cadre-host` donation request's `ownerKeys` are peer-supplied and now flow through this
  check. Echo is capped at 64 characters (a real key is 43) with a `… (N chars)` suffix;
  covered by a new test that a 5000-character junk key yields a message under 200 chars.
  The `NOTE` is retired, replaced by the cap and its rationale.
- **Stale docs the change invalidated or should have updated**, all corrected:
  - `packages/cadre-provider/README.md` and the `validatePinnedOwnerKeys` docstring in
    `packages/cadre-provider/src/server/routes.ts` both still claimed a malformed pin
    "never matches a real signer, so the node refuses the seed rather than failing to
    start" — false as of this change.
  - `packages/cadre-cli/README.md`'s `CADRE_OWNER_KEYS` row now states the shape rule and
    the fail-at-startup behavior, matching how the sibling `CADRE_RELAY_ADDRS` /
    `CADRE_STRAND_FILTER` rows already read.
  - `docs/architecture.md`'s trusted-owner-anchor section now records the entry-point check
    and the all-or-nothing batch rule.
  - `docs/STATUS.md` still described control-key enrollment as accepting "any non-blank
    text… so a typo enrolls silently" and pointed at a `backlog/` ticket that has since
    completed. Rewritten to the current reality and extended to cover pinned owner keys.

### Filed (major)

- `backlog/bug-hosted-owner-key-pins-unchecked-at-api-boundary.md` — the two services that
  accept owner keys over the network and spawn a node with them (`cadre-provider`'s
  `POST /containers`, `cadre-host`'s donation provision) never check key shape. Before this
  change a typo produced a useless-but-running node; now it produces a `201 Created`
  followed by a container that fails to boot, with no `400` naming the bad key. The fix has
  a genuine design choice in it (`cadre-provider` deliberately has no `@serfab/cadre-core`
  dependency), so it is a ticket rather than an inline edit. No open ticket already claimed
  those files.

### Recorded as tripwires, not tickets

- **Off-curve-but-well-formed keys are still accepted** — the check is encoding + length
  only. Already documented in `requireEd25519PublicKeyB64`'s own docstring, and now also in
  `docs/architecture.md`'s anchor section so an architecture reader meets it. Same tradeoff
  the earlier control-key ticket made; only becomes work if curve validation is wanted in
  both places at once.
- **A CLI-started node validates its pins twice** (once in `start.ts`, once in
  `initializeTrustedOwnerStore`). Deliberate, not a DRY violation to unwind: the CLI check
  buys an earlier failure with a source-specific label and guards the trust-policy
  construction, which the node-level check cannot see. Idempotent and O(pins).

### Checked, nothing found

- **Entry-point sweep.** Every writer into the trusted-owner anchor was traced
  (`initializeSeedBootstrap` genesis self-trust, config pins, `trustOwnerKeys`, seed
  `anchorAs`); the first derives its key from a private seed and cannot be malformed, the
  rest are covered. No fourth uncovered seam inside `cadre-core` / `cadre-cli`.
- **Atomicity logic.** Both call sites materialize the validated list before the first
  `trust()` await — no partial-anchor window, and no store mutation happens before
  validation in either path.
- **Resource cleanup / error handling.** The new failure paths throw before any store,
  process, or handle is created; the two new node tests that expect `start()`/`trustOwnerKeys`
  to reject follow the file's existing pattern for fail-closed start tests.
- **Type safety and source hygiene.** No `any`, no widened types; `validatePinnedOwnerKeys`
  is a one-expression function; the new `describeRejected` helper is four lines. No file
  grew meaningfully (`ed25519-key.ts` is 124 lines).

## Validation

```
yarn workspace @serfab/cadre-core build          # clean
yarn workspace @serfab/cadre-cli build           # clean
yarn eslint <all touched .ts files>              # clean
yarn workspace @serfab/cadre-core test           # 1393 passed, 1 skipped, 5 failed
yarn workspace @serfab/cadre-cli test            # 181/181 passed
```

The 5 `cadre-core` failures are entirely
`control-revocation-reissue.spec.ts` / `control-revocation-replay.spec.ts`, listed in
`tickets/.pre-existing-known.md` against the blocked
`10-revocation-reissue-same-pk-update-unique-collision` (a schema-level UNIQUE-constraint
collision on revocation reissue — unrelated subsystem, untouched by this ticket). Not
re-reported. Passing count rose 1392 → 1393 with the new echo-cap test.

`cadre-provider` was not re-tested: the only change there is a docstring.
