description: Separated "who can I dial" (addressable, includes self) from "who is a real member" (authorized, excludes self); routed the wake / strand-address gates to the authorized surface. No trust change yet — that lands in ticket 4.
prereq:
files:
  - packages/cadre-core/src/cadre-node.ts (listAuthorizedMembers/isAuthorizedMember ~L2565-2578; wake gate L447, strand-addr gate L458 repointed)
  - packages/cadre-cli/src/server/admin-server.ts (new /admin/authorized-members[/:peerId] resource ~L175)
  - packages/cadre-host/src/authority/authority-node-client.ts (listAuthorizedMembers/isAuthorizedMember client methods ~L126)
  - packages/cadre-core/test/cadre-node-authorized-surface.spec.ts (NEW — surface-split unit coverage)
  - packages/cadre-host/src/authority/__tests__/authority-node-client.test.ts (added authorized-members client-method tests)
  - packages/integration-tests/src/scenarios/cadre-host-authority-node.integration.ts (fresh-party test repointed, L166)
  - docs/cadre-host.md (admin endpoint table), docs/STATUS.md (wake-gate line)
difficulty: medium
---

# Complete: addressable-vs-authorized surface split

Step 1 of the Option-B membership-gate chain (siblings `membership-cadrepeer-voucher-persist`,
`membership-node-local-authority-anchor`, `membership-authorized-predicate-and-gates`,
`seed-trust-anchor-from-local-store`, `membership-connection-gater` — now parked in `backlog/`).

## What shipped

- **`CadreNode.listAuthorizedMembers()` / `isAuthorizedMember()`** — trust-facing set =
  addressable set (`listMembers()`) **minus this node's own peerId**. `isMember`/`listMembers`
  unchanged (addressable, self included). Authorized methods carry a `NOTE:` that ticket 4
  replaces the body with the real predicate (voucher ∈ node-local anchor ∧ sig verifies), so
  the change lands in one place.
- **Wake + strand-addr gates repointed** to `isAuthorizedMember` (`cadre-node.ts:447` / `:458`).
  Every other `isMember`/`listMembers` caller stays on the addressable surface deliberately.
- **Admin API split** — `GET /admin/authorized-members[/:peerId]` added; `/admin/members` stays
  addressable. `AuthorityNodeClient` gained matching client methods.
- **Fresh-party integration test** repointed to the authorized methods.

## Review findings

Scope: the implement diff (4 source files) plus the files it should have touched (tests, docs).

### Checked — correctness / type safety / cleanup

- **Self-exclusion key is sound.** `listAuthorizedMembers` filters on `this.peerId?.toString()`.
  The getter `peerId` returns `this.controlNode?.peerId` (`cadre-node.ts:280-282`), which is
  exactly the key the self `CadrePeer` row is published under (`registerSelf`, `cadre-node.ts:735`
  uses `this.controlNode.peerId.toString()`). No base58/CID format mismatch — exclusion works.
  Ephemeral node (no identity, publishes no self row) → filter is a harmless no-op. **No defect.**
- **Gate repointing is complete and minimal.** Only the two trust-gates (wake `:447`,
  strand-addr `:458`) moved to `isAuthorizedMember`. Grep confirms every remaining consumer
  (`TrustCircleService` display, push fan-out `:472`, reconcile self-filter `:1054`, admin
  `/admin/members`) correctly stays on the addressable surface. No caller was moved onto the
  authorized surface expecting the not-yet-built trust check. **No defect.**
- **Interface / API.** Adding methods to `AuthorityNodeClient` does not break
  `TrustCircleCadreNodeLike` / `NatCadreNodeLike`. Admin route parses `authorized-members` +
  `:peerId` via the existing segment logic; unsupported methods fall through to `bad_request`;
  no DELETE on the authorized surface (delete stays addressable — correct). **No defect.**

### Found + fixed inline (minor — test & doc gaps)

- **The self-exclusion filter had zero direct test coverage.** The repointed fresh-party
  integration test passes on an *empty* list (both surfaces `[]`), so it never exercises
  "addressable includes self, authorized excludes it." Added `cadre-node-authorized-surface.spec.ts`
  (3 tests) asserting the split directly, and 2 mock-based tests in `authority-node-client.test.ts`
  for the new `/admin/authorized-members` routes. All green.
- **Stale docs.** `docs/cadre-host.md` endpoint table listed only the `members` routes — added the
  `authorized-members` rows with the addressable-vs-authorized distinction. `docs/STATUS.md:214`
  said the wake gate uses `CadreNode.isMember` — updated to `isAuthorizedMember`.

### Tripwire (recorded, not ticketed)

- `isAuthorizedMember(peerId)` does a full `listMembers()` DB scan + filter per single-peer probe.
  Fine now; mirrors the pre-existing `isMember` pattern (which has the same shape and predates this
  ticket), so no new NOTE added. If membership grows large and probes become hot, both should move to
  an indexed single-row lookup — parked here rather than in code to avoid asymmetrically annotating
  only the new method.

### Known-open, NOT a regression from this diff (major — owned by ticket 4)

- **`push-wake-e2e` scenario 3 (non-member wake) stays RED by design.** O is not self and has a
  `CadrePeer` row, so `isAuthorizedMember(O)` is still `true` at this step; the real rejection
  (voucher ∉ node-local anchor) lands in `membership-authorized-predicate-and-gates` (ticket 4,
  now in `backlog/`). I did **not** run this expensive real-network scenario: its assertion at
  line 476 keys on the addressable `isMember` (untouched by this diff), and for O both surfaces
  return `true`, so this diff provably cannot change its outcome. Not a new hole — it was failing
  pre-chain, and the non-member wake gap is tracked in `docs/STATUS.md` + ticket 4.

### Pre-existing failures (NOT from this diff)

- `packages/cadre-host/src/update/__tests__/release-key.test.ts` — 2 failures
  (`isPlaceholderReleaseKey` all-zeros/env-override), reproduced this run. Root cause: a production
  signing key was embedded into the source default (commits `b48b027`/`fb79894`), so placeholder
  detection sees non-zeros. Outside the membership diff (whose only `cadre-host` edit is 2 client
  methods). Not tracked in `tickets/.pre-existing-known.md` (absent) → wrote
  `tickets/.pre-existing-error.md` for the runner's triage pass. (The implement handoff also named
  `orchestrator.test.ts > zero network counters` as a third failure; it did not fail this run.)

## Verification

- `yarn lint` (full repo) — clean, exit 0.
- `yarn typecheck` — clean across cadre-core, cadre-cli, cadre-host, integration-tests.
- cadre-core: 140 tests pass (cadre-node, strand-wake, strand-addr specs) + new
  `cadre-node-authorized-surface.spec.ts` 3/3.
- cadre-host: `authority-node-client` 14/14 (incl. 2 new), `trust-circle` suites green.
- `cadre-host-authority-node.integration.ts` — 9/9 (fresh-party green on authorized surface).
