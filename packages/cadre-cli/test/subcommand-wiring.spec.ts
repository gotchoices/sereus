import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fromString as uint8ArrayFromString } from 'uint8arrays';
import type { CadreNode, StrandRow } from '@serfab/cadre-core';

/**
 * Drives the commander commands end to end over a fake node, covering the seam the plan-level
 * specs cannot reach: the shared `runSubcommand` / `reportPlan` scaffolding, the `nodeStore`
 * adapter, and — the security-relevant part — the EXIT CODE a refusal leaves with.
 *
 * `withConnectedNode` is the only thing stubbed; everything from the parsed argument down to
 * the store call is the real code path.
 */

const session = vi.hoisted(() => ({ node: undefined as unknown }));

vi.mock('../src/commands/node-session.js', () => ({
	withConnectedNode: async (_configPath: string, action: (node: never) => Promise<void>) => {
		await action(session.node as never);
	},
}));

const { strandCommand } = await import('../src/commands/strands.js');
const { validationKeyCommand } = await import('../src/commands/validation-key.js');

const STRAND_ID = 'strand-alpha';

const openRow = (Id = STRAND_ID): StrandRow => ({ Id, MemberPrivateKey: null, Type: 'o' });
const closedRow = (Id = STRAND_ID): StrandRow => ({ Id, MemberPrivateKey: 'secret-key', Type: 'c' });

interface FakeNode {
	node: CadreNode;
	readonly writes: string[];
}

/** A `CadreNode` stand-in exposing only what these commands touch, recording every write. */
function fakeNode(rows: StrandRow[] = [], keys: string[] = []): FakeNode {
	const strands = new Map(rows.map((row) => [row.Id, row]));
	const enrolled = new Set(keys);
	const writes: string[] = [];
	const node = {
		getControlDatabase: () => ({
			queryStrand: async (strandId: string) => strands.get(strandId) ?? null,
		}),
		unpublishStrand: async (strandId: string) => {
			writes.push(`unpublish:${strandId}`);
			strands.delete(strandId);
		},
		forceStrandPoll: async () => { /* nothing to reconcile in the fake */ },
		getStrands: () => new Map(),
		listValidationKeys: async () => [...enrolled].sort(),
		enrollValidationKey: async (key: string) => {
			// Mirrors `CadreNode.enrollValidationKey`'s `requireEd25519PublicKeyB64` guard, so this
			// fake exercises the same refusal shape the CLI sees from a real node.
			const trimmed = key.trim();
			let decoded: Uint8Array;
			try {
				decoded = uint8ArrayFromString(trimmed, 'base64url');
			} catch {
				throw new Error(`A validation key must be a base64url-encoded Ed25519 public key (could not decode "${trimmed}" as base64url)`);
			}
			if (decoded.length !== 32) {
				throw new Error(`A validation key must be a base64url-encoded 32-byte Ed25519 public key (decoded to ${decoded.length} bytes)`);
			}
			writes.push(`enroll-key:${trimmed}`);
			enrolled.add(trimmed);
		},
		removeValidationKey: async (key: string) => {
			writes.push(`remove-key:${key}`);
			enrolled.delete(key);
		},
	};
	return { node: node as unknown as CadreNode, writes };
}

interface RunResult {
	exit: number | undefined;
	stdout: string;
	stderr: string;
}

let exits: number[];
let stdout: string[];
let stderr: string[];

beforeEach(() => {
	exits = [];
	stdout = [];
	stderr = [];
	// A no-op so execution continues past `process.exit`; the code is what is under test.
	vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
		exits.push(code ?? 0);
		return undefined;
	}) as never);
	vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { stdout.push(args.join(' ')); });
	vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { stderr.push(args.join(' ')); });
	vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { stderr.push(args.join(' ')); });
});

afterEach(() => {
	vi.restoreAllMocks();
	session.node = undefined;
});

/** Parse `argv` against `command` as the user would type it, returning what the operator sees. */
async function run(command: { parseAsync: (argv: string[], opts: { from: 'user' }) => Promise<unknown> }, argv: string[]): Promise<RunResult> {
	await command.parseAsync(argv, { from: 'user' });
	return { exit: exits.at(-1), stdout: stdout.join('\n'), stderr: stderr.join('\n') };
}

describe('cadre strand remove', () => {
	it('removes an open strand and exits 0', async () => {
		const fake = fakeNode([openRow()]);
		session.node = fake.node;
		const result = await run(strandCommand, ['remove', STRAND_ID]);
		expect(fake.writes).toEqual([`unpublish:${STRAND_ID}`]);
		expect(result.exit).toBe(0);
		expect(result.stdout).toContain('Strand removed');
		expect(result.stderr).toMatch(/party-wide/i);
	});

	it('exits NON-ZERO and writes nothing when it refuses a closed strand', async () => {
		// The security-relevant half: a refusal must be distinguishable by exit code, not just
		// by text, or a script reads "success" over a strand it never removed.
		const fake = fakeNode([closedRow()]);
		session.node = fake.node;
		const result = await run(strandCommand, ['remove', STRAND_ID]);
		expect(fake.writes).toEqual([]);
		expect(result.exit).toBe(1);
		expect(result.stderr).toContain('Refusing to remove closed strand');
		// The refusal is a reason for the exit code, not a result: stdout stays clean.
		expect(result.stdout).toBe('');
	});

	it('prints a parseable refusal on stdout under --json, and still exits non-zero', async () => {
		const fake = fakeNode([closedRow()]);
		session.node = fake.node;
		const result = await run(strandCommand, ['remove', STRAND_ID, '--json']);
		expect(result.exit).toBe(1);
		expect(JSON.parse(result.stdout)).toEqual({
			strandId: STRAND_ID,
			published: true,
			type: 'c',
			changed: false,
			refused: true,
			reason: 'closed-strand-requires-yes',
		});
		expect(fake.writes).toEqual([]);
	});

	it('removes a closed strand with --yes, warning that the key is gone', async () => {
		const fake = fakeNode([closedRow()]);
		session.node = fake.node;
		const result = await run(strandCommand, ['remove', STRAND_ID, '--yes']);
		expect(fake.writes).toEqual([`unpublish:${STRAND_ID}`]);
		expect(result.exit).toBe(0);
		expect(result.stderr).toMatch(/unrecoverable/i);
	});

	it('does not carry --yes over from a previous invocation', async () => {
		const fake = fakeNode([closedRow()]);
		session.node = fake.node;
		await run(strandCommand, ['remove', 'other-strand', '--yes']);
		const result = await run(strandCommand, ['remove', STRAND_ID]);
		expect(result.exit).toBe(1);
		expect(fake.writes).toEqual([]);
	});

	it('exits 0 for a strand that is not published, without writing', async () => {
		const fake = fakeNode([]);
		session.node = fake.node;
		const result = await run(strandCommand, ['remove', STRAND_ID]);
		expect(fake.writes).toEqual([]);
		expect(result.exit).toBe(0);
		expect(result.stdout).toContain('nothing to do');
	});

	it('reports a blank id as a failure rather than "nothing to do"', async () => {
		const fake = fakeNode([openRow()]);
		session.node = fake.node;
		const result = await run(strandCommand, ['remove', '   ']);
		expect(result.exit).toBe(1);
		expect(result.stderr).toContain('Failed to remove strand: A strand id is required');
		expect(fake.writes).toEqual([]);
	});
});

describe('the `strands` invocation the group replaced', () => {
	it('lists on a bare `strands`, rather than answering with usage text', async () => {
		session.node = fakeNode().node;
		const result = await run(strandCommand, []);
		expect(result.exit).toBe(0);
		expect(result.stdout).toContain('Active Strands');
	});

	it('still accepts the group-level options the old command took', async () => {
		session.node = fakeNode().node;
		const result = await run(strandCommand, ['--json', '-c', 'somewhere.yaml']);
		expect(result.exit).toBe(0);
		// Nothing but the payload on stdout — the progress line is on stderr, so this pipes.
		expect(JSON.parse(result.stdout)).toEqual([]);
		expect(result.stderr).toContain('Connecting to control network');
	});
});

describe('cadre validation-key over the shared scaffolding', () => {
	it('exits non-zero and leaves the enrolled set unchanged when the key is malformed', async () => {
		const fake = fakeNode([], []);
		session.node = fake.node;
		const result = await run(validationKeyCommand, ['add', 'not-a-real-key']);
		expect(result.exit).toBe(1);
		expect(result.stderr).toMatch(/base64url-encoded/i);
		expect(fake.writes).toEqual([]);
		expect(await fake.node.listValidationKeys()).toEqual([]);
	});

	it('exits 0 and reports the emptied set after removing the last key', async () => {
		const fake = fakeNode([], ['key-a']);
		session.node = fake.node;
		const result = await run(validationKeyCommand, ['remove', 'key-a']);
		expect(fake.writes).toEqual(['remove-key:key-a']);
		expect(result.exit).toBe(0);
		expect(result.stdout).toContain('Approver key removed');
		expect(result.stderr).toMatch(/last enrolled approver key/i);
	});

	it('exits 0 without writing when the key was never enrolled', async () => {
		const fake = fakeNode([], ['key-b']);
		session.node = fake.node;
		const result = await run(validationKeyCommand, ['remove', 'key-a']);
		expect(fake.writes).toEqual([]);
		expect(result.exit).toBe(0);
		expect(result.stdout).toContain('nothing to do');
	});
});
