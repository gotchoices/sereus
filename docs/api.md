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
'unenrolled' | 'misconfigured'`.

`ControlFormationUsageRecorder` contacts the hook automatically on both redemption paths
(`recordUsage` against an existing host strand, and `provisionAndRecord` for an unbound invite):
it reads the invite's `ValidationUrl`, mints the nonce, calls the approver, and writes the
sign-off with the usage row.

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
| `200`, signature verifies, but the signing key is not an enrolled `ValidationKey` | `unenrolled` |
| `ValidationUrl` is not `http:`/`https:`, or the runtime has no `fetch` | `misconfigured` |

The joiner never sees the failure category itself — the responder maps it to one of these
rejection reasons on the formation result:

| `failure` | Reason the joiner receives |
| --- | --- |
| `refused` | `Formation approval refused` |
| `unavailable` | `Formation approval unavailable, retry` |
| `malformed` | `Formation approval invalid` |
| `unenrolled` | `Formation approval key is not enrolled` |
| `misconfigured` | `Formation approval misconfigured` |

None of these write a `FormationUsage` row, so a rejected redemption does not consume the
invitation — the same token can be presented again.

The `disclosure` field is capped at **8 KiB** of UTF-8 (a hook is never asked to review more
than that; an over-size disclosure is rejected before the hook is contacted). Size a review UI
against that number.

Operational notes for hook authors: redirects are **not** followed (re-publish a moved
`ValidationUrl` rather than redirecting at redemption time); the response body is capped at
64 KiB; the request is aborted after 10 s by default; and `http:` is permitted (self-hosted LAN
approvers) but puts the disclosure text on the wire in clear.

Note what a hook is trusted with. It sees the joiner's disclosure text, and it sees the
invitation token — a bearer credential, so whoever holds the hook could redeem the invitation
itself instead of approving the joiner who presented it. That is inside the approver's existing
trust boundary (an enrolled approver can already admit anyone it likes), but it does mean a hook
is party infrastructure, not a public endpoint: host it accordingly, and prefer `https:` for
anything off-link.

### What the signature covers

The signature authorizes **exactly one** redemption. It is made over
`digest('CadreControl.FormationUsage', 'vouch', Token, UsageStampId, StrandId, PeerId, Disclosure)`
— produce it with `signFormationApproval` (or, in another language, build the digest to match
`formationVouchMessage`; never a hand-written field list) — which
`FormationUsage.Authorized` re-verifies against the enrolled `ValidationKey` row when the
redemption is written. Binding the nonce, strand, and peer makes the approval non-transferable:
it cannot be re-presented for another use of the same invitation, another strand, or another
joiner. Sign the `disclosure` bytes verbatim; do not re-serialize them.

### A hook in TypeScript

```ts
import express from 'express';
import { signFormationApproval, type FormationVouchFields } from '@serfab/cadre-core';

// The approver's ed25519 seed (base64url). Its public half must be enrolled as a
// ValidationKey row in the inviting party's control database, or the redemption still fails.
const privateKeyB64 = process.env['APPROVER_KEY']!;
const validationKey = process.env['APPROVER_PUBLIC_KEY']!;

express().use(express.json()).post('/approve', (req, res) => {
  // `FormationVouchFields` is exactly the posted body — the five signed fields. (A redeeming
  // node's own `FormationApprovalRequest` adds the `validationUrl`, which never reaches a hook.)
  const fields = req.body as FormationVouchFields;

  if (!mayJoin(fields.peerId, fields.disclosure)) {
    res.status(403).json({ error: 'not on the roster' });
    return;
  }

  res.json(signFormationApproval(fields, validationKey, privateKeyB64));
}).listen(8080);
```
