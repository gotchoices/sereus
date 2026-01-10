## Cadre peer authorization:

Sent from authority to drone provider to spawn new cadre member. Network ID is assumed for all control strands

```ts
createCadrePeer(): Promise<PeerId>;
registerCadrePeer(bootstrapNodes: Multiaddr[], peerId: PeerId, authorityKey: string, signature: string);
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
    expiration: DateTime,
    bootstrap: Muliaddr[],
}
```

Inviter forms:
```ts
formStrand(token: string, disclosure: object): { memberKey: string, invitePrivateKey: string };
```

