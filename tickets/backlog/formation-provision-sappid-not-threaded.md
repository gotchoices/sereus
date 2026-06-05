description: StrandFormationManager.provisionAsResponder calls strandProvisioner.provisionStrand('', initiatorPartyId, this.partyId) with an EMPTY sAppId — the responder provisions a strand without the sApp identity carried by the invitation/token. Thread the real sAppId (from the redeemed FormationInvite) through to provisioning.
files: packages/cadre-core/src/strand-formation-manager.ts, packages/cadre-core/src/strand-solicitation.ts, packages/cadre-core/src/control-database.ts
----

## Problem

`strand-formation-manager.ts:228`:

```ts
const result = await this.strandProvisioner.provisionStrand('', initiatorPartyId, this.partyId);
```

The first argument is `sAppId`, hardcoded to `''`. The responder therefore provisions
the strand without knowing which sApp it is for, even though the `FormationInvite`
row (and the inbound token) carry `sAppId`. Today every wired `StrandProvisioner`
ignores the argument (`_sAppId`), so nothing breaks — but a real provisioner that
must select schema/storage by sApp has no way to.

This was nominally "tracked by `formationinvite-fix-curve-and-wire-consent`" (per the
`strand-formation-disclosure-not-transmitted` review), but that ticket's scope was
the consent DB path + curve fix and it did not touch the manager's provisioning call.

## Desired behavior

When the responder provisions, look up the redeemed invite's `sAppId`
(`ControlDatabase.queryFormationInvite(token).sAppId`, now available) and pass it to
`provisionStrand` instead of `''`. The token is already in scope on the responder
session (`validateToken`). Confirm the `StrandProvisioner` contract documents that
`sAppId` is now authoritative, and add a test asserting the real sAppId reaches the
provisioner.

Future concern (backlog rather than fix) because it needs a small design decision on
where the token→sAppId lookup belongs in the responder session lifecycle, and no
current path is broken by the empty value.
