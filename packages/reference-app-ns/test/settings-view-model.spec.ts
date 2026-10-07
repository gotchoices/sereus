/**
 * `app/settings/settings-view-model.ts` — the Settings screen's own view model.
 *
 * Driven against the REAL `CadreViewModel` (only the node beneath it is faked),
 * so these tests cover the paths the user actually walks from a text field to
 * the node and back to the modal: trim the field → decode → hand the node the
 * result → report. The seam that motivates the suite is what happens to each
 * input field and the modal copy on each outcome:
 *
 *  - success clears the field;
 *  - any failure keeps it — a mistyped paste must not cost the user a re-paste;
 *  - a blank field makes no node call at all, whatever the button's state.
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

// ── Join a cadre ──────────────────────────────────────────────────────────────

describe('onJoinCadre', () => {
	it('redeems the trimmed paste, clears the field and names the member that admitted the phone', async () => {
		// Pasting from a clipboard commonly drags a newline along, and base64url
		// decoding is what would fail on it.
		const { vm, H } = await loadSettings();
		vm.cadreInvitationInput = `  ${H.ENCODED_INVITATION}\n`;

		expect(vm.canJoinCadre).toBe(true);
		await vm.onJoinCadre();

		expect(H.calls).toEqual(['redeemCadreInvitation']);
		expect(vm.cadreInvitationInput).toBe('');
		expect(vm.modalTitle).toBe('Joined cadre');
		expect(vm.modalMessage).toContain(H.state.node.redeemResult.peerId);
		expect(vm.modalVisibility).toBe('visible');
	});

	it('shows a refusal in plain words and keeps the paste for a retry', async () => {
		// The member's code is mapped (`src/join-failure.ts`), not echoed: the modal
		// must not read `Cadre invitation refused: …` with the wire text behind it.
		const { vm, H } = await loadSettings();
		// Imported AFTER `loadSettings` reset the module registry, so this is the same
		// class `join-failure.ts` checks `instanceof` against; a file-level import
		// would be the previous registry's copy, and the mapping would never match.
		const { CadreInviteRejectedError } = await import('@serfab/cadre-core');
		H.state.node.redeemError = new CadreInviteRejectedError('invite-spent', 'expired 2026-10-06T00:00:00Z');
		vm.cadreInvitationInput = H.ENCODED_INVITATION;

		await vm.onJoinCadre();

		expect(vm.modalTitle).toBe('Join failed');
		expect(vm.modalMessage).toBe('This invitation is expired, withdrawn or used up');
		expect(vm.cadreInvitationInput).toBe(H.ENCODED_INVITATION);
	});

	it('does nothing when the field holds only whitespace', async () => {
		// `canJoinCadre` disables the button on the same rule, but the handler must
		// hold the line on its own — the two-way binding can be updated by code.
		const { vm, H } = await loadSettings();
		vm.cadreInvitationInput = '   \n';

		expect(vm.canJoinCadre).toBe(false);
		await vm.onJoinCadre();

		expect(H.calls).toEqual([]);
		expect(vm.modalVisibility).toBe('collapse');
	});
});

// ── Apply a seed ──────────────────────────────────────────────────────────────

describe('onApplySeed', () => {
	it('decodes and applies the trimmed seed, then clears the field', async () => {
		const { vm, H } = await loadSettings();
		vm.seedInput = `  ${SEED}\n`;

		await vm.onApplySeed();

		expect(H.calls).toEqual(['decodeSeed', 'applySeed']);
		expect(H.state.node.decodedSeeds).toEqual([SEED]);
		expect(vm.seedInput).toBe('');
		expect(vm.modalTitle).toBe('Seed applied');
		expect(vm.modalVisibility).toBe('visible');
	});
});

describe('onApplySeed when the node refuses the seed', () => {
	it('keeps the field and raises the failure modal with the node text', async () => {
		const { vm, H } = await loadSettings();
		H.state.node.applySeedResult = H.refusal('not for this party');
		vm.seedInput = SEED;

		await vm.onApplySeed();

		expect(vm.seedInput).toBe(SEED);
		expect(vm.modalTitle).toBe('Seed failed');
		expect(vm.modalMessage).toContain('not for this party');
		expect(vm.modalVisibility).toBe('visible');
	});
});

describe('onApplySeed when the seed cannot be read', () => {
	it('keeps the field and names the seed, not the parse error', async () => {
		// This failure happens INSIDE `applySeed`, before the node is asked anything;
		// a "clear on success" that lived in the wrong place would pass the
		// node-refusal test above and still fail here.
		const { vm, H } = await loadSettings();
		H.state.node.decodeSeedError = new SyntaxError('Unexpected token < in JSON at position 0');
		vm.seedInput = 'not-a-seed';

		await vm.onApplySeed();

		expect(vm.modalTitle).toBe('Seed failed');
		expect(vm.modalMessage).toMatch(/cold-start seed/i);
		expect(vm.modalMessage).not.toMatch(/SyntaxError/);
		expect(vm.seedInput).toBe('not-a-seed');
		expect(H.calls).toEqual(['decodeSeed']);
	});
});

describe('onApplySeed with no usable seed', () => {
	it('does nothing when the seed field is empty or holds only whitespace', async () => {
		// `canApplySeed` disables the button on the same rule, but the handler must
		// hold the line on its own — the two-way binding can be updated by code.
		const { vm, H } = await loadSettings();

		await vm.onApplySeed();
		vm.seedInput = '   \n';
		expect(vm.canApplySeed).toBe(false);
		await vm.onApplySeed();

		expect(H.calls).toEqual([]);
		expect(vm.modalVisibility).toBe('collapse');
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
