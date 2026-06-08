/**
 * chat-strand.ts — chat sApp schema + **signed** SAppConfig for the browser
 * reference.
 *
 * Mirrors `reference-app-rn/src/chat-strand.ts`, but unlike the RN reference
 * (whose `getChatSAppConfig()` omits `signature`) the browser **signs** the
 * schema so it exercises the schema-signature gate. On strand start,
 * `StrandInstanceManager` calls `assertSchemaSignature(sAppConfig)`
 * (`cadre-core/src/strand-instance-manager.ts`), so a tampered schema/version/
 * signature throws `SchemaVerificationError` and the strand never reaches
 * `active`. The valid signed config below starts cleanly.
 *
 * The author keypair is a **bundled demo identity** — a fixed Ed25519 pair, NOT
 * a real sApp-author identity. It exists only so the gate is genuinely run in
 * the browser; a production sApp would ship a real author public key as the
 * `id` and a signature minted by the author's offline private key.
 */

import { signSchema } from '@serfab/cadre-core';
import type { SAppConfig } from '@serfab/cadre-core';

// ── Embedded schema (matches schemas/chat-simple.qsql + the RN reference) ─────

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

const CHAT_VERSION = '0.1.0';

/**
 * Demo sApp author keypair (Ed25519, base64url). **Demo only** — not a real
 * identity. The public key doubles as the SAppConfig `id` and is what
 * `assertSchemaSignature` verifies the signature against.
 */
const CHAT_AUTHOR_PUBLIC_KEY = 'rVo38fLn52w_UyDRjLp5hW8Dg6Rt90fpOX2b6W5KxpU';
const CHAT_AUTHOR_PRIVATE_KEY = 'TUbBDNtNCtDw9uoiEdlyWp7Smj_FGQQIb-ZaFXCulTw';

/**
 * Fixed strand id for the single browser chat strand. A constant (rather than a
 * per-session UUID) keeps the strand's IndexedDB database stable across reloads,
 * so messages persist. Phase 2's formed (closed) strands use a responder-minted
 * UUID instead — see {@link CHAT_SAPP_ID}.
 */
export const CHAT_STRAND_ID = 'sereus-web-chat';

/**
 * The chat sApp's id — the author public key that doubles as the `SAppConfig.id`.
 * Formation (`createOpenInvitation`) names the sApp by this id so a formed strand
 * launches against the *same* signed chat schema as the solo Phase-1 strand.
 */
export const CHAT_SAPP_ID = CHAT_AUTHOR_PUBLIC_KEY;

/**
 * The signed chat sApp config. The signature is computed at runtime via
 * `signSchema` (exercising the crypto path in the browser) and matches
 * `CHAT_AUTHOR_PUBLIC_KEY`, so `assertSchemaSignature` passes.
 */
export function getChatSAppConfig(): SAppConfig {
	return {
		id: CHAT_AUTHOR_PUBLIC_KEY,
		version: CHAT_VERSION,
		schema: CHAT_SCHEMA,
		signature: signSchema(CHAT_SCHEMA, CHAT_VERSION, CHAT_AUTHOR_PRIVATE_KEY),
		latencyHint: 'interactive',
	};
}

/**
 * A deliberately **tampered** chat config: a valid signature over the canonical
 * schema, but the schema body is mutated afterwards so the signature no longer
 * matches. Feeding this to `addStrand` must throw `SchemaVerificationError`.
 * Used by the schema-signature-gate test and surfaced nowhere in the happy path.
 */
export function getTamperedChatSAppConfig(): SAppConfig {
	const valid = getChatSAppConfig();
	return {
		...valid,
		// Append a column the signature never covered → digest mismatch.
		schema: valid.schema + '\ntable Tampered ( Id text primary key );\n',
	};
}
