## Cadre peer authorization (Seed Bootstrap API):

Owner nodes authorize new peers via signed seeds containing peer info and control network state.

```ts
// Create peer identity (on new node)
createCadrePeer(): Promise<{ peerId: PeerId; privateKey: Uint8Array }>;

// Authorize and create seed (on owner node)
authorizePeer(peerId: string, multiaddrs?: string[]): Promise<void>;
createSeed(): Promise<ControlNetworkSeed>;

// Deliver seed to new node
deliverSeed(targetMultiaddr: string, seed: ControlNetworkSeed): Promise<SeedAckMessage>;
// Or encode for out-of-band delivery (QR, link, API)
encodeSeed(seed: ControlNetworkSeed): string;

// Apply seed (on new node)
applySeed(seed: ControlNetworkSeed): Promise<ApplySeedResult>;

// Helper for provider-hosted drones
addDrone(options: AddDroneOptions): Promise<DroneInitResult>;
```

## Member registration:

Send from invited member to any cadre member to accept invitation and include as a member.

```ts
type Registration = {
    strandId: string, 
    key: string, 
    peer_ids: PeerId[],
};
registerMember(registration: Registration, signature: string): Promise<{success: boolean; reason?: string}>;
```

## Strand Solicitation:

### Open invite

Send from a party who accessed an open invitation to form a strand with me, to any of my cadre members.

Open invitation:
```ts
type OpenInvitation = {
    token: string;
    sAppId: string;
    expiration: DateTime,
    bootstrap: Muliaddr[],
}
```

Invitee forms:
```ts
formStrand(token: string, disclosure: object): { memberKey: string, invitePrivateKey: string };
```

## Validate Strand Formation (approval hook)

An invitation may carry a `ValidationUrl`: a web hook an outside approver operates, which is
asked whether one particular redemption of that invitation may proceed.

**The inviting party's node contacts the hook — not the joiner.** The party enrolled the
approver's key and published the URL, so the trust relationship is the party's; and the approval
is bound to a single-use nonce that only the redeeming node mints, so only that node can
guarantee the nonce that was signed is the nonce that gets inserted.

Client side, in `@serfab/cadre-core`: `createHttpFormationApprover()` (the transport),
`signFormationApproval()` / `verifyFormationApproval()` (the digest helpers), and
`FormationApprovalError` with a `failure` of `'refused' | 'unavailable' | 'malformed' |
'misconfigured'`.

### Wire contract

`POST <ValidationUrl>` with `content-type: application/json` and `accept: application/json`.
The body is **exactly** the five signed fields, and nothing else — no owner keys, no bootstrap
addresses, no membership keys:

```json
{
  "token": "invite-...",
  "usageStampId": "the redemption's single-use nonce",
  "strandId": "the strand being joined",
  "peerId": "the joining peer",
  "disclosure": "verbatim text that will be stored as FormationUsage.Disclosure"
}
```

Answer with `200` and:

```json
{ "validationKey": "base64url ed25519 public key", "validationSignature": "base64url signature" }
```

| Hook answer | Client outcome |
| --- | --- |
| `200` with both fields non-blank | approval |
| `401` / `403` (whatever the body) | `refused` — a final no |
| any other non-2xx, network error, timeout, redirect | `unavailable` — may succeed later |
| `2xx` that is not JSON, is missing/blank a field, or exceeds 64 KiB | `malformed` |
| `ValidationUrl` is not `http:`/`https:`, or the runtime has no `fetch` | `misconfigured` |

Operational notes for hook authors: redirects are **not** followed (re-publish a moved
`ValidationUrl` rather than redirecting at redemption time); the response body is capped at
64 KiB; the request is aborted after 10 s by default; and `http:` is permitted (self-hosted LAN
approvers) but puts the disclosure text on the wire in clear.

### What the signature covers

The signature authorizes **exactly one** redemption. It is made over
`digest('CadreControl.FormationUsage', 'vouch', Token, UsageStampId, StrandId, PeerId, Disclosure)`
— build it with `formationVouchMessage` from `@serfab/cadre-core` rather than by hand — which
`FormationUsage.Authorized` re-verifies against the enrolled `ValidationKey` row when the
redemption is written. Binding the nonce, strand, and peer makes the approval non-transferable:
it cannot be re-presented for another use of the same invitation, another strand, or another
joiner. Sign the `disclosure` bytes verbatim; do not re-serialize them.

### A hook in TypeScript

```ts
import express from 'express';
import { signFormationApproval, type FormationApprovalRequest } from '@serfab/cadre-core';

// The approver's ed25519 seed (base64url). Its public half must be enrolled as a
// ValidationKey row in the inviting party's control database, or the redemption still fails.
const privateKeyB64 = process.env['APPROVER_KEY']!;
const validationKey = process.env['APPROVER_PUBLIC_KEY']!;

express().use(express.json()).post('/approve', (req, res) => {
  const request = req.body as FormationApprovalRequest;

  if (!mayJoin(request.peerId, request.disclosure)) {
    res.status(403).json({ error: 'not on the roster' });
    return;
  }

  // `signFormationApproval` ignores `validationUrl`; only the five signed fields matter.
  res.json(signFormationApproval(request, validationKey, privateKeyB64));
}).listen(8080);
```
