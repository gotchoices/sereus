/**
 * chat-strand.ts — Strand lifecycle for the simplified chat sApp.
 *
 * Wraps CadreNode.addStrand() with the chat-simple schema and provides
 * helpers to create or join a chat strand. Ported verbatim from
 * packages/reference-app-rn/src/chat-strand.ts — pure TS, no platform deps.
 */

import type { CadreNode, StrandInstance, SAppConfig, StrandRow } from '@serfab/cadre-core';

// ── Embedded schema ──────────────────────────────────────────────────────────
// Matches schemas/chat-simple.qsql.  Embedded as a string constant so the
// bundler doesn't need filesystem access.

const CHAT_SCHEMA = `
table Member (
    Id text primary key,
    Name text not null check (length(Name) between 1 and 100)
);

table Message (
    Id integer primary key,
    MemberId text not null,
    Content text not null,
    Timestamp datetime not null,
    foreign key (MemberId) references Member(Id)
);
`;

// ── sApp config ──────────────────────────────────────────────────────────────

const CHAT_SAPP_ID = 'sereus-chat-simple';
const CHAT_SAPP_VERSION = '0.1.0';

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
