import type { FormationInviteFacts, FormationTokenRead } from '../src/formation-token.js';

/** An unexpired, unlimited, unbound invite with no approval hook, with `overrides` applied. */
export function inviteFacts(overrides: Partial<FormationInviteFacts> = {}): FormationInviteFacts {
  return { sAppId: 'sapp-test', expiresAtMs: null, totalUses: null, strandId: null, validationUrl: null, ...overrides };
}

/** A fake recorder's `readToken` that answers `invite` for every token, with no uses recorded. */
export function readsAs(
  invite: FormationInviteFacts | null = inviteFacts()
): (token: string) => Promise<FormationTokenRead> {
  return async (token) => ({ token, invite, usesRecorded: invite?.totalUses == null ? null : 0 });
}
