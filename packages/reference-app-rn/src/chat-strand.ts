/**
 * chat-strand.ts — Strand lifecycle for the simplified chat sApp.
 *
 * Wraps CadreNode.addStrand() with the chat-simple schema and provides helpers
 * to create or join chat strands — both the existing **open** strand (anyone
 * can participate) and a **closed** strand gated by a member key + an
 * authority-minted invitation (the trust-model demonstration).
 */

import type {
  CadreNode,
  StrandInstance,
  SAppConfig,
  StrandRow,
  OpenInvitation,
  FormStrandResult,
} from '@serfab/cadre-core';
import { generateStrandMemberKey } from '@serfab/cadre-core';
import { toString as uint8ArrayToString, fromString as uint8ArrayFromString } from 'uint8arrays';
import { insertMember, memberDisplayName, type ChatRole } from './chat-operations';

// ── Embedded schema ──────────────────────────────────────────────────────────
// Matches schemas/chat-simple.qsql.  Embedded as a string constant so the RN
// bundler doesn't need filesystem access.
//
// `Member.Role` is an APP-LEVEL role (`owner` | `member`). Sereus's control
// network has no first-class per-strand RBAC primitive — strand membership is
// `MemberPrivateKey`-granular (member vs non-member). The role lives here, in
// the chat schema, and is assigned on create/join. See the README "Trust model"
// section for where this boundary sits.

const CHAT_SCHEMA = `
table Member (
    Id text primary key,
    Name text not null check (length(Name) between 1 and 100),
    Role text not null default 'member' check (Role in ('owner', 'member'))
);

table Message (
    Id text primary key,
    MemberId text not null,
    Content text not null,
    Timestamp datetime not null,
    foreign key (MemberId) references Member(Id)
);
`;

// ── sApp config ──────────────────────────────────────────────────────────────

export const CHAT_SAPP_ID = 'sereus-chat-simple';
const CHAT_SAPP_VERSION = '0.1.0';

/**
 * Demo chat sApp config. NOTE: this config is **unsigned** and its `id` is a
 * human-readable name (`sereus-chat-simple`), not an ed25519 author public key.
 * It therefore only works under a relaxed node policy (`requireSignedSchemas:
 * false` — see {@link startPhoneNode}). Under the default fail-closed policy a
 * strand using this config would be rejected at bring-up.
 */
export function getChatSAppConfig(): SAppConfig {
  return {
    id: CHAT_SAPP_ID,
    version: CHAT_SAPP_VERSION,
    schema: CHAT_SCHEMA,
    latencyHint: 'interactive',
  };
}

// ── Open-strand creation (quick start) ────────────────────────────────────────

/**
 * Create a new **open** chat strand on the given cadre node.
 *
 * Two steps, in order:
 *   1. Publish the `Strand` row to the shared control database so other cadre
 *      members discover it via control-network sync (their node fires
 *      `strand:discovered`). This is an authority-signed insert — the phone must
 *      be an enrolled authority (see `runAuthorityGenesis` in cadre-phone.ts).
 *   2. Start the local strand instance with the chat sApp config.
 *
 * Publishing FIRST means a publish failure (e.g. this node is not an enrolled
 * authority) surfaces as a thrown error and we never start a local-only strand
 * that no peer could ever join — the masked-failure mode this replaces.
 *
 * @param cadreNode  Running CadreNode
 * @param strandId   Unique strand identifier (caller-generated UUID)
 * @returns          The active StrandInstance with its Quereus database
 */
export async function createChatStrand(
  cadreNode: CadreNode,
  strandId: string,
): Promise<StrandInstance> {
  const strandRow: StrandRow = {
    Id: strandId,
    MemberPrivateKey: null,
    Type: 'o', // open — anyone can participate
  };

  await cadreNode.publishStrand(strandId, 'o');

  return cadreNode.addStrand({
    strandRow,
    sAppConfig: getChatSAppConfig(),
  });
}

/**
 * Join an existing chat strand that was advertised via the control network.
 *
 * @param cadreNode  Running CadreNode
 * @param strandRow  Strand row obtained from the control database
 * @returns          The active StrandInstance
 */
export async function joinChatStrand(
  cadreNode: CadreNode,
  strandRow: StrandRow,
): Promise<StrandInstance> {
  return cadreNode.addStrand({
    strandRow,
    sAppConfig: getChatSAppConfig(),
  });
}

// ── Closed-strand creation + join (trust model) ───────────────────────────────

/** Result of creating a closed strand: the live instance + its membership key. */
export interface CreateClosedStrandResult {
  instance: StrandInstance;
  /** Generated ed25519 member private key (base64 protobuf) gating the strand. */
  memberPrivateKey: string;
}

/**
 * Create a new **closed** chat strand (`Type:'c'`) on the given cadre node.
 *
 * Mirrors {@link createChatStrand} but mints a `MemberPrivateKey` so the strand
 * is invitation-only rather than open, publishes the row with `type:'c'` + that
 * key under this node's authority, starts the instance, and assigns the creator
 * the app-level `owner` role.
 *
 * @param cadreNode  Running CadreNode (must be an enrolled authority to publish)
 * @param strandId   Unique strand identifier (caller-generated UUID)
 */
export async function createClosedChatStrand(
  cadreNode: CadreNode,
  strandId: string,
): Promise<CreateClosedStrandResult> {
  const memberPrivateKey = await generateStrandMemberKey();

  const strandRow: StrandRow = {
    Id: strandId,
    MemberPrivateKey: memberPrivateKey,
    Type: 'c', // closed — invitation-only
  };

  await cadreNode.publishStrand(strandId, 'c', memberPrivateKey);

  const instance = await cadreNode.addStrand({
    strandRow,
    sAppConfig: getChatSAppConfig(),
  });

  await assignLocalMemberRole(cadreNode, instance, 'owner');

  return { instance, memberPrivateKey };
}

/**
 * Attach a closed chat strand locally from its id + membership key. The `Strand`
 * row already exists (the host published it; a remote joiner syncs it via the
 * control network), so this only starts the local instance — the join is gated
 * by the chat schema DDL, not an open free-for-all — and assigns the joiner the
 * app-level `member` role.
 *
 * @param cadreNode         Running CadreNode
 * @param strandId          The closed strand's id
 * @param memberPrivateKey  The membership key carried by the invitation
 */
export async function joinClosedChatStrand(
  cadreNode: CadreNode,
  strandId: string,
  memberPrivateKey: string,
): Promise<StrandInstance> {
  const strandRow: StrandRow = {
    Id: strandId,
    MemberPrivateKey: memberPrivateKey,
    Type: 'c',
  };

  const instance = await cadreNode.addStrand({
    strandRow,
    sAppConfig: getChatSAppConfig(),
  });

  await assignLocalMemberRole(cadreNode, instance, 'member');

  return instance;
}

/**
 * Attach the closed strand produced by {@link CadreNode.formStrand}. Thin
 * convenience over {@link joinClosedChatStrand} that reads the strand id +
 * membership key out of a {@link FormStrandResult}.
 */
export async function joinClosedChatStrandFromFormation(
  cadreNode: CadreNode,
  formResult: FormStrandResult,
): Promise<StrandInstance> {
  return joinClosedChatStrand(cadreNode, formResult.strandId, formResult.invitePrivateKey);
}

/**
 * Insert the local node as a chat `Member` with the given role. `insert or
 * ignore` keeps this idempotent and lets an earlier role assignment (e.g.
 * `owner`) win over the default-`member` insert {@link useChat} performs on
 * first attach. Best-effort: a failure is logged, not thrown, so a role hiccup
 * never blocks strand bring-up.
 */
async function assignLocalMemberRole(
  cadreNode: CadreNode,
  instance: StrandInstance,
  role: ChatRole,
): Promise<void> {
  const id = cadreNode.peerId?.toString();
  if (!id) {
    console.warn('[chat-strand] no peerId available; skipping role assignment');
    return;
  }
  try {
    await insertMember(instance, id, memberDisplayName(id), role);
  } catch (err) {
    console.warn(`[chat-strand] failed to assign ${role} role:`, err);
  }
}

// ── Closed-strand invitation envelope ─────────────────────────────────────────

/**
 * Out-of-band envelope a host hands an invitee to join a closed strand.
 *
 * The cadre-core {@link OpenInvitation} carries the formation token, sApp, and
 * the host's bootstrap addrs — but NOT which strand to attach or its membership
 * key, because in the canonical formation protocol the responder discloses the
 * strand only after validating consent. The reference app delivers those out of
 * band alongside the invitation (the same shape the integration harness's
 * `TestOpenInvitation` uses), so the invitee can attach the host's actual
 * closed strand after the consent handshake.
 */
export interface ClosedStrandInvite {
  /** The cadre-core open invitation (formation token + bootstrap + sApp). */
  invitation: OpenInvitation;
  /** The host's closed strand id to attach. */
  strandId: string;
  /** The membership key gating the closed strand. */
  memberPrivateKey: string;
}

/**
 * Encode a {@link ClosedStrandInvite} to a single copyable base64url string for
 * out-of-band delivery (paste, link, or QR). The inner {@link OpenInvitation}
 * is serialized via {@link CadreNode.encodeInvitation}; the envelope wraps that
 * with the strand id + membership key.
 */
export function encodeClosedStrandInvite(cadreNode: CadreNode, invite: ClosedStrandInvite): string {
  const envelope = {
    v: 1,
    inviteCode: cadreNode.encodeInvitation(invite.invitation),
    strandId: invite.strandId,
    memberPrivateKey: invite.memberPrivateKey,
  };
  const json = JSON.stringify(envelope);
  return uint8ArrayToString(new TextEncoder().encode(json), 'base64url');
}

/**
 * Decode a base64url {@link ClosedStrandInvite} produced by
 * {@link encodeClosedStrandInvite}. Throws on a malformed envelope rather than
 * returning a partial object.
 */
export function decodeClosedStrandInvite(cadreNode: CadreNode, encoded: string): ClosedStrandInvite {
  const json = new TextDecoder().decode(uint8ArrayFromString(encoded.trim(), 'base64url'));
  const env = JSON.parse(json) as {
    inviteCode?: string;
    strandId?: string;
    memberPrivateKey?: string;
  };
  if (!env.inviteCode || !env.strandId || !env.memberPrivateKey) {
    throw new Error('Malformed closed-strand invite (missing inviteCode/strandId/memberPrivateKey)');
  }
  return {
    invitation: cadreNode.decodeInvitation(env.inviteCode),
    strandId: env.strandId,
    memberPrivateKey: env.memberPrivateKey,
  };
}
