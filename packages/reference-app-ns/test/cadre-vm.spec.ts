/**
 * `cadre-vm.ts` — the shared view model both NativeScript screens bind to.
 *
 * What this suite exists for is what the view model puts in FRONT of the edge
 * node: the 'Node not started' guards, the rewrap of an unreadable seed or
 * invitation paste with copy naming the field, the join path's order — decode
 * first, so a bad paste never reaches the edge node — and how the edge node's
 * status reports become the screens' status, peer id and strand list. Every
 * edge-node and node call is appended to one shared `H.calls` array (see
 * `test/stubs/fake-cadre-node.ts`) and the tests assert that array whole, so a
 * call that moved fails as surely as one that never happened.
 *
 * `@serfab/cadre-core` is left REAL: `cadre-vm.ts` calls `decodeCadreInvitation`
 * as a runtime value, and the join tests feed it a bundle the real
 * `encodeCadreInvitation` rendered, so the shape check between the two is the one
 * the app ships with. `test/global-setup.ts`'s stale-build guard therefore covers
 * this file too.
 *
 * `getCadreVm()` caches a module-level singleton, so every test loads the module
 * fresh through `loadModule()` (`vi.resetModules()` + dynamic import) rather than
 * letting one test's started node leak into the next.
 */
import { describe, it, expect, vi } from 'vitest';
// Side-effect import, and load-bearing: evaluating `@serfab/cadre-core`'s
// compiled graph (and the linked `@optimystic/*` / `@quereus/quereus` behind it)
// takes seconds, and this suite deliberately leaves the package unmocked. Done
// here the cost is charged to the file's import phase; left to the first
// `import('../src/cadre-vm')` inside a test it blows the default 5s timeout.
import '@serfab/cadre-core';
import type { PropertyChangeData } from '@nativescript/core';
import type { CadreViewModel } from '../src/cadre-vm';

/**
 * The shared fakes, reached through a hoisted dynamic import — `vi.mock`
 * factories are hoisted above this file's own imports, so a static binding would
 * not be in scope for them. One instance for the whole file (hence `H.reset()`
 * per load); the dynamic import is the only way to give the factories and the
 * suite body the same one.
 */
const stubs = vi.hoisted(async () => import('./stubs/fake-cadre-node'));

vi.mock('../src/cadre-phone', async () => (await stubs).phoneNodeMock());
vi.mock('../src/chat-strand', async () => (await stubs).chatStrandMock());

type Stubs = typeof import('./stubs/fake-cadre-node');

const SEED = 'encoded-seed';
const RELAY = '/ip4/5.6.7.8/tcp/4003/ws/p2p/12D3KooWRelayRelayRelayRelayRelayRelayRelayRelayRela';

/**
 * A fresh view-model module over a fresh fake edge node. Both halves matter:
 * `getCadreVm()` caches a module-level singleton, and the fakes accumulate a
 * call log — either one crossing a test boundary would make these tests read
 * each other's state.
 */
async function loadModule(): Promise<{ mod: typeof import('../src/cadre-vm'); H: Stubs }> {
	const H = await stubs;
	H.reset();
	vi.resetModules();
	const mod = await import('../src/cadre-vm');
	return { mod, H };
}

/**
 * A view model that has adopted the running fake node, with the call log cleared
 * of the adopt path so each test asserts only the calls it caused.
 */
async function adoptedVm(): Promise<{ vm: CadreViewModel; H: Stubs }> {
	const { mod, H } = await loadModule();
	H.presentRunningNode();
	const vm = new mod.CadreViewModel();
	H.clearCalls();
	return { vm, H };
}

/** A view model with no node running — every guarded method must refuse. */
async function coldVm(): Promise<{ vm: CadreViewModel; H: Stubs }> {
	const { mod, H } = await loadModule();
	const vm = new mod.CadreViewModel();
	H.clearCalls();
	return { vm, H };
}

// ── The @nativescript/core alias ──────────────────────────────────────────────

describe('the @nativescript/core stub', () => {
	it('gives the view model a real Observable that notifies property changes', async () => {
		// Guard, not ceremony. If the alias stops resolving, `Observable` arrives
		// undefined and every construction below fails somewhere unrecognisable
		// instead of here; and a hand-written double would pass a smoke test while
		// diverging from the class the app ships against — hence a real notify.
		const { vm } = await coldVm();
		const seen: string[] = [];
		vm.on('propertyChange', (args) => void seen.push((args as PropertyChangeData).propertyName));

		expect(vm.status).toBe('idle');
		await vm.start({ partyId: 'party-x', bootstrapAddrs: [], relayAddrs: [] });

		expect(vm.status).toBe('connected');
		expect(seen).toContain('status');
		expect(seen).toContain('connected');
	});
});

// ── Following the edge node's status ──────────────────────────────────────────

describe('the constructor', () => {
	it('adopts a running node, reading its peer id and strands', async () => {
		const { mod, H } = await loadModule();
		H.presentRunningNode().strands.set('strand-1', H.fakeStrand());

		const vm = new mod.CadreViewModel();

		expect(vm.status).toBe('connected');
		expect(vm.connected).toBe(true);
		expect(vm.peerId).toBe('peer-abc');
		// What the Chat VM reads — `null` rather than `''` when there is no node.
		expect(vm.getPeerId()).toBe('peer-abc');
		expect(vm.strandCount).toBe(1);
	});

	it('adopts nothing when no node is running', async () => {
		const { vm } = await coldVm();

		expect(vm.status).toBe('idle');
		expect(vm.peerIdDisplay).toBe('—');
		expect(vm.getPeerId()).toBeNull();
		expect(vm.getFirstStrand()).toBeNull();
		expect(vm.strandCount).toBe(0);
	});
});

describe('a status the edge node reports on its own', () => {
	it('shows a removal by an owner as disconnected, saying why, with the strands dropped', async () => {
		// The edge node acts on a removal without any screen asking, so only its
		// report tells the view model; a stale strand would point at a deleted database.
		const { vm, H } = await adoptedVm();
		H.state.node.strands.set('strand-1', H.fakeStrand());
		H.state.node.emit('strand:started', { strandId: 'strand-1' });

		const removal = { partyId: 'party-x', stampId: 'stamp-1', signerKey: null, at: 0 };
		H.edge.report({ state: 'removed', partyId: 'party-x', removal });

		expect(vm.status).toBe('idle');
		expect(vm.error).toMatch(/removed this phone from cadre party-x/);
		expect(vm.strandCount).toBe(0);
		expect(vm.peerId).toBe('');
	});
});

describe('getCadreVm', () => {
	it('hands the same view model to every caller', async () => {
		const { mod } = await loadModule();

		expect(mod.getCadreVm()).toBe(mod.getCadreVm());
	});

	it('is rebuilt by a module reset, so one test cannot leak into the next', async () => {
		// The isolation every other test in this file depends on. If
		// `vi.resetModules()` ever stops taking, the cached singleton comes back with
		// the previous load's adopted node and these two read the same status.
		const first = (await loadModule()).mod.getCadreVm();
		const second = await loadModule();
		second.H.presentRunningNode();

		expect(second.mod.getCadreVm()).not.toBe(first);
		expect(second.mod.getCadreVm().status).toBe('connected');
	});

	it('resumes the last session at launch only when it ended connected', async () => {
		// The launch half of the saved start: a relaunch after anything but
		// Disconnect reconnects to the same party by itself; after Disconnect it only
		// offers the options back to the Settings form.
		const options = { partyId: 'party-x', bootstrapAddrs: ['/ip4/1.2.3.4/tcp/4001/ws'], relayAddrs: [RELAY] };

		const resumed = await loadModule();
		resumed.H.state.savedStart = { options, autoStart: true };
		const connected = resumed.mod.getCadreVm();
		await vi.waitFor(() => expect(connected.status).toBe('connected'));
		expect(resumed.H.state.startOpts).toEqual([options]);

		const disconnected = await loadModule();
		disconnected.H.state.savedStart = { options, autoStart: false };
		const idle = disconnected.mod.getCadreVm();
		await vi.waitFor(() => expect(idle.savedStartOptions).toEqual(options));
		expect(idle.status).toBe('idle');
		expect(disconnected.H.state.startOpts).toEqual([]);
	});
});

// ── joinCadre ─────────────────────────────────────────────────────────────────

describe('joinCadre', () => {
	it('decodes the paste and hands the bundle and the relays to the edge node', async () => {
		// The decode is the real one, so what reaches the edge node is the bundle the
		// encoder was given, not the string the user pasted.
		const { vm, H } = await adoptedVm();

		const result = await vm.joinCadre(H.ENCODED_INVITATION, [RELAY]);

		expect(result).toBe(H.state.joinResult);
		expect(H.calls.filter((call) => call === 'joinCadre')).toHaveLength(1);
		expect(H.state.joined).toEqual([{ invitation: H.invitation(), options: { relayAddrs: [RELAY] } }]);
	});

	it('rewraps an unreadable paste naming the invitation, and never reaches the edge node', async () => {
		// `decodeCadreInvitation` says what was wrong with the bundle; the modal
		// renders `String(err)`, so the message must also say which paste it was.
		// Matched on a distinctive substring — this is UI copy, and a wording tweak
		// should not fail the suite. The decoder's own error rides along as `cause`.
		const { vm, H } = await adoptedVm();

		await expect(vm.joinCadre('not-an-invitation', [])).rejects.toThrow(/cadre invitation could not be read/i);
		await expect(vm.joinCadre('not-an-invitation', [])).rejects.toMatchObject({ cause: expect.any(Error) });
		expect(H.calls).toEqual([]);
	});
});

// ── applySeed ─────────────────────────────────────────────────────────────────

describe('applySeed', () => {
	it('decodes then applies, overriding no trust policy', async () => {
		// The node's configured `anchoredTrustPolicy` must stay in force — passing an
		// options object here would silently widen trust for every ordinary seed.
		const { vm, H } = await adoptedVm();

		await vm.applySeed(SEED);

		expect(H.calls).toEqual(['decodeSeed', 'applySeed']);
		expect(H.state.node.applied[0]!.options).toBeUndefined();
	});

	it('forwards the decoded seed, not the encoded string', async () => {
		const { vm, H } = await adoptedVm();

		await vm.applySeed(SEED);

		expect(H.state.node.decodedSeeds).toEqual([SEED]);
		expect(H.state.node.applied[0]!.seed).toBe(H.sentinels.decodedSeed);
	});
});

describe('applySeed failures', () => {
	it("surfaces the node's own rejection text", async () => {
		const { vm, H } = await adoptedVm();
		H.state.node.applySeedResult = H.refusal('signer key is not an anchored owner');

		await expect(vm.applySeed(SEED)).rejects.toThrow('signer key is not an anchored owner');
	});

	it('falls back to generic copy when the node gave no reason', async () => {
		const { vm, H } = await adoptedVm();
		H.state.node.applySeedResult = H.refusal();

		await expect(vm.applySeed(SEED)).rejects.toThrow('Seed application failed');
	});

	it('refuses before the node is started, without decoding the seed', async () => {
		const { vm, H } = await coldVm();

		await expect(vm.applySeed(SEED)).rejects.toThrow('Node not started');
		expect(H.state.node.decodedSeeds).toEqual([]);
		expect(H.calls).toEqual([]);
	});

	it('rewraps an unreadable seed with copy naming the seed', async () => {
		// `CadreNode.decodeSeed` is a raw base64url → `JSON.parse` → cast, so a bare
		// `SyntaxError` would otherwise reach the Settings modal.
		const { vm, H } = await adoptedVm();
		const parseFailure = new SyntaxError('Unexpected token < in JSON at position 0');
		H.state.node.decodeSeedError = parseFailure;

		await expect(vm.applySeed('not-a-seed')).rejects.toThrow(/cold-start seed/i);
		await expect(vm.applySeed('not-a-seed')).rejects.toMatchObject({ cause: parseFailure });
		expect(H.calls).toEqual(['decodeSeed', 'decodeSeed']);
	});
});

// ── Lifecycle ─────────────────────────────────────────────────────────────────

describe('start', () => {
	it('reports a failure through status and error rather than throwing', async () => {
		// By design, matching the RN hook — the Settings screen reads `status` and
		// `error` after awaiting. A test expecting a rejection asserts the wrong
		// contract.
		const { vm, H } = await coldVm();
		H.state.startError = new Error('control network unreachable');

		await expect(vm.start({ partyId: 'party-x', bootstrapAddrs: [], relayAddrs: [] })).resolves.toBeUndefined();

		expect(vm.status).toBe('error');
		expect(vm.error).toBe('control network unreachable');
		expect(vm.connected).toBe(false);
	});

	it('follows the strand events of the node it started', async () => {
		// Subscribed once, on the edge node, before any node exists: the edge node
		// applies the handlers to the node the start builds.
		const { vm, H } = await coldVm();

		await vm.start({ partyId: 'party-x', bootstrapAddrs: [], relayAddrs: [] });
		H.state.node.strands.set('strand-1', H.fakeStrand());
		H.state.node.emit('strand:started', { strandId: 'strand-1' });

		expect(vm.strandCount).toBe(1);
		expect(vm.strandItems).toEqual([{ id: 'strand-1', title: 'strand-1', status: 'active' }]);
	});
});

describe('stop', () => {
	it('stops the edge node and drops the strand list with the node', async () => {
		// A stop closes every strand database, so a chat screen still offered one of
		// those instances would read through a closed handle.
		const { mod, H } = await loadModule();
		H.presentRunningNode().strands.set('strand-1', H.fakeStrand());
		const vm = new mod.CadreViewModel();

		await vm.stop();

		expect(H.calls).toContain('stop');
		expect(vm.status).toBe('idle');
		expect(vm.peerId).toBe('');
		expect(vm.strandCount).toBe(0);
		expect(vm.getFirstStrand()).toBeNull();
	});
});

// ── The strand list the Settings repeater binds to ────────────────────────────

describe('the strand list', () => {
	it('shortens the id for display while keeping the full one for lookup', async () => {
		// `title` is what the repeater renders; `id` is what a tap resolves against.
		// A test whose id is already 8 characters long cannot tell them apart.
		const { mod, H } = await loadModule();
		H.presentRunningNode().strands.set('strand-abcdef-0123456789', H.fakeStrand('idle'));

		const vm = new mod.CadreViewModel();

		expect(vm.strandItems).toEqual([{ id: 'strand-abcdef-0123456789', title: 'strand-a', status: 'idle' }]);
		expect(vm.strandSummary).toBe('1 strand(s)');
	});

	it('refreshes itself when a strand reports an error, and says so', async () => {
		// The noisiest of the handlers: it logs before refreshing, and a refresh that
		// stopped happening here would leave a dead strand showing `active` in the list.
		const { vm, H } = await adoptedVm();
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		try {
			H.state.node.strands.set('strand-1', H.fakeStrand('error'));
			H.state.node.emit('strand:error', { strandId: 'strand-1', error: new Error('runtime gone') });

			expect(vm.strandItems).toEqual([{ id: 'strand-1', title: 'strand-1', status: 'error' }]);
			expect(warn).toHaveBeenCalledOnce();
		} finally {
			warn.mockRestore();
		}
	});
});

// ── The remaining node pass-throughs ──────────────────────────────────────────

describe('createStrand', () => {
	it('creates the strand on the node and refreshes the strand list', async () => {
		const { vm, H } = await adoptedVm();

		const instance = await vm.createStrand('strand-9');

		expect(instance).toBe(H.sentinels.strandInstance);
		expect(vm.strandCount).toBe(1);
		expect(vm.getFirstStrand()).toBe(H.sentinels.strandInstance);
	});

	it('refuses before the node is started', async () => {
		const { vm, H } = await coldVm();

		await expect(vm.createStrand('strand-9')).rejects.toThrow('Node not started');
		expect(H.calls).toEqual([]);
	});
});

describe('dialPeer', () => {
	it('forwards the address and propagates a dial failure', async () => {
		// Unguarded by design — it delegates to `cadre-phone`, which carries its own
		// 'Phone node not started' guard.
		const { vm, H } = await adoptedVm();

		await vm.dialPeer('/ip4/1.2.3.4/tcp/4001/ws');
		expect(H.calls).toEqual(['dialPeer:/ip4/1.2.3.4/tcp/4001/ws']);

		H.state.dialError = new Error('dial refused');
		await expect(vm.dialPeer('/ip4/1.2.3.4/tcp/4001/ws')).rejects.toThrow('dial refused');
	});
});
