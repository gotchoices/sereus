/**
 * Parent side of the two-process restart arm of
 * `scenarios/strand-relay-only-restart-reconverges.integration.ts`: runs ONE party's
 * `CadreNode` in its own `node` child process (`fixtures/strand-restart-party.mjs`) and
 * drives it over the process's IPC channel.
 *
 * The child keeps everything a phone keeps on disk under `stateDir` — its identity key and
 * joined-strand records (`FileKeyStore`), its strand peer book (`FileStrandPeerBookStore`) and
 * its raw stores (`FileRawStorage`) — so a child that exits and is respawned over the same
 * directory is a real restart: a new process, with no module state carried over.
 *
 * The child imports the BUILT `@serfab/cadre-core`, which the suite's stale-build guard
 * (`test/global-setup.ts`) already holds fresh.
 */

import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { SAppConfig, StrandStatus } from '@serfab/cadre-core';

const CHILD_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'strand-restart-party.mjs');

/** How long a child may take to stop its node and exit before it is killed. */
const EXIT_GRACE_MS = 60_000;
/** How long a child may take to start its node (control DB bring-up plus the relay reservation). */
const READY_TIMEOUT_MS = 120_000;

/** Every request the child answers, with its arguments and its reply. */
export interface StrandRestartOps {
	/** Genesis, found a closed strand, publish a bound invitation for it. */
	found: {
		args: { strandId: string; sApp: SAppConfig; sAppId: string };
		result: { strandPeerId: string; encodedInvitation: string };
	};
	/** Genesis, form against the invitation, attach from the carried seed, wait until writable. */
	form: {
		args: { strandId: string; sApp: SAppConfig; encodedInvitation: string; timeoutMs: number };
		result: { strandPeerId: string };
	};
	/** After a restart: claim the strand from `strand:discovered` and wait until writable. */
	claim: {
		args: { strandId: string; sApp: SAppConfig; timeoutMs: number };
		result: { status: StrandStatus; strandPeerId: string };
	};
	write: {
		args: { strandId: string; key: string; val: string };
		result: Record<string, never>;
	};
	/** Poll until App.Data holds `key` = `val`. */
	waitRow: {
		args: { strandId: string; key: string; val: string; timeoutMs: number };
		result: Record<string, never>;
	};
	/** Poll until the book holds a signed entry for `peerId` issued at or after `issuedSince`. */
	waitSignedEntry: {
		args: { strandId: string; peerId: string; issuedSince: number; timeoutMs: number };
		result: { addrs: string[]; issuedAt: number };
	};
	/** `summarizeConnectionPaths` kinds of every strand connection to `peerId`. */
	pathKinds: {
		args: { strandId: string; peerId: string };
		result: { kinds: string[] };
	};
}

export interface StrandRestartPartyOptions {
	/** Prefixes the child's log lines and this driver's errors. */
	label: string;
	partyId: string;
	/** Everything the party keeps across a restart lives here; created by the child. */
	stateDir: string;
	relayAddr: string;
	profile: 'storage' | 'transaction';
}

export interface StrandRestartParty {
	readonly label: string;
	request<K extends keyof StrandRestartOps>(op: K, args: StrandRestartOps[K]['args']): Promise<StrandRestartOps[K]['result']>;
	/** Stop the node, let the process exit (killed past a grace period). Idempotent. */
	exit(): Promise<void>;
}

type ChildMessage =
	| { type: 'ready'; peerId: string }
	| { type: 'reply'; id: number; result?: unknown; error?: string };

interface Pending {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
}

/** Spawn one party process and resolve once its node has started. */
export async function startStrandRestartParty(options: StrandRestartPartyOptions): Promise<StrandRestartParty> {
	const child = fork(CHILD_SCRIPT, [JSON.stringify(options)], {
		// Not the test runner's loader flags: the child is plain Node running built ESM.
		execArgv: [],
		stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
	});
	const pending = new Map<number, Pending>();
	let nextId = 1;
	const exited = new Promise<void>((resolve) => {
		child.once('exit', (code, signal) => {
			const error = new Error(`${options.label}: party process exited (code ${code}, signal ${signal})`);
			for (const request of pending.values()) request.reject(error);
			pending.clear();
			resolve();
		});
	});
	// A failed IPC send (the child already gone) is emitted as 'error'; unheard, it would
	// crash the test worker instead of failing the one request.
	child.on('error', (error) => {
		for (const request of pending.values()) request.reject(new Error(`${options.label}: ${error.message}`, { cause: error }));
		pending.clear();
	});
	const ready = waitForReady(child, options.label);
	child.on('message', (message: ChildMessage) => {
		if (message.type !== 'reply') return;
		const request = pending.get(message.id);
		if (!request) return;
		pending.delete(message.id);
		if (message.error !== undefined) request.reject(new Error(`${options.label}: ${message.error}`));
		else request.resolve(message.result);
	});

	const exit = async (): Promise<void> => {
		if (child.exitCode === null && child.signalCode === null && child.connected) child.send({ op: 'stop' });
		const timer = setTimeout(() => child.kill(), EXIT_GRACE_MS);
		await exited;
		clearTimeout(timer);
	};

	try {
		await ready;
	} catch (error) {
		child.kill();
		await exited;
		throw error;
	}

	return {
		label: options.label,
		request<K extends keyof StrandRestartOps>(op: K, args: StrandRestartOps[K]['args']) {
			const id = nextId++;
			return new Promise<StrandRestartOps[K]['result']>((resolve, reject) => {
				pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
				child.send({ id, op, args });
			});
		},
		exit,
	};
}

function waitForReady(child: ChildProcess, label: string): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`${label}: party process not ready after ${READY_TIMEOUT_MS} ms`)), READY_TIMEOUT_MS);
		child.on('message', (message: ChildMessage) => {
			if (message.type === 'ready') {
				clearTimeout(timer);
				resolve();
			}
		});
		child.once('exit', (code) => {
			clearTimeout(timer);
			reject(new Error(`${label}: party process exited (code ${code}) before its node started`));
		});
	});
}
