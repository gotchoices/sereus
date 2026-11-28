/**
 * One node code waiting to be reviewed. A code can arrive at any moment: a link opened while the
 * app starts, a scan, a paste, while another claim is still running. The app hands each arrival to
 * `offer`; the cadre screen takes it when it can show the approval prompt. One slot, the latest
 * arrival wins: a person acts on the code they just opened. Listening for the links themselves is
 * the platform's (on React Native, the app's linking handler); this only holds what arrived.
 */
import { nodeCodeFromUrl } from './node-code-text.js';
import { writable, type Readable } from './store.js';

export interface NodeCodeInbox {
	/** The code waiting, or null; subscribe to show the prompt when one arrives. Never log its value. */
	pending: Readable<string | null>;
	/** A link or text that may hold a node code: kept (replacing any waiting one) if it does. Returns whether it did. */
	offer(textOrUrl: string | null | undefined): boolean;
	/** The waiting code, removed; null when none. */
	take(): string | null;
}

export function nodeCodeInbox(): NodeCodeInbox {
	const pending = writable<string | null>(null);
	return {
		pending,
		offer(textOrUrl) {
			const code = nodeCodeFromUrl(textOrUrl);
			if (!code) return false;
			pending.set(code);
			return true;
		},
		take() {
			const code = pending.get();
			pending.set(null);
			return code;
		},
	};
}
