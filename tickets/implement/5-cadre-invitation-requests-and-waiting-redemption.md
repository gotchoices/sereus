description: Give apps what they need to hand a cadre invitation from one app to another: a short "join request" a new app can copy to the owner app, invitations small and labelled enough to paste or show as a QR code, a warning when no always-on machine could take the redemption, and a redemption that keeps waiting for such a machine instead of failing at once.
prereq: cadre-invitations-redeemable-by-any-member
architecture: docs/architecture.md#enrollment-flow-invitation-redeemed-at-any-member
files: packages/cadre-core/src/cadre-invite-protocol.ts, packages/cadre-core/src/cadre-join-request.ts (new), packages/cadre-core/src/invitation-bootstrap.ts, packages/cadre-core/src/node-claim-payload.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/cadre-invite-protocol.spec.ts, packages/integration-tests/src/harness/cadre-invite.ts, packages/integration-tests/src/scenarios/app-joins-cadre-by-invitation.integration.ts (new), packages/cadre-cli/src/commands/start-invitation.ts, packages/cadre-host/src/hosted/__tests__/test-invitation.ts, docs/architecture.md
difficulty: medium
----

# Join requests, labelled invitations, and a redemption that waits

This is the platform-neutral half of `app-joins-existing-cadre-by-invitation` (the original plan ticket, now split). Everything here lives in `@serfab/cadre-core`, so the React Native kit, the web app and the CLI share it. The phone kit's party switch is the follow-up ticket that keeps the slug `app-joins-existing-cadre-by-invitation`; the screens are `reference-apps-join-existing-cadre`.

## Background: what exists

`CadreNode.createCadreInvitation({ peerId?, grantsOwner, expiresInMs?, uses? })` mints an owner-signed invitation (a keypair plus the signed `CadreInvite` row, the issuer's anchored owner keys, and member addresses); `redeemCadreInvitation(invitation)` redeems it at the first named member that accepts (`redeemAtMembers` in `cadre-invite-protocol.ts`); `listCadreInvitations` / `withdrawCadreInvitation` manage outstanding ones; `encodeCadreInvitation` / `decodeCadreInvitation` are base64url JSON with no prefix. See `docs/architecture.md` → "Enrollment Flow: Invitation Redeemed at Any Member".

## The two app flows this serves (settled with the project owner)

- **Targeted (request / response)** — the safer default for owner grants, because the invitation is useless to anyone else. B: "Copy request" → A: "Paste request", choose "also an owner", approve → A mints an invitation targeted at B's peer id and copies it → B: "Paste response", redeems at whichever member it can reach.
- **Open (one paste)** — A: "Copy invitation" (owner or not; single use; short expiry) → B: "Paste invitation". Whoever redeems first designates the peer id, so an open owner invitation is equivalent to handing over admin rights until it is used or expires (the existing 15-minute default for untargeted owner invitations stays).

In both, B pins the owner keys the invitation carries (the existing invite-pin trust path).

## What to build

### 1. The join request (new file `cadre-join-request.ts`, exported from the package root)

```typescript
export const CADRE_JOIN_REQUEST_PREFIX = 'sereus-join-request:1.';
export interface CadreJoinRequest {
  v: 1;
  /** The requesting node's peer id: an Ed25519 peer id, since the invitation targets that key. */
  peerId: string;
  /** What the requester calls itself, for the owner's approval prompt. Unverified; at most 64 characters, trimmed, non-empty. */
  appName: string;
}
export function encodeCadreJoinRequest(request: CadreJoinRequest): string;   // prefix + base64url(canonicalJson)
export function decodeCadreJoinRequest(text: string): CadreJoinRequest;
```

Follow `node-claim-payload.ts`'s shape: canonical JSON (`canonical-json.ts`), base64url, a versioned prefix, the encoder refusing what the decoder would. The decoder trims, refuses (each by name): a missing or other-version prefix; text carrying the invitation prefix ("this is an invitation; paste it where the app asks for one"); a body that is not base64url JSON of this shape; a peer id that does not parse or is not Ed25519 (`peerIdFromString`, then check the key type — a targeted invitation names a key); an `appName` that is empty or longer than 64 characters. Imports must stay React-Native- and browser-safe (no Node built-ins), like `node-claim-payload.ts`.

The owner side needs no new call: `createCadreInvitation({ peerId: request.peerId, grantsOwner })`.

### 2. Invitation encoding: prefix and size

- `encodeCadreInvitation` emits `sereus-invite:1.<base64url JSON>` (export `CADRE_INVITATION_PREFIX`). `decodeCadreInvitation` requires the prefix (no backwards compatibility: nothing stores encoded invitations across versions) and refuses a join request by name ("this is a join request; paste it into the app that manages your cadre"). Every caller goes through these two functions; grep for hand-built bundles in tests (`packages/cadre-host/src/hosted/__tests__/test-invitation.ts`, `packages/integration-tests/src/harness/cadre-invite.ts`) and fix any that bypass them.
- **Cap the member addresses a cadre invitation carries at 6 in total** (`CADRE_INVITATION_MAX_ADDRS`): the minting machine's own addresses first (at most 4, `INVITATION_ADDRS_PER_SIBLING`), then other members' addresses at most 2 each (`CADRE_INVITATION_ADDRS_PER_SIBLING`), in the existing `selectInvitationSiblingAddrs` order, the whole list sliced to 6. Strand open invitations (`createOpenInvitation`) keep today's caps; give `selectInvitationSiblingAddrs` a per-sibling parameter rather than a second copy. Update the `NOTE: if invitations are ever carried in a QR code` in `invitation-bootstrap.ts` to say this cap is the answer for cadre invitations.
- **Measured** (a node script building a bundle with realistic shapes: relay addresses ~150 characters, direct `/ip4/…/ws/p2p/…` ~85, alternating; 43-character keys; 86-character signature): encoded length including the prefix is 1,290 characters at 2 addresses / 3 owner keys, 1,631 at 4, 1,972 at 6, 2,314 at 8; each further owner key adds about 60. Today's uncapped maximum (4 + 3×4 addresses) is about 3,660, which exceeds the largest QR code's byte capacity (version 40, error-correction level L: 2,953 bytes). At the 6-address cap with 3 owner keys the text fits that QR code with room to spare; the screens ticket chooses the error-correction level.

### 3. Will anyone be able to redeem it? (`reach` on the mint result)

`CreateCadreInvitationResult` gains `reach: CadreInvitationReach`:

```typescript
/** Where a phone could redeem the invitation from, judged on the addresses of machines other than the one that minted it. */
export type CadreInvitationReach =
  | 'anywhere'        // another machine has a relayed (/p2p-circuit), public-name or public-IP WebSocket address
  | 'local-network'   // other machines are named, but only at private or loopback addresses
  | 'issuer-only';    // the bundle names no machine but the one that minted it
```

Computed in `createCadreInvitation`, where the minting machine's peer id is known (an address's destination is its last `/p2p/`; `destinationPeerIdOf` in `node-claim-payload.ts`). Classify with the classifier already in `node-claim-payload.ts` (`classifyClaimAddress`: relay, name, public, private; it drops plain TCP, which a phone cannot dial, and loopback) — export a small `classifyDialAddress` from there (or move it to its own module) rather than writing a second classifier; loopback counts as `local-network` here, so tests on loopback still read as "another machine is named". The minting machine's own addresses are excluded because, in the app flows, the minting app is the one that will be closed or in the background when the other app redeems (two apps on one phone cannot reach each other: phones accept no connections and iOS does not run two apps at once).

The screens ticket turns `issuer-only` into "this cadre has no always-on machine, so the new app can join only while this one is reachable" before handing the invitation over, and `local-network` into "works on this network only".

### 4. A redemption that waits for a member

```typescript
export interface RedeemCadreInvitationOptions {
  /**
   * Keep making passes over the bundle's addresses while every answer is retryable, until a
   * member accepts, one refuses finally, the invitation expires, or `signal` aborts.
   * Default false: one pass, as today.
   */
  waitForMember?: boolean;
  signal?: AbortSignal;
  onProgress?: (progress: CadreJoinProgress) => void;
}
export type CadreJoinProgress =
  | { state: 'redeeming'; pass: number }
  | {
      state: 'waiting';
      pass: number;
      /** Epoch ms of the next pass. */
      retryAtMs: number;
      /** 'no-member-answered': every address failed to dial or answer. 'member-not-ready': at least one member answered with a retryable refusal (issuer-unknown, busy, conflict, internal). */
      reason: 'no-member-answered' | 'member-not-ready';
      outcomes: readonly CadreInviteAddressOutcome[];
    };
redeemCadreInvitation(invitation: CadreInvitation, options?: RedeemCadreInvitationOptions): Promise<RedeemCadreInvitationResult>;
```

- **One signed request for every pass.** Pin the owner keys and sign the request (one `usageStampId`) once, before the first pass. The stamp is the usage row's key: a member that admitted B on pass 1 but whose reply was lost must not see a second usage on pass 2 (a single-use invitation would then answer `invite-spent`). Today `redeemCadreInvitation` signs inside the call, so restructure it rather than looping around it.
- Pass pacing: 5 s after the first failed pass, doubling to a 60 s ceiling. These are retry pacing, not link deadlines; if the `link-deadline-literal` lint gate flags them, use its disable comment with that reason, as `DEFAULT_REDEEM_READ_TIMEOUT_MS` does.
- Expiry: before each pass, if the row's `expiresAt` has passed, throw `CadreInviteRejectedError('invite-spent', 'the invitation expired before a member accepted it')`, so callers map it as they map a member's `invite-spent` (both apps' `join-failure.ts`).
- Abort: `signal` aborts the pause and the pass in flight. Thread it into `redeemAtMembers` (new `RedeemAtMembersOptions.signal`, combined with each address's deadline) and throw the signal's reason.
- `onProgress` exceptions are logged and ignored (a UI callback must not break the join).
- A final refusal and an invalid reply still end the call at once, as today.
- Replace the integration harness's `redeemWithRetry` with `waitForMember` where it is a drop-in, keeping the attempt-count logging the scenarios rely on (the `pass` in `onProgress` gives it).
- The CLI keeps one pass. Update the `NOTE:` in `packages/cadre-cli/src/commands/start-invitation.ts` (the "retryable refusal is not retried" tripwire) to point at `waitForMember` as the way to add it.

### 5. Wire the owner key only when this machine is an owner

```typescript
/** If this node's identity key is a live `OwnerKey` here, wire it for signing (`initializeSeedBootstrap`) and return true; otherwise change nothing and return false. */
wireOwnKeyIfOwner(): Promise<boolean>;
```

For a machine that joined by invitation: after an owner-granting redemption, and on every later start. It never inserts an `OwnerKey` row (unlike `ensureOwnerKey`), so a machine that joined someone else's cadre can never genesis-insert into it. The phone kit's follow-up ticket calls it; the web app's join (`reference-apps-join-existing-cadre`) will too. A redeeming device's seated owner key is always its identity key (the redemption seats the request's `peerKey`), so reading the identity key is correct.

Update the `NOTE:` above the self-anchor in `initializeSeedBootstrap` (cadre-node.ts, "non-founder members that also wire seed-bootstrap…"): joined machines now reach `initializeSeedBootstrap` only through `wireOwnKeyIfOwner`, so a non-owner never self-anchors, and the tripwire it describes (a non-founder exporting its own key through `createCadreInvitation`) is closed for them. Check, and say in the NOTE, whether anything else (the phone kit's `runOwnerGenesis` for founders) still self-anchors a non-owner. The NOTE also says the joiner path needs seed bootstrap "to self-publish its CadrePeer row"; self-publish signs with the identity key (`getSelfSigningKey`), so confirm a non-owner's own peer record still publishes without seed bootstrap and correct the NOTE.

### 6. Integration scenario `app-joins-cadre-by-invitation.integration.ts`

Machines (reuse `controlNodeConfig`, `admitMember`, `startPinningMember`, `captureRawStorage` from the harness):
- **A**: phone-shaped owner (`listenAddrs: []`), founds the cadre.
- **M**: one always-on member, admitted by A (`addDrone` plus seed delivery, as `cadre-invite-any-member` does).
- **B**: phone-shaped, fresh identity, started for A's party with no owner genesis.
- **C**: a second phone-shaped device for the open flow.

Arms, in one `it` to share A and M:
1. **Targeted**: B encodes a join request; A decodes it and mints `{ peerId, grantsOwner: true }`; the mint's `reach` is `local-network` (M on loopback); A stops. M is stopped too (storage kept, restarted on the same listen address). B calls `redeemCadreInvitation(…, { waitForMember: true, onProgress })`; once B has reported at least one `waiting` with `no-member-answered`, M restarts; B is accepted. B's `wireOwnKeyIfOwner()` returns true; B writes an owner-signed `JoinedStrand` row (`getControlDatabase().insertJoinedStrand` signed with B's identity key, as the party ledger in `createPartyJoinedStrandLedger` does) and M comes to hold it.
2. **Open**: B (now an owner) mints an untargeted `grantsOwner: true` invitation; C decodes and redeems it with `waitForMember`; C's `wireOwnKeyIfOwner()` returns true and C's owner-signed write reaches M.

If restarting M on the same address does not fit the harness, keep the waiting arm by another route that still produces a real `no-member-answered` pass (say which in the handoff); do not drop it.

### 7. Docs (`docs/architecture.md`)

In "Enrollment Flow: Invitation Redeemed at Any Member": the prefix and the 6-address cap with the measured sizes; a short "Handing an invitation from app to app" subsection with the two flows above, the join request's shape, `reach`, and `waitForMember`'s pass rules (one signed request, pacing, expiry, abort); `wireOwnKeyIfOwner` beside the existing "A device the invitation makes an owner still has to wire its own key" paragraph (replace its `initializeSeedBootstrap(ownKey)` advice with it). Update the "Simple API" / helper listing if it enumerates the invitation calls.

## Edge cases & interactions

- **Lost reply, then a second pass**: same `usageStampId`, so the second member answers "already a member" with no second usage row. By inspection (the request is signed once, outside the loop); the scenario's restart arm exercises a multi-pass join.
- **Invitation expires while waiting**: the next pass is not attempted; `invite-spent` locally. By inspection.
- **Abort during a pass**: the in-flight dial is cancelled, the call throws the abort reason, nothing retries afterwards. By inspection of the signal threading.
- **Pasted the wrong kind** (request where an invitation goes, or the reverse): refused by name. Unit test (below).
- **A request whose peer id is not Ed25519** (an RSA or secp256k1 peer id): refused at decode; a targeted invitation naming it could never be redeemed. Unit test.
- **A targeted invitation naming a key B does not hold**: the member refuses `invite-invalid` (existing check); never redeemable; it expires. Nothing new.
- **The same invitation pasted twice by the same device**: the member answers idempotently as already a member (existing). Nothing new.
- **`grantsOwner: false`**: `wireOwnKeyIfOwner` returns false and B stays unable to publish strand joins (`JoinedStrand` is owner-signed). The scenario covers only owner grants; by inspection.
- **Minting machine is always-on** (cadre-cli, cadre-host): `reach` still excludes its own addresses, so it can read `issuer-only` although the issuer itself is reachable. Document that `reach` answers "if the minting machine is gone"; the CLI does not show it.
- **No owner in the anchor / no addresses at all**: `createCadreInvitation` already throws; unchanged.
- **Address cap drops a reachable sibling**: with more than one other member, only the first two addresses of each, connected machines first, survive. Accepted for size; record as a `NOTE:` at the cap.

## Tests (the ones that pay)

- `cadre-join-request` codec: one spec — round trip; refusals for no prefix, the invitation prefix, a non-Ed25519 peer id, an over-long `appName`.
- `decodeCadreInvitation`: extend the existing spec with the prefix requirement and the request-pasted-here refusal.
- Size budget: one spec building a bundle at the 6-address cap with 3 owner keys and the realistic address shapes above, asserting the encoded text is at most 2,048 characters (measured 1,972). It catches a new bundle field or a loosened cap silently pushing invitations past what a QR code holds.
- `reach`: one spec over the three outcomes plus "the minting machine's own public address does not count".
- The integration scenario above.

No unit test of the pass loop with a mocked `redeemAtMembers` (a module this repo owns); the scenario covers it.

## TODO

- Add `cadre-join-request.ts` with the codec and export it.
- Prefix `encodeCadreInvitation` / `decodeCadreInvitation`; fix any caller that hand-builds a bundle string.
- Add the cadre-invitation address cap and the per-sibling parameter to `selectInvitationSiblingAddrs`; update the QR `NOTE:`.
- Export a dial-address classifier from `node-claim-payload.ts`; compute `reach` in `createCadreInvitation`; add it to `CreateCadreInvitationResult` in `types.ts`.
- Restructure `redeemCadreInvitation` for `RedeemCadreInvitationOptions` (sign once, passes, pacing, expiry, abort, progress); thread `signal` through `redeemAtMembers`.
- Add `CadreNode.wireOwnKeyIfOwner`; update the `initializeSeedBootstrap` NOTE after checking self-publish.
- Switch the harness's `redeemWithRetry` to `waitForMember` where it is a drop-in; update the CLI's retry NOTE.
- Write the integration scenario; run it plus `cadre-invite-any-member`, `cadre-invite-row-unreplicated`, `enrollment-e2e`, `cadre-host-join-by-invitation`.
- Unit specs listed above; `yarn lint`; typecheck and test cadre-core, cadre-cli, cadre-host, reference-app-rn, reference-app-ns (both apps decode invitations).
- Update `docs/architecture.md` as in section 7.
