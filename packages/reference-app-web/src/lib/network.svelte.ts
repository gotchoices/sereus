/**
 * network.svelte.ts — strand-formation panel state (Phase 2).
 *
 * Phase 1's placeholder "paste a control-network seed" box is gone. This store
 * now drives the **consent/invitation strand-formation** flow surfaced on Home:
 *   - responder side: mint + encode an `OpenInvitation` to copy out-of-band, and
 *   - initiator side: paste an encoded invitation, run `formStrand`, and launch
 *     the resulting closed strand.
 *
 * The heavy lifting lives in `cadre-web.ts`; this module owns only the reactive
 * UI state (busy flags, the encoded invitation, the join result, and errors).
 */

import {
	createInvitation,
	joinViaInvitation,
	type CreatedInvitation,
	type FormedStrand,
} from './cadre-web.js';
import { pushError } from './diagnostics.svelte.js';

interface FormationUiState {
	// Responder — create invitation.
	createBusy: boolean;
	invitation: CreatedInvitation | null;
	createError: string | null;
	// Initiator — join via invitation.
	joinInput: string;
	joinBusy: boolean;
	joined: FormedStrand | null;
	joinError: string | null;
}

const state = $state<FormationUiState>({
	createBusy: false,
	invitation: null,
	createError: null,
	joinInput: '',
	joinBusy: false,
	joined: null,
	joinError: null,
});

export function formationState(): FormationUiState {
	return state;
}

export function setJoinInput(value: string): void {
	state.joinInput = value;
}

function message(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Responder: mint + encode a fresh open invitation for the chat sApp. */
export async function doCreateInvitation(): Promise<void> {
	if (state.createBusy) return;
	state.createBusy = true;
	state.createError = null;
	try {
		state.invitation = await createInvitation();
	} catch (err) {
		state.createError = message(err);
		pushError('createInvitation', err);
	} finally {
		state.createBusy = false;
	}
}

/** Initiator: run formation against a pasted encoded invitation. */
export async function doJoinViaInvitation(): Promise<void> {
	if (state.joinBusy) return;
	const encoded = state.joinInput.trim();
	if (encoded.length === 0) {
		state.joinError = 'Paste an encoded invitation first.';
		return;
	}
	state.joinBusy = true;
	state.joinError = null;
	try {
		state.joined = await joinViaInvitation(encoded);
	} catch (err) {
		state.joinError = message(err);
		pushError('joinViaInvitation', err);
	} finally {
		state.joinBusy = false;
	}
}
