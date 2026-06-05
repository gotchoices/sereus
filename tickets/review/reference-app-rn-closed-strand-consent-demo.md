----
description: REVIEW — RN reference now demonstrates the trust/permission model via a closed strand: host mints + publishes a FormationInvite, invitee consents via formStrand, schema-gated attach, owner/member roles. Builds + typechecks (cadre-core, reference-app-rn) + 316 cadre-core tests + lint + Metro bundle all green. Two-device handshake not exercisable in-agent; one cadre-core consent-protocol gap filed as a follow-up fix.
files: packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/strand-member-key.ts, packages/cadre-core/src/index.ts, packages/reference-app-rn/src/chat-strand.ts, packages/reference-app-rn/src/chat-operations.ts, packages/reference-app-rn/src/use-cadre.ts, packages/reference-app-rn/src/cadre-phone.ts, packages/reference-app-rn/src/test-ids.ts, packages/reference-app-rn/app/settings.tsx, packages/reference-app-rn/metro.config.js, packages/reference-app-rn/README.md, schemas/chat-simple.qsql, packages/reference-app-rn/test-fixture/start.mjs
----

# Review: RN closed-strand consent demo

The RN reference previously only ever created **open** strands and told everyone
to share one Party ID. It now also demonstrates Sereus's trust/permission model:
a **closed** strand formed through an explicit host→invitee consent handshake,
with all four pillars wired and documented. The open quick-start path is intact.

## What changed

### cadre-core (the reusable seam)

- **`strand-member-key.ts` (new)** — `generateStrandMemberKey()`: mints an
  ed25519 `MemberPrivateKey` (base64 protobuf, same encoding `formStrand` uses
  for `invitePrivateKey`). Exported from `index.ts`.
- **`cadre-node.ts` — new `publishFormationInvite(token, sAppId, options?)`** —
  the authority-signed `FormationInvite` insert that `createOpenInvitation`
  deliberately omits (it only mints the out-of-band envelope). Mirrors
  `publishStrand` exactly: signs via `getSelfSigningKey()` + crypto-plugin
  `sign(..., 'ed25519', 'bytes', 'base64url', 'base64url')`, delegates to
  `controlDatabase.insertFormationInvite`. Throws loudly if not started / no
  signing key. **Without this row the host's recorder can't validate the token**,
  so this is the piece that makes the minted token redeemable.

### reference-app-rn

- **`chat-strand.ts`** — `Member.Role text not null default 'member' check (Role in
  ('owner','member'))` added to the embedded schema; `CHAT_SAPP_ID` exported.
  New: `createClosedChatStrand` (mints member key → `publishStrand(id,'c',key)` →
  `addStrand` `Type:'c'` → assigns creator `owner`), `joinClosedChatStrand` /
  `joinClosedChatStrandFromFormation` (attach by id+key → assigns `member`), and
  the `ClosedStrandInvite` envelope (`encodeClosedStrandInvite` /
  `decodeClosedStrandInvite`, base64url, wrapping `encodeInvitation` + strandId +
  memberPrivateKey). Open helpers untouched.
- **`chat-operations.ts`** — `ChatRole` type; `insertMember(strand, id, name,
  role?)` (idempotent `insert or ignore`, so an `owner` row is not clobbered by
  use-chat's later default-`member` insert); `queryMembers` + `ChatMember`
  carry `Role`.
- **`use-cadre.ts`** — `createClosedStrandWithInvite()` (create closed strand →
  `createOpenInvitation` → `publishFormationInvite` → return encoded envelope)
  and `joinViaInvite(encoded)` (decode → `formStrand` consent handshake → attach
  closed strand). Exposed on `UseCadreResult` (auto-surfaced through
  `cadre-context`).
- **`cadre-phone.ts`** — `startPhoneNode` now wires the formation **responder**
  at startup (`initializeStrandSolicitation({ formationUsageRecorder: new
  ControlFormationUsageRecorder(controlDb) })`) so an invitee's `formStrand` dial
  is validated against the live `FormationInvite`/`FormationUsage` tables (the
  default lazy init would accept every token blindly). Thin pass-throughs added:
  `createOpenInvitation`, `publishFormationInvite`, `formStrand` (mirroring the
  existing `addStrand` helper).
- **`app/settings.tsx` + `test-ids.ts`** — new "Closed Strand (Invite-Only)"
  section: **Create Closed Strand + Invite** (shows the copyable encoded
  invitation in the selectable modal) and **Join via Invite** (paste → consent →
  attach). Test IDs `createClosedStrandBtn`, `inviteInput`, `joinViaInviteBtn`.
- **`metro.config.js`** — mapped `path`/`node:path` → empty stub (see
  Pre-existing failure below).
- **`README.md`** — new "Trust model / closed strands" section documenting the
  four pillars + the honest boundaries; corrected the "everyone shares one Party
  ID" framing (a Party ID is one party's private control network; the closed flow
  demonstrates cross-party consent); Key Concepts → Strand now mentions `'c'`.
- **`schemas/chat-simple.qsql` + `test-fixture/start.mjs`** — `Member.Role` added
  to keep the reference schema + drone fixture mirroring the embedded schema.

## How to validate (use cases)

### Ran green (in-agent)
- `yarn workspace @serfab/cadre-core build` — clean (new `strand-member-key` +
  `publishFormationInvite` present in dist).
- `yarn workspace @serfab/cadre-core typecheck` — clean.
- `yarn workspace @serfab/cadre-core test` — **316 passed (24 files)**.
- `yarn workspace @serfab/reference-app-rn typecheck` — clean.
- `eslint` on all changed TS/TSX — **0 errors** (2 pre-existing
  `no-explicit-any` warnings at `cadre-node.ts:88,228`, not in this diff).
- `npx expo export --platform android` (the `test:bundle` compile) — **bundled,
  3581 modules, exit 0** (after the `path` shim workaround).

### Suggested reviewer probes (NOT covered by automated tests)
1. **`publishFormationInvite` happy path** — start a node, run genesis
   (`ensureAuthorityKey` + `initializeSeedBootstrap`), call
   `publishFormationInvite(token, CHAT_SAPP_ID, { expiresAtMs })`, assert a
   `FormationInvite` row lands and `ControlFormationUsageRecorder.isTokenValid`
   returns true. Closest existing exercise: `control-formation-invite.spec.ts`
   (DB-level insert) — a cadre-core test that goes through the new node method
   would lock it down. **Highest-value gap.**
2. **`publishFormationInvite` failure surfacing** — a non-authority node (skip
   genesis) should reject at the `FormationInvite.AuthorizedAddOrRemove`
   constraint; confirm the error propagates out of `createClosedStrandWithInvite`.
3. **Role assignment** — create a closed strand, assert the creator's `Member`
   row is `owner`; join, assert the joiner's is `member`; confirm use-chat's
   later default-`member` `insert or ignore` does not downgrade the owner.
4. **Envelope round-trip** — `encodeClosedStrandInvite` → `decodeClosedStrandInvite`
   returns the same invitation/strandId/memberPrivateKey; a truncated/garbage
   string throws "Malformed closed-strand invite". (Pure functions — unit-testable
   without a node if a `CadreNode` `encode/decodeInvitation` stub is provided.)
5. **Two-device handshake** — host on phone A taps Create Closed Strand + Invite
   (requires A reachable via relay/drone, else `createOpenInvitation` throws "No
   multiaddrs"); paste the invite on phone B → Join via Invite. **Needs real
   devices + a drone; not exercisable in-agent.**

## Honest gaps / things for the reviewer to weigh

- **The on-the-wire consent handshake is only PARTIALLY wired in cadre-core, by
  design of what landed.** `formStrand`'s responder validates the invite **token**
  (consent gate), but the formation *protocol* does NOT thread the token to a
  provisioner, does NOT write the `FormationUsage` consent record over libp2p, and
  `OpenInvitation` carries no strand id. That is why this app delivers the strand
  id + membership key in an out-of-band `ClosedStrandInvite` envelope (mirroring
  the integration harness's `TestOpenInvitation`) rather than relying on
  `formStrand`'s returned `strandId`. Per the source ticket's instruction
  ("prefer filing a follow-up fix/ ticket over papering it over"), this is filed
  as **`tickets/fix/formstrand-protocol-thread-consent-and-provision.md`**, which
  also notes the simplification to make here once it lands (drop the envelope).
  Reviewer: confirm this is the right boundary vs. a deeper cadre-core change in
  this ticket.
- **Role is app-level, not cadre-level.** Confirmed there is NO first-class
  per-strand RBAC table in `schemas/control.qsql` / `control-database.ts`
  (only `AuthorityKey`/`ValidationKey`/`Strand`/`CadrePeer`/`FormationInvite`/
  `FormationUsage`; membership is `MemberPrivateKey`-granular). `owner`/`member`
  therefore lives in the chat `Member.Role` column. Documented in README + the
  `.qsql`. This is the honest representation the ticket asked for — not a
  half-baked control-network RBAC scheme.
- **`joinViaInvite` throws if the host is unreachable.** The consent handshake
  (`formStrand`) is treated as required: a single-device join fails at that step
  (no host to dial). This is intentional — it demonstrates that a closed strand
  cannot be joined without host consent — but means "Join via Invite" is not
  explorable solo. Reviewer may prefer a softer demo (attach-anyway with a
  warning), at the cost of weakening the trust-model point.
- **Minting requires host reachability.** `createOpenInvitation` throws when the
  phone has no dialable multiaddr (solo, no relay/drone), so "Create Closed
  Strand + Invite" needs the host connected to a relay/drone. Honest P2P
  constraint, documented in the README + the Settings hint.
- **Open-strand e2e drone fixture divergence is pre-existing.** `start.mjs`
  already had `Message.Id integer` vs the app's `Message.Id text` (from
  `message-pk-collision-free`); I only aligned the `Member.Role` addition, not
  that prior divergence. Not introduced here; flagging for awareness.

## Pre-existing failure flagged

`tickets/.pre-existing-error.md` documents that the RN Metro bundle could not
resolve `path` **before** any workaround: cadre-core's `@deprecated`,
RN-incompatible `getStrandStoragePath` statically `require('path')`s and
`metro.config.js` mapped every other Node built-in (`os`/`crypto`/`stream`/
`buffer`/`net`/`tls`) but not `path`. This is outside this ticket's diff and would
fail `test:bundle` regardless. Workaround applied so this ticket's bundle could be
validated: `path`/`node:path` → `polyfills/empty.js` (safe — `getStrandStoragePath`
throws on RN before calling `path`). Suggested real fix (de-static the
`require('path')` in cadre-core) noted for the triage pass.
