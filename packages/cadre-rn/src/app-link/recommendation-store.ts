/**
 * `AppRecommendationStore`: the owner app's record that the user allowed another Sereus app to
 * join before that app asked. When the recommended app's join request opened as a link arrives
 * with that app's scheme as its `reply.scheme`, the owner app takes the pre-approval and answers
 * with a targeted invitation without asking again (docs/architecture.md → "Recommending another
 * app").
 *
 * A pre-approval is the security contract: it is used up by the one answer it allows, lasts
 * {@link RECOMMENDATION_TTL_MS}, and is never returned for a party other than the one the user
 * was in when they allowed it.
 */
import type { DurableSlot } from '@serfab/cadre-core';

/** How long a pre-approval waits for the recommended app's request: enough to install it from the store and open it. */
export const RECOMMENDATION_TTL_MS = 60 * 60_000;

/** The user allowed the app at `scheme` to join `partyId` before it asked. */
export interface AppRecommendation {
	/** The recommended app's own URL scheme: what its request's `reply.scheme` must be. */
	scheme: string;
	/** The name the owner app showed the user, from its known-apps list, never from a request. */
	appName: string;
	/** The party the owner app was in when the user allowed it. */
	partyId: string;
	grantsOwner: boolean;
	approvedAtMs: number;
}

/**
 * Create one per app, over `PhoneNode.recommendationSlot()`: its calls run one at a time, so two
 * deliveries of the same request (the launch URL and a `url` event) cannot both take the
 * pre-approval.
 */
export class AppRecommendationStore {
	private turn: Promise<unknown> = Promise.resolve();

	constructor(
		private readonly slot: DurableSlot,
		private readonly now: () => number = Date.now,
	) {}

	/** Record a pre-approval, replacing any for the same scheme. */
	approve(entry: Omit<AppRecommendation, 'approvedAtMs'>): Promise<AppRecommendation> {
		return this.inTurn(async () => {
			const approved: AppRecommendation = { ...entry, approvedAtMs: this.now() };
			const others = (await this.readLive(entry.partyId)).filter((live) => live.scheme !== entry.scheme);
			await this.write([approved, ...others]);
			return approved;
		});
	}

	/** The live pre-approvals for `partyId`, most recently approved first, for the owner app's list. A slot read that fails throws. */
	live(partyId: string): Promise<AppRecommendation[]> {
		return this.inTurn(() => this.readLive(partyId));
	}

	/** Drop the pre-approval for `scheme`, if any. */
	withdraw(scheme: string): Promise<void> {
		return this.inTurn(async () => {
			// Other parties' entries stay: withdraw names no party, and they are never returned for this one.
			await this.write((await this.readUnexpired()).filter((entry) => entry.scheme !== scheme));
		});
	}

	/**
	 * The live pre-approval for `scheme` in `partyId`, removed as it is returned; null when there is
	 * none. Removed even when the caller then fails to mint, so it allows one answer at most.
	 */
	take(scheme: string, partyId: string): Promise<AppRecommendation | null> {
		return this.inTurn(async () => {
			const live = await this.readLive(partyId);
			const taken = live.find((entry) => entry.scheme === scheme);
			if (!taken) return null;
			await this.write(live.filter((entry) => entry !== taken));
			return taken;
		});
	}

	private inTurn<T>(op: () => Promise<T>): Promise<T> {
		const result = this.turn.then(op);
		this.turn = result.catch(() => undefined);
		return result;
	}

	/** The unexpired entries for `partyId`: what every write keeps, so expired and other parties' entries are pruned by it. */
	private async readLive(partyId: string): Promise<AppRecommendation[]> {
		return (await this.readUnexpired()).filter((entry) => entry.partyId === partyId);
	}

	private async readUnexpired(): Promise<AppRecommendation[]> {
		const text = await this.slot.load();
		if (text === undefined) return [];
		const now = this.now();
		return parseRecommendations(text).filter((entry) => now - entry.approvedAtMs <= RECOMMENDATION_TTL_MS);
	}

	private write(entries: readonly AppRecommendation[]): Promise<void> {
		return this.slot.save(JSON.stringify(entries));
	}
}

/** The saved list, or an empty one, logged, when it is not one: a record that cannot be read allows nothing. */
function parseRecommendations(text: string): AppRecommendation[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (err) {
		console.warn('[cadre-rn/app-link] the app recommendation record is not JSON; reading it as none:', err);
		return [];
	}
	const entries = Array.isArray(parsed) ? parsed.map(parseRecommendation) : null;
	if (!entries?.every((entry): entry is AppRecommendation => entry !== null)) {
		console.warn('[cadre-rn/app-link] the app recommendation record has the wrong shape; reading it as none:', text);
		return [];
	}
	return entries;
}

function parseRecommendation(value: unknown): AppRecommendation | null {
	const { scheme, appName, partyId, grantsOwner, approvedAtMs } = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
	if (typeof scheme !== 'string' || typeof appName !== 'string' || typeof partyId !== 'string'
		|| typeof grantsOwner !== 'boolean' || typeof approvedAtMs !== 'number' || !Number.isFinite(approvedAtMs)) {
		return null;
	}
	return { scheme, appName, partyId, grantsOwner, approvedAtMs };
}
