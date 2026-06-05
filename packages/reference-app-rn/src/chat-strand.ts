/**
 * chat-strand.ts — Strand lifecycle for the simplified chat sApp.
 *
 * Wraps CadreNode.addStrand() with the chat-simple schema and provides
 * helpers to create or join a chat strand.
 */

import type { CadreNode, StrandInstance, SAppConfig, StrandRow } from '@serfab/cadre-core';

// ── Embedded schema ──────────────────────────────────────────────────────────
// Matches schemas/chat-simple.qsql.  Embedded as a string constant so the RN
// bundler doesn't need filesystem access.

const CHAT_SCHEMA = `
table Member (
    Id text primary key,
    Name text not null check (length(Name) between 1 and 100)
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

const CHAT_SAPP_ID = 'sereus-chat-simple';
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

// ── Strand creation ──────────────────────────────────────────────────────────

/**
 * Create a new chat strand on the given cadre node.
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

