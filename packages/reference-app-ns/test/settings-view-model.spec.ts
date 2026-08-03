/**
 * `app/settings/settings-view-model.ts` — the Settings screen's own view model.
 *
 * Driven against the REAL `CadreViewModel` (only the node beneath it is faked),
 * so these tests cover the whole paste-to-pin path the user actually walks:
 * trim the two text fields → decode the invite → anchor its owner keys → apply
 * the seed → report what was pinned. The seam that motivates the suite is what
 * happens to the two input fields and the modal copy on each outcome:
 *
 *  - success clears BOTH fields;
 *  - any failure clears NEITHER — a mistyped seed must not cost the user the
 *    invite they pasted next to it;
 *  - the "applied" message must never claim a pin that did not happen.
 *
 * See `test/stubs/fake-cadre-node.ts` for the fake node and why it is reached
 * through a hoisted dynamic import.
 */
import { describe, it, expect, vi } from 'vitest';
// Side-effect import, load-bearing for timing — see `cadre-vm.spec.ts`'s header.
import '@serfab/cadre-core';
import type { SettingsViewModel } from '../app/settings/settings-view-model';

const stubs = vi.hoisted(async () => import('./stubs/fake-cadre-node'));

vi.mock('../src/cadre-phone', async () => (await stubs).phoneNodeMock());
vi.mock('../src/chat-strand', async () => (await stubs).chatStrandMock());

type Stubs = typeof import('./stubs/fake-cadre-node');

const SEED = 'encoded-seed';
const INVITE = 'encoded-invite';

/**
 * A Settings view model whose shared `CadreViewModel` has adopted the fake node.
 * The module reset matters twice over: `getCadreVm()` caches a module-level
 * singleton, and the Settings constructor grabs it — without the reset, the
 * previous test's cadre view model (and its node) would be handed straight back.
 */
async function loadSettings(): Promise<{ vm: SettingsViewModel; H: Stubs }> {
	return loadWith({ nodeRunning: true });
}

/**
 * The same, minus the running node — the state the app is in before the user has
 * ever pressed Connect, and the only one in which `onConnect` does any work.
 */
async function loadColdSettings(): Promise<{ vm: SettingsViewModel; H: Stubs }> {
	return loadWith({ nodeRunning: false });
}

async function loadWith({ nodeRunning }: { nodeRunning: boolean }): Promise<{ vm: SettingsViewModel; H: Stubs }> {
	const H = await stubs;
	H.reset();
	if (nodeRunning) H.presentRunningNode();
	vi.resetModules();
	const { SettingsViewModel } = await import('../app/settings/settings-view-model');
	const vm = new SettingsViewModel();
	H.clearCalls();
	return { vm, H };
}

/** An invite carrying the two owner keys — the enrollment case. */
async function withInvite(): Promise<{ vm: SettingsViewModel; H: Stubs }> {
	const loaded = await loadSettings();
	loaded.H.state.node.invite = {
		partyId: 'party-x',
		ownerAddrs: [],
		createdAt: 0,
		ownerKeys: [loaded.H.KEY_A, loaded.H.KEY_B],
	};
	return loaded;
}

// ── The happy path ────────────────────────────────────────────────────────────

describe('onApplySeed with an enrollment invite', () => {
	it('anchors the invite keys before applying the seed', async () => {
		// The end-to-end version of `cadre-vm.spec.ts`'s ordering test: from the two
		// text fields the user pastes into, through to the node calls in order.
		const { vm, H } = await withInvite();
		vm.seedInput = SEED;
		vm.enrollInviteInput = INVITE;

		await vm.onApplySeed();

		expect(H.calls).toEqual(['decodeInvite', 'decodeSeed', 'trustOwnerKeys', 'applySeed']);
		expect(H.state.node.trusted).toEqual([{ keys: [H.KEY_A, H.KEY_B], source: 'invite' }]);
	});

	it('clears both fields on success', async () => {
		const { vm } = await withInvite();
		vm.seedInput = SEED;
		vm.enrollInviteInput = INVITE;

		await vm.onApplySeed();

		expect(vm.seedInput).toBe('');
		expect(vm.enrollInviteInput).toBe('');
	});

	it('reports how many owner keys were pinned', async () => {
		const { vm } = await withInvite();
		vm.seedInput = SEED;
		vm.enrollInviteInput = INVITE;

		await vm.onApplySeed();

		expect(vm.modalTitle).toBe('Seed applied');
		expect(vm.modalMessage).toContain('2 owner key');
		expect(vm.modalVisibility).toBe('visible');
	});

	it('trims surrounding whitespace off both fields before either reaches the node', async () => {
		// Pasting from a clipboard commonly drags a newline along; an untrimmed seed
		// fails base64url decoding with a message that names neither field.
		const { vm, H } = await withInvite();
		vm.seedInput = `  ${SEED}\n`;
		vm.enrollInviteInput = `\t${INVITE}  `;

		await vm.onApplySeed();

		expect(H.state.node.decodedSeeds).toEqual([SEED]);
		expect(H.state.node.decodedInvites).toEqual([INVITE]);
	});
});

describe('onApplySeed without an enrollment invite', () => {
	it('never decodes an invite and says no owner keys were pinned', async () => {
		const { vm, H } = await loadSettings();
		vm.seedInput = SEED;

		await vm.onApplySeed();

		expect(H.calls).toEqual(['decodeSeed', 'applySeed']);
		expect(vm.modalTitle).toBe('Seed applied');
		expect(vm.modalMessage).toContain('no owner keys pinned');
	});

	it('says no owner keys were pinned when the invite carried none', async () => {
		// An older invite decodes fine but yields `[]`. The message must not claim a
		// pin that did not happen — "Pinned 0 owner key(s)" would read as success.
		const { vm, H } = await loadSettings();
		vm.seedInput = SEED;
		vm.enrollInviteInput = INVITE;

		await vm.onApplySeed();

		expect(H.state.node.trusted).toEqual([]);
		expect(vm.modalMessage).toContain('no owner keys pinned');
		expect(vm.modalMessage).not.toContain('Pinned');
	});
});

// ── Failure: the fields must survive ──────────────────────────────────────────

describe('onApplySeed when the node refuses the seed', () => {
	it('keeps both fields so the user can retry without re-pasting', async () => {
		const { vm, H } = await withInvite();
		H.state.node.applySeedResult = H.refusal('not for this party');
		vm.seedInput = SEED;
		vm.enrollInviteInput = INVITE;

		await vm.onApplySeed();

		expect(vm.seedInput).toBe(SEED);
		expect(vm.enrollInviteInput).toBe(INVITE);
	});

	it('raises the failure modal with the node text', async () => {
		const { vm, H } = await withInvite();
		H.state.node.applySeedResult = H.refusal('not for this party');
		vm.seedInput = SEED;
		vm.enrollInviteInput = INVITE;

		await vm.onApplySeed();

		expect(vm.modalTitle).toBe('Seed failed');
		expect(vm.modalMessage).toContain('not for this party');
		expect(vm.modalVisibility).toBe('visible');
	});
});

describe('onApplySeed when the invite cannot be read', () => {
	it('keeps both fields and never reaches the seed', async () => {
		// The second, separate failure source: this one throws before `applySeed` is
		// called at all, so a "clear on success" that lived in the wrong place would
		// pass the node-refusal tests above and still fail here.
		const { vm, H } = await loadSettings();
		H.state.node.decodeInviteError = new SyntaxError('Unexpected token < in JSON at position 0');
		vm.seedInput = SEED;
		vm.enrollInviteInput = 'not-an-invite';

		await vm.onApplySeed();

		expect(vm.seedInput).toBe(SEED);
		expect(vm.enrollInviteInput).toBe('not-an-invite');
		expect(H.calls).toEqual(['decodeInvite']);
	});

	it('raises the failure modal naming the enrollment invite', async () => {
		// Matched on a distinctive substring — this is UI copy, and a wording tweak
		// should not fail the suite.
		const { vm, H } = await loadSettings();
		H.state.node.decodeInviteError = new SyntaxError('Unexpected token < in JSON at position 0');
		vm.seedInput = SEED;
		vm.enrollInviteInput = 'not-an-invite';

		await vm.onApplySeed();

		expect(vm.modalTitle).toBe('Seed failed');
		expect(vm.modalMessage).toMatch(/enrollment invite/i);
	});
});

describe('onApplySeed when the seed cannot be read', () => {
	it('keeps both fields and names the seed, not the invite', async () => {
		// The third failure source. It happens INSIDE `applySeed`, after the invite
		// already decoded, so a reader of the modal must still be told which of the
		// two pasted fields was the bad one.
		const { vm, H } = await withInvite();
		H.state.node.decodeSeedError = new SyntaxError('Unexpected token < in JSON at position 0');
		vm.seedInput = 'not-a-seed';
		vm.enrollInviteInput = INVITE;

		await vm.onApplySeed();

		expect(vm.modalTitle).toBe('Seed failed');
		expect(vm.modalMessage).toMatch(/cold-start seed/i);
		expect(vm.modalMessage).not.toMatch(/SyntaxError/);
		expect(vm.seedInput).toBe('not-a-seed');
		expect(vm.enrollInviteInput).toBe(INVITE);
	});
});

// ── The blank-seed guard ──────────────────────────────────────────────────────

describe('onApplySeed with no usable seed', () => {
	it('does nothing at all when the seed field is empty', async () => {
		const { vm, H } = await loadSettings();

		await vm.onApplySeed();

		expect(H.calls).toEqual([]);
		expect(vm.modalVisibility).toBe('collapse');
	});

	it('does nothing when the seed field holds only whitespace, invite or not', async () => {
		// `canApplySeed` disables the button on the same rule, but the handler must
		// hold the line on its own — the two-way binding can be updated by code.
		const { vm, H } = await loadSettings();
		vm.seedInput = '   \n';
		vm.enrollInviteInput = INVITE;

		expect(vm.canApplySeed).toBe(false);
		await vm.onApplySeed();

		expect(H.calls).toEqual([]);
		expect(vm.modalVisibility).toBe('collapse');
		expect(vm.enrollInviteInput).toBe(INVITE);
	});
});

// ── The rest of the screen ────────────────────────────────────────────────────

describe('onConnect', () => {
	it('mints a party id when the field is blank and shows it back to the user', async () => {
		// The demo's join-nothing path: no pasted party, so one is generated and
		// written back into the bound field — otherwise the user could not tell the
		// second phone which party to join.
		const { vm, H } = await loadColdSettings();

		await vm.onConnect();

		expect(vm.partyId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		expect(H.state.startOpts).toEqual([{ partyId: vm.partyId, bootstrapAddrs: [] }]);
		expect(vm.cadre.connected).toBe(true);
	});

	it('passes the pasted party id and bootstrap address through, trimmed', async () => {
		const { vm, H } = await loadColdSettings();
		vm.partyId = '  party-x  ';
		vm.bootstrapAddr = ' /ip4/1.2.3.4/tcp/4001/ws \n';

		await vm.onConnect();

		expect(H.state.startOpts).toEqual([{ partyId: 'party-x', bootstrapAddrs: ['/ip4/1.2.3.4/tcp/4001/ws'] }]);
	});

	it('raises the failure modal when the node will not start', async () => {
		// `CadreViewModel.start` reports through `status`/`error` rather than
		// throwing, so this screen has to read them back — a `try/catch` here would
		// silently never fire.
		const { vm, H } = await loadColdSettings();
		H.state.startError = new Error('control network unreachable');

		await vm.onConnect();

		expect(vm.modalTitle).toBe('Connection failed');
		expect(vm.modalMessage).toBe('control network unreachable');
		expect(vm.modalVisibility).toBe('visible');
	});
});

describe('onDisconnect', () => {
	it('stops the node and leaves nothing bound to it', async () => {
		const { vm, H } = await loadSettings();

		await vm.onDisconnect();

		expect(H.calls).toContain('stopPhoneNode');
		expect(H.state.node.boundHandlerCount()).toBe(0);
		expect(vm.cadre.status).toBe('idle');
		expect(vm.modalVisibility).toBe('collapse');
	});
});

describe('onDialPeer', () => {
	it('dials the trimmed address and clears the field on success', async () => {
		const { vm, H } = await loadSettings();
		vm.peerAddr = '  /ip4/1.2.3.4/tcp/4001/ws  ';

		expect(vm.canDialPeer).toBe(true);
		await vm.onDialPeer();

		expect(H.calls).toEqual(['dialPeer:/ip4/1.2.3.4/tcp/4001/ws']);
		expect(vm.peerAddr).toBe('');
		expect(vm.modalTitle).toBe('Peer connected');
	});

	it('keeps the address when the dial fails, so it can be retried', async () => {
		const { vm, H } = await loadSettings();
		H.state.dialError = new Error('dial refused');
		vm.peerAddr = '/ip4/1.2.3.4/tcp/4001/ws';

		await vm.onDialPeer();

		expect(vm.peerAddr).toBe('/ip4/1.2.3.4/tcp/4001/ws');
		expect(vm.modalTitle).toBe('Dial failed');
		expect(vm.modalMessage).toContain('dial refused');
	});

	it('does nothing on a blank address', async () => {
		const { vm, H } = await loadSettings();
		vm.peerAddr = '   ';

		expect(vm.canDialPeer).toBe(false);
		await vm.onDialPeer();

		expect(H.calls).toEqual([]);
		expect(vm.modalVisibility).toBe('collapse');
	});
});

describe('onCreateStrand', () => {
	it('creates a strand under a fresh id and reports it shortened', async () => {
		const { vm, H } = await loadSettings();

		await vm.onCreateStrand();

		expect(H.calls).toEqual(['createChatStrand', 'getStrands']);
		expect(vm.cadre.strandCount).toBe(1);
		const [id] = [...H.state.node.strands.keys()];
		expect(vm.modalTitle).toBe('Strand created');
		expect(vm.modalMessage).toBe(`ID: ${id!.slice(0, 8)}…`);
	});

	it('raises the failure modal when the strand cannot be created', async () => {
		const { vm, H } = await loadSettings();
		H.state.createStrandError = new Error('no runtime available');

		await vm.onCreateStrand();

		expect(vm.modalTitle).toBe('Strand creation failed');
		expect(vm.modalMessage).toContain('no runtime available');
		expect(vm.cadre.strandCount).toBe(0);
	});
});

describe('onModalOk', () => {
	it('dismisses the modal but leaves its text alone', async () => {
		// Only visibility is bound to the dismiss — the title/message properties are
		// overwritten by the next `showAlert`, so clearing them here would only add
		// a second notification per dismissal.
		const { vm } = await loadSettings();
		vm.seedInput = SEED;
		await vm.onApplySeed();

		vm.onModalOk();

		expect(vm.modalVisibility).toBe('collapse');
		expect(vm.modalTitle).toBe('Seed applied');
	});
});
