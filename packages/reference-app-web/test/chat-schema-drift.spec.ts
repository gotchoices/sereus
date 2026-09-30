import { describeChatSchemaCopy } from '../../../test-harness/chat-simple-schema.js';
import { CHAT_SCHEMA } from '../src/lib/chat-strand';

/**
 * The schema this app launches its chat strands with is a hand-kept copy of
 * `schemas/chat-simple.qsql`, as are the other reference apps' constants. A copy that
 * falls behind gives that app a different schema from the one the others run.
 */
describeChatSchemaCopy('CHAT_SCHEMA in packages/reference-app-web/src/lib/chat-strand.ts', () => CHAT_SCHEMA);
