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

## Validate Strand Formation

```ts
validateStrandFormation(token string, disclosure: object): { validationKey: string; validationSignature: string };
```

The returned signature authorizes **exactly one** redemption: it is made over
`digest('CadreControl.FormationUsage', 'vouch', Token, UsageStampId, StrandId, PeerId, Disclosure)`
(build it with `formationVouchMessage` from `@serfab/cadre-core`), which
`FormationUsage.Authorized` re-verifies against the enrolled `ValidationKey` row. So the approver
must be handed the redemption's single-use nonce, the strand being joined, and the joining peer as
well as the token and disclosure — the two-argument shape above predates that binding and is not
enough to produce a signature the control database will accept. Wiring the responder side up to
call this is `tickets/plan/feat-formation-validation-webhook-unwired`.
