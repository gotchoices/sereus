----
description: Demonstrate the trust/permission model in the RN reference — a closed strand with FormationInvite issuance, invitee consent, schema-gated join, and role assignment
prereq: reference-app-rn-discovered-strand-join, formationinvite-fix-curve-and-wire-consent
files: packages/reference-app-rn/src/chat-strand.ts, packages/reference-app-rn/src/use-cadre.ts, packages/reference-app-rn/src/cadre-phone.ts, packages/reference-app-rn/app/settings.tsx, packages/reference-app-rn/README.md, packages/cadre-core/src/cadre-node.ts
----

## Problem

The RN reference only ever creates **open** strands: `createChatStrand`
hardcodes `Type:'o'` and `MemberPrivateKey: null` (`chat-strand.ts:56-66`), and
the README tells every user to connect to the *same* Party ID
(`reference-chat-party`), conflating a single party's private control network
with a multi-party shared space. No `FormationInvite`, formation, schema-gated
join, or role assignment is exercised — so Sereus's central trust/permission and
consent flow goes entirely unshown, even in the canonical reference app.

The building blocks already exist on `CadreNode`:
- `createOpenInvitation(sAppId, expirationMs)` → `OpenInvitation`
  (`cadre-node.ts:930-949`).
- `formStrand(invitation, disclosure)` → `FormStrandResult`
  (`cadre-node.ts:958-975`).
- `encodeInvitation` / `decodeInvitation` for out-of-band transport
  (`cadre-node.ts:980-999`).
- Closed-strand provisioning + the `FormationUsage` consent-authorization path
  are made functional by the prereq `formationinvite-fix-curve-and-wire-consent`
  (fixes the ed25519 curve bug in the `FormationInvite` constraint and wires
  `insertFormationInvite` / `insertFormationUsage`). Design this ticket assuming
  that consent path works end-to-end.

## Design

Add a closed-strand chat flow to the RN reference that exercises the full
host→invitee consent handshake, alongside (not replacing) the existing open
flow. The demonstration must cover all four pillars named in the source ticket:

1. **FormationInvite issuance.** A host action that creates a *closed* chat
   strand and mints an invitation for it via `createOpenInvitation(CHAT_SAPP_ID,
   …)`, surfaced to the user as an encoded string (and ideally a QR code) via
   `encodeInvitation`.
2. **Invitee consent.** An invitee action that takes the encoded invitation,
   `decodeInvitation`s it, and calls `formStrand(invitation, disclosure)` —
   where `disclosure` carries the invitee's identity/purpose
   (`StrandFormationDisclosure`: `partyId`, `purpose`, `metadata`). This is the
   explicit consent step.
3. **Schema-gated join.** `formStrand` provisions the closed strand under the
   chat `sAppConfig`; the resulting `FormStrandResult.strandId` +
   `memberKey`/`invitePrivateKey` are used to attach the strand locally
   (register the chat config and start the instance with `Type:'c'` and the
   member private key). The strand's DDL is the signed chat schema — so the join
   is gated by schema verification, not an open free-for-all.
4. **Role assignment.** Assign the host an owner/admin role and the invitee a
   member role for the strand. Investigate the available role primitive first:
   grep for `Role`, `memberKey`, `MemberPrivateKey`, and any role/RBAC table in
   `control-database.ts` / `schemas/control.qsql`. If a first-class role
   primitive exists, use it; if RBAC is still only `memberKey`-granularity
   (member vs non-member), represent the role at the **chat-app** layer instead —
   e.g. add a `Role text` column to the chat `Member` table (`owner` |
   `member`) and assign it on join — and document in the README that strand-level
   fine-grained RBAC is not yet a cadre-core primitive. Do not invent a
   half-baked control-network RBAC scheme; pick the honest representation and
   note the boundary.

### Closed-strand helper

Add a `createClosedChatStrand` (or extend `createChatStrand` with a `type`
parameter) that sets `Type:'c'` and a generated `MemberPrivateKey`, and a
`joinClosedChatStrandFromFormation(node, formResult)` that attaches the strand
produced by `formStrand`. Keep the open-strand path intact for the existing
quick-start.

### UI surface (`app/settings.tsx`)

Add, in the existing Settings screen:
- A **"Create Closed Strand + Invite"** action → shows the encoded invitation
  (copyable; QR optional) for out-of-band delivery.
- A **"Join via Invite"** input → paste an encoded invitation → `formStrand` →
  attach + switch to the closed strand.

Wire these through `use-cadre.ts` (new hook methods, mirroring `createStrand`)
and `cadre-phone.ts` (thin pass-throughs, mirroring the existing `addStrand`
helper).

### README

Add a "Trust model / closed strands" section to
`packages/reference-app-rn/README.md` documenting the closed-strand flow:
host mints an invite, invitee consents via `formStrand`, the join is
schema-gated, and roles are assigned. Correct the framing that everyone shares
one Party ID — make clear the closed flow demonstrates cross-party consent, not
a shared private control network. State plainly where role granularity is
app-level vs cadre-level.

## Scope boundary

- Builds on the discovery-join wiring from
  `reference-app-rn-discovered-strand-join` (event + join plumbing); do not
  re-implement it.
- Relies on `formationinvite-fix-curve-and-wire-consent` for a working consent
  path; if any part of that path is still inert at implement time, prefer
  filing a follow-up `fix/` ticket over papering it over in the reference app.

## References

- `packages/cadre-core/src/cadre-node.ts:923-999` — `createOpenInvitation`,
  `formStrand`, `encodeInvitation`, `decodeInvitation`.
- `packages/cadre-core/src/types.ts:330-380` — `OpenInvitation`,
  `FormStrandResult`, `StrandFormationDisclosure`, `ValidateFormationResult`.
- `packages/cadre-core/src/control-database.ts:79-112, 376-401` —
  `FormationInvite` / `FormationUsage` schema, `insertStrand`.
- `packages/reference-app-rn/src/chat-strand.ts` — strand helpers (open today).
- `packages/reference-app-rn/app/settings.tsx` — Settings UI host.
- Prereq ticket `formationinvite-fix-curve-and-wire-consent` (curve fix + consent
  wiring) and `bootstrap-dht-discovery-and-strand-cohort-wiring` (transitive,
  via discovery-join).
- Docs: `docs/architecture.md` (Strand Formation, Roles & RBAC), `docs/strands.md`
  ("invitation-only, out-of-band").

## TODO

### Phase 1 — closed-strand helpers
- Add closed-strand creation (`Type:'c'` + generated `MemberPrivateKey`) and a
  formation-result attach helper in `chat-strand.ts`.
- Determine the role primitive (grep control schema); choose cadre-level vs
  app-level role representation and implement the chosen one.

### Phase 2 — hook + node plumbing
- Add `createClosedStrandWithInvite()` and `joinViaInvite(encoded)` to
  `use-cadre.ts`, returning the encoded invite / attached strand respectively.
- Add matching thin pass-throughs in `cadre-phone.ts`.

### Phase 3 — Settings UI
- Add "Create Closed Strand + Invite" (shows encoded invite, copyable) and
  "Join via Invite" (paste → `formStrand` → attach) to `app/settings.tsx`.

### Phase 4 — docs + validation
- Add the "Trust model / closed strands" README section; correct the shared
  Party ID framing; state the role-granularity boundary.
- Build + typecheck reference-app-rn; run `yarn test:bundle` to confirm the
  Metro bundle compiles (stream with `tee`). Be honest in the handoff that the
  full two-device consent handshake needs real devices + the consent prereq and
  cannot be fully exercised in-agent.
