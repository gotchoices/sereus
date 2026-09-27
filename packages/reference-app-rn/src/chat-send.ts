/**
 * chat-send.ts — the chat composer's send rule.
 *
 * A strand write can fail with an outcome nobody can settle: cadre-core's
 * `reportsPossiblyStoredWrite` (`packages/cadre-core/src/control-write-retry.ts`) names the
 * class — a non-final Optimystic `TornActionError`, a `SyncRetryExhaustedError`, a partial
 * commit — and refuses to re-run such a write precisely because "a re-run could store the
 * write twice". Strand writes pass through no such funnel: the app calls `exec` on a raw
 * Quereus `Database`. So the composer is where idempotence has to live, and it lives here:
 * the message id belongs to the DRAFT, not to the attempt, so two attempts at one composed
 * message carry one primary key and the key itself refuses the duplicate.
 *
 * A plain module rather than part of `use-chat.ts` or the chat screen, so the rule is
 * reachable from the `node` vitest project without React or react-native in the graph.
 */

import type { StrandInstance } from '@serfab/cadre-core';
import {
  insertMessage,
  messageExists,
  newChatMessageId,
  type ChatMessage,
} from './chat-operations';

/** A draft the user has submitted at least once, and the message id minted for it. */
export interface PendingDraft {
  id: string;
  text: string;
}

export interface SendResult {
  /** The row this attempt stored, or null when an earlier attempt had already stored it. */
  message: ChatMessage | null;
  /** True when the pre-write read found the message already stored, so nothing was written. */
  alreadyStored: boolean;
}

/**
 * Holds the id minted for the draft currently in the composer, so a resend after a failed
 * send re-presents the same primary key instead of minting a second one.
 *
 * One instance per composer. `send` clears the pending draft when it resolves and keeps it
 * when it rejects, which is what makes the next press of Send a resend rather than a new
 * message.
 */
export class ChatSender {
  private pending: PendingDraft | null = null;

  /**
   * Store `text` as a message from `participantId`, resolving when it is stored — whether
   * this attempt stored it or an earlier one had.
   *
   * The text match is load-bearing, not an optimisation. If the user edits the text after a
   * failed send and the first attempt HAD landed, reusing its id would report the edit as
   * sent while the stored row kept the old text. Edited text is a different message, and the
   * earlier attempt landing under its own id is the correct outcome — the user did submit
   * that text.
   */
  async send(strand: StrandInstance, participantId: string, text: string): Promise<SendResult> {
    const resend = this.pending?.text === text ? this.pending : null;
    const draft = resend ?? { id: newChatMessageId(), text };
    this.pending = draft;

    // On a resend, read before writing: the earlier attempt may have landed despite reporting
    // failure, and re-inserting a stored key raises rather than reporting success.
    // NOTE: an attempt that lands in the window between this read and the insert below still
    // raises a unique violation, so the user sees an error for a message that IS stored. The
    // next press of Send reads the row and reports success, so the app self-corrects in one
    // more tap and still cannot store a duplicate. Not worth retry machinery in a reference app.
    if (resend && (await messageExists(strand, draft.id))) {
      this.pending = null;
      return { message: null, alreadyStored: true };
    }

    const message = await insertMessage(strand, draft.id, participantId, text);
    this.pending = null;
    return { message, alreadyStored: false };
  }
}
