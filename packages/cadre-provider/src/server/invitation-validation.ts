/**
 * Shape validation for the `join.invitation` of `POST /containers` — the cadre invitation
 * bundle the created node is started with as `CADRE_INVITATION` and redeems at a member of
 * the cadre it names (`cadre start --invitation`).
 *
 * Its own module rather than part of `create-request-validation.ts`: the rule is a
 * restatement of cadre-core's, so it is worth reading, testing and changing on its own.
 * Same arrangement, and same reasons, as `owner-key-validation.ts`.
 *
 * ## The rule
 *
 * A bundle is `sereus-invite:1.` followed by base64url JSON of an object with `v: 1`, a
 * non-empty `partyId`, an `invitePrivateKey` string, an `invite` object, a non-empty
 * `ownerKeys` string array, and a non-empty `members` array of multiaddrs each naming the
 * member it reaches (`/p2p/<peerId>` last, past any relay hop, and decodable). A
 * `sereus-join-request:1.` prefix is refused by name: it is the other half of the
 * invitation flow, what a device sends an owner, and pasting one for the other is the
 * likeliest mistake.
 *
 * **This deliberately restates `isWellFormedCadreInvitation`
 * (`packages/cadre-core/src/cadre-invite-protocol.ts`) rather than importing
 * `decodeCadreInvitation`**, for the reason `owner-key-validation.ts` gives: the provider
 * does not depend on cadre-core. The node does the full decode and refuses anything a member
 * would, so this is the create-time check that lets a typo be answered 400 rather than
 * surfacing as a container that dies at boot. It differs from cadre-core's copy in three
 * places, each on purpose:
 *
 * - **`members` must be non-empty and each must parse as a dialable address.** cadre-core
 *   accepts any bounded strings, an empty list included, because its decoder serves a
 *   settings screen that only shows which cadre a bundle joins. A node with nobody to dial
 *   never redeems, and one with an address that does not parse drops it at dial time with
 *   the failure visible only in the container's log.
 * - **`ownerKeys` and `invitePrivateKey` are checked as strings, not as Ed25519 keys.**
 *   The node decodes them fully; a malformed key fails there with the decoder's reason.
 * - **Error messages never echo the bundle or any part of it.** It carries the invitation's
 *   private key, so unlike a public owner key or a bootstrap address, a rejected value may
 *   still be a secret. `__tests__/create-request-validation.test.ts` pins that.
 */

import debug from 'debug';
import { multiaddr } from '@multiformats/multiaddr';
import { peerIdFromString } from '@libp2p/peer-id';
import { fromString as uint8ArrayFromString } from 'uint8arrays';
import { destinationPeerIdOf } from '../service/multiaddr-destination.js';

const log = debug('cadre:provider:invitation');

/** cadre-core's `CADRE_INVITATION_PREFIX`: version 1 of the bundle, the only one a node reads. */
export const CADRE_INVITATION_PREFIX = 'sereus-invite:1.';

/** cadre-core's `CADRE_JOIN_REQUEST_PREFIX`: the device-to-owner half, refused here by name. */
const CADRE_JOIN_REQUEST_PREFIX = 'sereus-join-request:1.';

/** cadre-core's `MAX_BUNDLE_MEMBERS`; an issuer caps its own list far below this. */
const MAX_BUNDLE_MEMBERS = 64;

/** What a well-formed bundle yields: the text the node is started with, and the cadre it names. */
export interface ValidatedInvitation {
  /** The bundle, trimmed. */
  invitation: string;
  /** The bundle's `partyId`, which becomes the container's party. */
  partyId: string;
}

/** The message of a thrown parse/decode failure, whatever the thrower used. */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The JSON behind the prefix, or undefined when it is not base64url JSON. Logged, never echoed. */
function decodeBundleJson(encoded: string): unknown | undefined {
  try {
    return JSON.parse(new TextDecoder().decode(uint8ArrayFromString(encoded, 'base64url')));
  } catch (error) {
    log('rejecting join.invitation: body does not decode: %s', reasonOf(error));
    return undefined;
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * One `members` entry: a multiaddr whose destination (the last `/p2p/`, past any relay hop)
 * is a decodable peer id. Returns the refusal, or undefined when the entry is usable.
 * Positions, not values, are named: the bundle is not echoed.
 */
function memberRefusal(entry: unknown, index: number): string | undefined {
  if (typeof entry !== 'string') return `join.invitation is malformed: members[${index}] is not a string`;
  let destination: string | null;
  try {
    destination = destinationPeerIdOf(multiaddr(entry.trim()).getComponents());
  } catch (error) {
    log('rejecting join.invitation: members[%d] does not parse: %s', index, reasonOf(error));
    return `join.invitation is malformed: members[${index}] is not a multiaddr`;
  }
  if (destination === null) return `join.invitation is malformed: members[${index}] names no peer (no /p2p/<peerId> past the relay hop)`;
  try {
    peerIdFromString(destination);
  } catch (error) {
    log('rejecting join.invitation: members[%d] names a peer id that does not decode: %s', index, reasonOf(error));
    return `join.invitation is malformed: members[${index}] names a peer id that does not decode`;
  }
  return undefined;
}

/** The shape rule over a decoded bundle: the refusal, or undefined when it is well formed. */
function bundleRefusal(parsed: unknown): string | undefined {
  if (!isPlainObject(parsed)) return 'join.invitation is malformed: it does not decode to a JSON object';
  const { v, partyId, invitePrivateKey, invite, ownerKeys, members } = parsed;
  if (v !== 1) return 'join.invitation is of an unsupported version (only v1 is read)';
  if (!isNonEmptyString(partyId)) return 'join.invitation is malformed: it names no partyId';
  if (!isNonEmptyString(invitePrivateKey)) return 'join.invitation is malformed: it carries no invitePrivateKey';
  if (!isPlainObject(invite)) return 'join.invitation is malformed: it carries no invite row';
  if (!Array.isArray(ownerKeys) || ownerKeys.length === 0 || !ownerKeys.every(isNonEmptyString)) {
    return 'join.invitation is malformed: ownerKeys must be a non-empty array of strings';
  }
  if (!Array.isArray(members) || members.length === 0) {
    return 'join.invitation names no member to dial: a node redeems an invitation at a member of the cadre, so the bundle must list at least one address';
  }
  if (members.length > MAX_BUNDLE_MEMBERS) return `join.invitation is malformed: more than ${MAX_BUNDLE_MEMBERS} members`;
  for (const [index, entry] of members.entries()) {
    const refusal = memberRefusal(entry, index);
    if (refusal) return refusal;
  }
  return undefined;
}

/**
 * Validate the `join.invitation` of a create request against the rule above.
 *
 * Create is the last point at which the caller can still fix the bundle: `cadre start`
 * refuses one that does not decode, so without this check a bad bundle is answered 201 and
 * then produces a container that dies at boot, which the caller learns about, if ever, from
 * container status.
 *
 * @returns the trimmed bundle and the party it names, or the message to answer
 *   `INVALID_REQUEST` with. The message never contains the bundle.
 */
export function validateInvitation(value: unknown): ValidatedInvitation | { error: string } {
  if (typeof value !== 'string') return { error: 'join.invitation must be a string' };
  const trimmed = value.trim();
  if (trimmed.startsWith(CADRE_JOIN_REQUEST_PREFIX)) {
    return { error: 'join.invitation is a join request, not an invitation: a join request is what a device sends the cadre owner, and the owner answers it with the invitation to pass here' };
  }
  if (!trimmed.startsWith(CADRE_INVITATION_PREFIX)) {
    return { error: `join.invitation must start with "${CADRE_INVITATION_PREFIX}"` };
  }
  const parsed = decodeBundleJson(trimmed.slice(CADRE_INVITATION_PREFIX.length));
  if (parsed === undefined) return { error: 'join.invitation must carry base64url-encoded JSON after its prefix' };
  const refusal = bundleRefusal(parsed);
  if (refusal) return { error: refusal };
  return { invitation: trimmed, partyId: ((parsed as Record<string, unknown>).partyId as string).trim() };
}
