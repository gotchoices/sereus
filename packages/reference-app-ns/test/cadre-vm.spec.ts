/**
 * `cadre-vm.ts` — the shared view model both NativeScript screens bind to.
 *
 * The behaviour this suite exists for is an ORDERING. When the user pastes an
 * enrollment invite alongside a cold-start seed, the invite's owner keys must be
 * written into the node-local trusted-owner anchor BEFORE the seed is applied,
 * so the anchor already holds them when seed trust consults it. Asserting that
 * both calls merely happened would not catch a tidy-up that folds them together
 * or reorders them, so every node call is appended to one shared `H.calls` array
 * (see `test/stubs/fake-cadre-node.ts`) and the tests assert that array whole.
 *
 * `@serfab/cadre-core` is left REAL: `cadre-vm.ts` uses `pinnedKeyTrustPolicy`
 * as a runtime value, and the point of the pinned-key tests is that a working
 * policy object — one that really trusts the pasted keys — reaches `applySeed`.
 * `test/global-setup.ts`'s stale-build guard therefore covers this file too.
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
 * The shared fake node, reached through a hoisted dynamic import — `vi.mock`
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
const INVITE = 'encoded-invite';

/**
 * A fresh view-model module over a fresh fake node. Both halves matter:
 * `getCadreVm()` caches a module-level singleton, and the fake node accumulates
 * a call log — either one crossing a test boundary would make these tests read
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
 * A view model that has adopted the fake node, with the call log cleared of the
 * adopt path so each test asserts only the calls it caused.
 */
async function adoptedVm(): Promise<{ vm: CadreViewModel; H: Stubs }> {
	const { mod, H } = await loadModule();
	H.presentRunningNode();
	const vm = new mod.CadreViewModel();
	H.clearCalls();
	return { vm, H };
}

/** A view model with no node — every guarded method must refuse. */
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
		await vm.start({ partyId: 'party-x', bootstrapAddrs: [] });

		expect(vm.status).toBe('connected');
		expect(seen).toContain('status');
		expect(seen).toContain('connected');
	});
});

// ── Constructor: adopting an already-running node ─────────────────────────────

describe('the constructor', () => {
	it('adopts a running node, reading its peer id, strands and events', async () => {
		const { mod, H } = await loadModule();
		H.presentRunningNode().strands.set('strand-1', { status: 'active' });

		const vm = new mod.CadreViewModel();

		expect(vm.status).toBe('connected');
		expect(vm.connected).toBe(true);
		expect(vm.peerId).toBe('peer-abc');
		expect(vm.strandCount).toBe(1);
		expect(H.calls).toEqual(['getStrands', 'on:strand:started', 'on:strand:stopped', 'on:strand:error']);
	});

	it('adopts nothing when no node is running', async () => {
		const { vm, H } = await coldVm();

		expect(vm.status).toBe('idle');
		expect(vm.peerIdDisplay).toBe('—');
		expect(vm.strandCount).toBe(0);
		expect(H.state.node.boundHandlerCount()).toBe(0);
	});

	it('ignores a node that exists but is not running', async () => {
		const { mod, H } = await loadModule();
		H.presentRunningNode().isRunning = false;

		const vm = new mod.CadreViewModel();

		expect(vm.status).toBe('idle');
		expect(H.calls).toEqual([]);
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
		expect(first.status).toBe('idle');
		expect(second.mod.getCadreVm().status).toBe('connected');
	});
});

// ── ownerKeysFromInvite ───────────────────────────────────────────────────────

describe('ownerKeysFromInvite', () => {
	it('returns the invite owner keys in order', async () => {
		const { vm, H } = await adoptedVm();
		H.state.node.invite = { partyId: 'party-x', ownerAddrs: [], createdAt: 0, ownerKeys: [H.KEY_A, H.KEY_B] };

		expect(vm.ownerKeysFromInvite(INVITE)).toEqual([H.KEY_A, H.KEY_B]);
		expect(H.state.node.decodedInvites).toEqual([INVITE]);
	});

	it('returns an empty list for an older invite carrying no owner keys', async () => {
		// Not `undefined`, and not a throw: the Settings screen branches on
		// `pins?.length`, and an older invite is an ordinary case, not an error.
		const { vm } = await adoptedVm();

		expect(vm.ownerKeysFromInvite(INVITE)).toEqual([]);
	});

	it('rewraps an unreadable invite with copy naming the enrollment invite', async () => {
		// `CadreNode.decodeInvite` is base64url → JSON.parse → cast, so a typo'd
		// paste would otherwise surface as a bare `SyntaxError: Unexpected token …`.
		// Matched on a distinctive substring, not the whole sentence — this is UI
		// copy, and a wording tweak should not fail the suite.
		const { vm, H } = await adoptedVm();
		const parseFailure = new SyntaxError('Unexpected token < in JSON at position 0');
		H.state.node.decodeInviteError = parseFailure;

		expect(() => vm.ownerKeysFromInvite('not-an-invite')).toThrow(/enrollment invite/i);
		try {
			vm.ownerKeysFromInvite('not-an-invite');
			expect.unreachable('ownerKeysFromInvite should have thrown');
		} catch (err) {
			// The original rides along so a developer can still see the parse failure.
			expect((err as Error).cause).toBe(parseFailure);
		}
	});

	it('refuses before the node is started, without touching the node', async () => {
		const { vm, H } = await coldVm();

		expect(() => vm.ownerKeysFromInvite(INVITE)).toThrow('Node not started');
		// Guard order matches `applySeed`: the throw comes before any node call.
		expect(H.state.node.decodedInvites).toEqual([]);
		expect(H.calls).toEqual([]);
	});
});

// ── applySeed: the enrollment ordering ────────────────────────────────────────

describe('applySeed with pinned owner keys', () => {
	it('anchors the invite keys BEFORE applying the seed', async () => {
		// The reason this suite exists. The anchor has to already hold the keys when
		// seed trust consults it, so `trustOwnerKeys` must precede `applySeed`.
		// Asserting the whole call log — rather than two `toHaveBeenCalled`s — is
		// what makes a reorder, or a fold of the two calls into one, fail here.
		const { vm, H } = await adoptedVm();

		await vm.applySeed(SEED, [H.KEY_A, H.KEY_B]);

		expect(H.calls).toEqual(['decodeSeed', 'trustOwnerKeys', 'applySeed']);
	});

	it('anchors the keys under the invite provenance', async () => {
		const { vm, H } = await adoptedVm();

		await vm.applySeed(SEED, [H.KEY_A, H.KEY_B]);

		expect(H.state.node.trusted).toEqual([{ keys: [H.KEY_A, H.KEY_B], source: 'invite' }]);
	});

	it('hands applySeed a trust policy that accepts the pinned keys', async () => {
		// A real `pinnedKeyTrustPolicy` built from THESE keys, not merely some object
		// parked under a `trustPolicy` property — a policy built from the wrong list
		// is still an object, and the cold-start seed would then be rejected on
		// device with the pin apparently in place.
		const { vm, H } = await adoptedVm();

		await vm.applySeed(SEED, [H.KEY_A]);

		const policy = H.state.node.applied[0]!.options?.trustPolicy;
		expect(policy).toBeDefined();
		expect(await policy!.evaluate({ partyId: 'party-x', signerKey: H.KEY_A, knownOwnerKeys: new Set() }))
			.toEqual({ trusted: true, anchorAs: 'invite' });
		expect(await policy!.evaluate({ partyId: 'party-x', signerKey: H.KEY_B, knownOwnerKeys: new Set() }))
			.toMatchObject({ trusted: false });
	});

	it('forwards the decoded seed, not the encoded string', async () => {
		const { vm, H } = await adoptedVm();

		await vm.applySeed(SEED, [H.KEY_A]);

		expect(H.state.node.decodedSeeds).toEqual([SEED]);
		expect<unknown>(H.state.node.applied[0]!.seed).toBe(H.sentinels.decodedSeed);
	});

	it('keeps the pin when the node refuses the seed', async () => {
		// Pasting the invite is itself the out-of-band trust act; the seed is a
		// separate artifact that may be stale, for another party, or corrupt.
		// Rolling the anchor back here would cost the user a re-paste on every retry.
		const { vm, H } = await adoptedVm();
		H.state.node.applySeedResult = { success: false, error: 'not for this party', peersAdded: 0 };

		await expect(vm.applySeed(SEED, [H.KEY_A])).rejects.toThrow('not for this party');
		expect(H.state.node.trusted).toEqual([{ keys: [H.KEY_A], source: 'invite' }]);
		expect(H.calls).toEqual(['decodeSeed', 'trustOwnerKeys', 'applySeed']);
	});
});

describe('applySeed without pinned owner keys', () => {
	it('never touches the anchor and overrides no trust policy', async () => {
		// The node's configured `anchoredTrustPolicy` must stay in force — passing an
		// options object here would silently widen trust for every ordinary seed.
		const { vm, H } = await adoptedVm();

		await vm.applySeed(SEED);

		expect(H.calls).toEqual(['decodeSeed', 'applySeed']);
		expect(H.state.node.trusted).toEqual([]);
		expect(H.state.node.applied[0]!.options).toBeUndefined();
	});

	it('treats an empty pin list exactly as no pins at all', async () => {
		// `ownerKeysFromInvite` returns `[]` for an older invite, and that reaches
		// here directly from the Settings screen.
		const { vm, H } = await adoptedVm();

		await vm.applySeed(SEED, []);

		expect(H.calls).toEqual(['decodeSeed', 'applySeed']);
		expect(H.state.node.trusted).toEqual([]);
		expect(H.state.node.applied[0]!.options).toBeUndefined();
	});
});

describe('applySeed failures', () => {
	it("surfaces the node's own rejection text", async () => {
		const { vm, H } = await adoptedVm();
		H.state.node.applySeedResult = { success: false, error: 'signer key is not an anchored owner', peersAdded: 0 };

		await expect(vm.applySeed(SEED)).rejects.toThrow('signer key is not an anchored owner');
	});

	it('falls back to generic copy when the node gave no reason', async () => {
		const { vm, H } = await adoptedVm();
		H.state.node.applySeedResult = { success: false, peersAdded: 0 };

		await expect(vm.applySeed(SEED)).rejects.toThrow('Seed application failed');
	});

	it('refuses before the node is started, without decoding the seed', async () => {
		const { vm, H } = await coldVm();

		await expect(vm.applySeed(SEED, [H.KEY_A])).rejects.toThrow('Node not started');
		expect(H.state.node.decodedSeeds).toEqual([]);
		expect(H.calls).toEqual([]);
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

		await expect(vm.start({ partyId: 'party-x', bootstrapAddrs: [] })).resolves.toBeUndefined();

		expect(vm.status).toBe('error');
		expect(vm.error).toBe('control network unreachable');
		expect(vm.connected).toBe(false);
	});

	it('binds the strand events of the node it started', async () => {
		const { vm, H } = await coldVm();

		await vm.start({ partyId: 'party-x', bootstrapAddrs: [] });
		H.state.node.strands.set('strand-1', { status: 'active' });
		H.state.node.emit('strand:started', { strandId: 'strand-1' });

		expect(vm.strandCount).toBe(1);
		expect(vm.strandItems).toEqual([{ id: 'strand-1', title: 'strand-1', status: 'active' }]);
	});
});

describe('stop', () => {
	it('unbinds every strand event before dropping the node', async () => {
		// A stopped view model that still received `strand:started` would repopulate
		// its strand list from a dead node. The fake's `off` deletes by handler
		// identity, so a view model passing freshly-created closures leaves these bound.
		const { vm, H } = await adoptedVm();

		await vm.stop();

		expect(H.calls).toEqual(['off:strand:started', 'off:strand:stopped', 'off:strand:error', 'stopPhoneNode']);
		expect(H.state.node.boundHandlerCount()).toBe(0);
	});

	it('clears the view model back to idle', async () => {
		const { mod, H } = await loadModule();
		H.presentRunningNode().strands.set('strand-1', { status: 'active' });
		const vm = new mod.CadreViewModel();

		await vm.stop();

		expect(vm.status).toBe('idle');
		expect(vm.peerId).toBe('');
		expect(vm.strandCount).toBe(0);
	});
});

// ── The remaining node pass-throughs ──────────────────────────────────────────

describe('createStrand', () => {
	it('creates the strand on the node and refreshes the strand list', async () => {
		const { vm, H } = await adoptedVm();

		const instance = await vm.createStrand('strand-9');

		expect<unknown>(instance).toBe(H.sentinels.strandInstance);
		expect(vm.strandCount).toBe(1);
		expect<unknown>(vm.getFirstStrand()).toBe(H.sentinels.strandInstance);
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
		// 'Phone node not started' guard (covered in `cadre-phone.spec.ts`).
		const { vm, H } = await adoptedVm();

		await vm.dialPeer('/ip4/1.2.3.4/tcp/4001/ws');
		expect(H.calls).toEqual(['dialPeer:/ip4/1.2.3.4/tcp/4001/ws']);

		H.state.dialError = new Error('dial refused');
		await expect(vm.dialPeer('/ip4/1.2.3.4/tcp/4001/ws')).rejects.toThrow('dial refused');
	});
});
