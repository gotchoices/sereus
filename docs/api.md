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
formStrand(
    invitation: OpenInvitation,
    disclosure: StrandFormationDisclosure,
    node?: Libp2p
): Promise<{
    memberKey: string,
    invitePrivateKey: string,
    strandId: string,
    memberPrivateKey?: string,   // closed strands only
}>;
```

## Validate Strand Formation (approval hook)

An invitation may carry a `ValidationUrl`: a web hook an outside approver operates, which is
asked whether one particular redemption of that invitation may proceed.

**The inviting party's node contacts the hook — not the joiner.** The party enrolled the
approver's key and published the URL, so the trust relationship is the party's: the hook answers
to the party, and its answer must reach the row the party writes without passing through the
joiner's hands.

The single-use nonce the approval is bound to is minted by the **joiner**, not by the inviting
node (`strand-solicitation.ts`). The joiner mints it, signs its own consent over it, and sends
both in the contact message; the responder inserts that same value and asks the approver about
it. Two separate signatures therefore cover one nonce — the joiner's `PeerSig` (it agreed to
this redemption) and the approver's sign-off (this redemption may proceed) — so neither party
can move an approval onto a different redemption, and the responder cannot manufacture a
consent it did not receive.

Client side, in `@serfab/cadre-core`: `createHttpFormationApprover()` (the transport),
`signFormationApproval()` / `verifyFormationApproval()` (the digest helpers), and
`FormationApprovalError` with a `failure` of `'refused' | 'unavailable' | 'malformed' |
'unenrolled' | 'misconfigured'`.

`ControlFormationUsageRecorder` contacts the hook automatically on both redemption paths
(`recordUsage` against an existing host strand, and `provisionAndRecord` for an unbound invite):
it reads the invite's `ValidationUrl`, calls the approver with the nonce and peer key the joiner
supplied, and writes the sign-off with the usage row — alongside the joiner's own consent
signature, which the schema re-verifies on that same insert.

### Wire contract

`POST <ValidationUrl>` with `content-type: application/json` and `accept: application/json`.
The body is **exactly** the five signed fields, and nothing else — no owner keys, no bootstrap
addresses, no membership keys:

```json
{
  "token": "invite-...",
  "usageStampId": "the redemption's single-use nonce, minted by the joiner",
  "strandId": "the strand being joined",
  "peerKey": "base64url ed25519 public key of the joining peer",
  "disclosure": "verbatim text that will be stored as FormationUsage.Disclosure"
}
```

`peerKey` is the joiner's **key**, not its libp2p peer id: an Ed25519 peer id is the identity
multihash of exactly those key bytes, so a hook that wants the peer id can derive it, while a
hook that wants to check a signature has the key it needs. It is what lands in
`FormationUsage.PeerKey`, and the joiner has itself signed a digest over it
(`FormationUsage.PeerSig`) — so the peer named in the body provably asked to join, rather than
merely being named by whoever is redeeming.

It is the joiner's **strand-membership** key, though — `formStrand` generates a fresh keypair per
formation — so it is the key behind the `partyId` inside `disclosure`, not the joiner's long-lived
control-network peer id, and it is different for every strand the same joiner forms. A hook that
keeps an allow-list therefore has to key it off something the joiner disclosed, not off `peerKey`;
what `peerKey` gets you is that the disclosed identity is the one that actually signed.

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

All of this contract is executable: `strand-formation-e2e.integration.ts` Phase 5 stands up a
real hook (`harness/fixtures/approval-hook-server.ts`) and redeems a `ValidationUrl` invitation
through it over real libp2p — asserting the request is a `POST` of those five fields and nothing
else, at the `ValidationUrl`'s own path with the JSON content/accept headers above. It runs both
invitation shapes: unbound (the responder mints the strand) and bound to a pre-existing closed
strand (whose membership key reaches the joiner after sign-off and never reaches the approver).
And it drives all five rejection reasons end to end — refusal, an unenrolled key, a key removed
after the invitation went out, a replayed sign-off, an approver that cannot be asked (unreachable,
and answering a non-2xx), and a `ValidationUrl` the node cannot use at all — each yielding the
reason above while leaving the seat unspent, which is what makes the "no `FormationUsage` row"
claim above checkable rather than merely asserted. The transport decision table itself (redirects, body cap,
timeouts, dead socket) stays covered at the HTTP-client level, in
`test/formation-approval-real-fetch.spec.ts`.

The `disclosure` field is capped at **8 KiB** of UTF-8 (a hook is never asked to review more
than that; an over-size disclosure is rejected before the hook is contacted). Size a review UI
against that number.

Operational notes for hook authors: redirects are **not** followed (re-publish a moved
`ValidationUrl` rather than redirecting at redemption time); the response body is capped at
64 KiB; the whole exchange — headers and body read included — is abandoned after 10 s by default,
whether or not the runtime honours the abort; and `http:` is permitted (self-hosted LAN
approvers) but puts the disclosure text on the wire in clear.

Note what a hook is trusted with. It sees the joiner's disclosure text, and it sees the
invitation token — a bearer credential, so whoever holds the hook could redeem the invitation
itself instead of approving the joiner who presented it. That is inside the approver's existing
trust boundary (an enrolled approver can already admit anyone it likes), but it does mean a hook
is party infrastructure, not a public endpoint: host it accordingly, and prefer `https:` for
anything off-link.

### What the signature covers

The signature authorizes **exactly one** redemption. It is made over
`digest('CadreControl.FormationUsage', 'vouch', Token, UsageStampId, StrandId, PeerKey, Disclosure)`
— produce it with `signFormationApproval` (or, in another language, build the digest to match
`formationVouchMessage`; never a hand-written field list) — which
`FormationUsage.Authorized` re-verifies against the enrolled `ValidationKey` row when the
redemption is written. Binding the nonce, strand, and peer makes the approval non-transferable:
it cannot be re-presented for another use of the same invitation, another strand, or another
joiner. Sign the `disclosure` bytes verbatim; do not re-serialize them.

Notice that nothing derived from the invitation's stored state is among the five signed fields —
the nonce (`UsageStampId`) is minted by the redeeming side and is the acceptance record's own
key. That is what backs the following guarantee: **a hook is contacted at most once per
redemption, never once per write attempt.** Each redemption is stored under its own nonce, so two
nodes redeeming the same invitation at once never contend for a shared record and there is no
lost race to recover from. The invitation's use limit is enforced by counting the recorded
redemptions: a spent invitation is refused — reported to the joiner the same way an invalid token
is, never as a retryable conflict — but redemptions that run simultaneously (or on nodes that
have not yet converged) can each read the same count and exceed the stated limit by up to the
number of simultaneous redeemers. Every acceptance survives in the append-only record, so an
overage is visible there and reversible by owner-gated member removal; treat `TotalUses` as an
audited bound, not a hard ceiling under concurrency.

> **Current limitation (2026-08-12).** On a party running more than one cadre node, the
> overage is not bounded by the number of simultaneous redeemers: each node counts only the
> redemptions it recorded itself, because a replicated row's secondary-index entry does not
> currently reach the other nodes. A spent invitation also still reads as outstanding to the
> membership connection gate. This is a storage-layer defect being fixed upstream — see
> `docs/architecture.md` → strand formation — not a property of the invitation design.

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

  if (!mayJoin(fields.peerKey, fields.disclosure)) {
    res.status(403).json({ error: 'not on the roster' });
    return;
  }

  res.json(signFormationApproval(fields, validationKey, privateKeyB64));
}).listen(8080);
```
