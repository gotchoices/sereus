----
description: Separated "who can I dial" (addressable, includes self) from "who is a real member" (authorized, excludes self); routed the wake / strand-address gates to the authorized surface. No trust change yet — that lands in ticket 4.
prereq:
files:
  - packages/cadre-core/src/cadre-node.ts (listAuthorizedMembers/isAuthorizedMember added ~L2547-2585; wake gate L446, strand-addr gate L458 repointed)
  - packages/cadre-cli/src/server/admin-server.ts (new /admin/authorized-members[/:peerId] resource ~L172)
  - packages/cadre-host/src/authority/authority-node-client.ts (listAuthorizedMembers/isAuthorizedMember client methods)
  - packages/integration-tests/src/scenarios/cadre-host-authority-node.integration.ts (fresh-party test repointed to authorized surface, L166)
difficulty: medium
----

# Review: addressable-vs-authorized surface split

Step 1 of the Option-B membership-gate chain (see `membership-cadrepeer-voucher-persist`,
`membership-node-local-authority-anchor`, `membership-authorized-predicate-and-gates`,
`seed-trust-anchor-from-local-store`, `membership-connection-gater` for the rest).

## What was built

- **`CadreNode.listAuthorizedMembers()` / `isAuthorizedMember()`** — the trust-facing
  set, defined as the addressable set (`listMembers()`) **minus this node's own peerId**.
  `isMember`/`listMembers` are unchanged (addressable, self included) and got a doc
  clarification. The authorized methods carry a `NOTE:` that ticket 4 replaces the
  body with the real predicate (voucher ∈ node-local anchor ∧ sig verifies), so the
  change lands in one place.
- **Wake + strand-addr gates repointed** to `isAuthorizedMember` (`cadre-node.ts:446`
  StrandWakeService, `:458` StrandAddrService). Every other `isMember`/`listMembers`
  caller (address resolution, push fan-out, host trust-circle display) stays on the
  addressable surface deliberately.
- **Admin API split** — added `GET /admin/authorized-members[/:peerId]` to
  `admin-server.ts`; `/admin/members` stays addressable so the host trust-circle `[self]`
  display is untouched. `AuthorityNodeClient` gained matching `listAuthorizedMembers()`
  / `isAuthorizedMember()`.
- **Fresh-party test** repointed to the authorized methods — a fresh authority
  self-registers a `CadrePeer` address row but has authorized no one, so the authorized
  set is empty (`[]`).

## Verification run

- `yarn typecheck` — clean across cadre-core, cadre-cli, cadre-host, integration-tests.
- `yarn lint` — clean (0/0).
- cadre-core specs `cadre-node` + `strand-wake-protocol` + `strand-addr-protocol` —
  78/78 pass.
- `cadre-host-authority-node.integration.ts` — 9/9 pass (fresh-party now green;
  accept-phone/remove cycle still green on the addressable surface).
- cadre-host unit suite — the trust-circle `[self]` display tests still pass (addressable
  path unchanged).

## Known gaps / what the reviewer must scrutinize

- **push-wake-e2e scenario 3 (non-member) is still RED by design.** O is not self and
  has a `CadrePeer` row, so `isAuthorizedMember(O)` is still true at this step — the real
  rejection lands in ticket 4 (voucher ∉ node-local anchor). Do NOT treat scenario 3 as
  a regression from this ticket; it was already failing pre-chain.
- **Production trust-circle display vs the split.** The host's `TrustCircleService`
  reaches the authority node via `AuthorityNodeClient` → `/admin/members` (addressable,
  self included), matching the direct-node `trust-circle-integration.test.ts` that
  asserts `[self]`. Confirm this consistency holds and that nothing else consumes
  `/admin/members` expecting authorized semantics.
- **Is `isAuthorizedMember` = "addressable minus self" a safe interim?** It leaves the
  non-member wake hole open until ticket 4. That is intentional and documented, but the
  reviewer should confirm no *other* caller was moved onto the authorized surface
  expecting the (not-yet-built) trust check.
- **Self keying.** Exclusion keys on `this.peerId?.toString()`. For an ephemeral node
  (no identity key) exclusion is a no-op (it publishes no self row) — verify that is the
  intended behavior and that `this.peerId` is populated at every call site.

## Pre-existing failures (NOT from this diff)

`cadre-host` unit suite has 3 failures outside this change:
`update/release-key.test.ts` (2 — "all-zeros placeholder" broken by the recently-embedded
production signing key, commits `b48b027`/`fb79894`) and `orchestrator.test.ts >
getStats > zero network counters` (1). Neither references membership; this ticket's only
cadre-host edit is the 2-method addition to `authority-node-client.ts`.
