/**
 * StrandService unit tests — a fake node, no HTTP.
 *
 * The two things this layer actually owns: id validation (which must never reach
 * the node) and the translation of the admin channel's single
 * `OwnerNodeUnavailableError` into a vocabulary the HTTP layer can map. The
 * confirmation *policy* is the node's and is not re-tested here — only that the
 * flag is forwarded verbatim.
 */

import { describe, it, expect, beforeEach } from 'vitest';

import { OwnerNodeUnavailableError } from '../../owner/owner-node-client.js';
import { StrandService } from '../strand-service.js';
import { StrandError } from '../types.js';
import type { CadreNodeLike } from '../strand-service.js';
import type { StrandListSnapshot, StrandRemovalResult } from '../types.js';

interface FakeNode extends CadreNodeLike {
  calls: Array<{ strandId: string; confirm: boolean }>;
  listCalls: number;
  /** Thrown by both methods when set. */
  failWith?: unknown;
}

const SNAPSHOT: StrandListSnapshot = {
  strands: [
    { id: 'open-one', type: 'o', running: true, status: 'active' },
    { id: 'closed-one', type: 'c', running: false, status: null },
  ],
  controlConnections: 2,
};

function fakeNode(): FakeNode {
  const node: FakeNode = {
    calls: [],
    listCalls: 0,
    async listStrands() {
      node.listCalls++;
      if (node.failWith) throw node.failWith;
      return SNAPSHOT;
    },
    async removeStrand(strandId, opts) {
      node.calls.push({ strandId, confirm: opts.confirm });
      if (node.failWith) throw node.failWith;
      const result: StrandRemovalResult = {
        strandId,
        published: true,
        type: 'o',
        removed: true,
        alone: false,
      };
      return result;
    },
  };
  return node;
}

/** Await a call expected to reject, assert it is a StrandError, and hand it back. */
async function catchStrandError(p: Promise<unknown>): Promise<StrandError> {
  const err = await p.then(() => undefined, (e: unknown) => e);
  expect(err).toBeInstanceOf(StrandError);
  return err as StrandError;
}

let node: FakeNode;
let service: StrandService;

beforeEach(() => {
  node = fakeNode();
  service = new StrandService({ cadreNode: node });
});

describe('StrandService.list', () => {
  it('passes the node snapshot through unchanged', async () => {
    await expect(service.list()).resolves.toEqual(SNAPSHOT);
    expect(node.listCalls).toBe(1);
  });
});

describe('StrandService.remove — id validation', () => {
  it.each([
    ['blank', ''],
    ['whitespace-only', '   '],
    ['tab/newline only', '\t\n'],
  ])('rejects a %s id with invalid_id and never calls the node', async (_label, id) => {
    await expect(service.remove(id, { confirm: false })).rejects.toMatchObject({
      name: 'StrandError',
      code: 'invalid_id',
    });
    expect(node.calls).toEqual([]);
  });

  it('rejects an id containing "/" with invalid_id and never calls the node', async () => {
    await expect(service.remove('ns/strand', { confirm: true })).rejects.toBeInstanceOf(StrandError);
    expect(node.calls).toEqual([]);
  });

  it('blames its own URL shape for a "/" id, not the node, and names the CLI fallback', async () => {
    // The admin channel accepts a percent-encoded id; only this route cannot carry
    // one. A message implying the node is at fault would send the operator hunting
    // in the wrong place.
    const err = await catchStrandError(service.remove('ns/strand', { confirm: true }));
    expect(err.message).toContain('management API');
    expect(err.message).toContain('cadre strand remove');
  });

  it('trims a padded id before forwarding it', async () => {
    await service.remove('  spaced  ', { confirm: false });
    expect(node.calls).toEqual([{ strandId: 'spaced', confirm: false }]);
  });
});

describe('StrandService.remove — confirmation forwarding', () => {
  it('forwards confirm: false as false', async () => {
    await service.remove('open-one', { confirm: false });
    expect(node.calls).toEqual([{ strandId: 'open-one', confirm: false }]);
  });

  it('forwards confirm: true as true', async () => {
    await service.remove('closed-one', { confirm: true });
    expect(node.calls).toEqual([{ strandId: 'closed-one', confirm: true }]);
  });

  it('does not retry a refused removal with confirmation added', async () => {
    node.failWith = new OwnerNodeUnavailableError('needs confirmation', 'confirmation_required');
    await expect(service.remove('closed-one', { confirm: false })).rejects.toBeInstanceOf(StrandError);
    // Exactly one attempt, and it carried the caller's flag.
    expect(node.calls).toEqual([{ strandId: 'closed-one', confirm: false }]);
  });
});

describe('StrandService — error translation', () => {
  const cases: Array<{ nodeCode: string | undefined; code: string; keepsMessage: boolean }> = [
    { nodeCode: 'confirmation_required', code: 'confirmation_required', keepsMessage: true },
    { nodeCode: 'bad_request', code: 'invalid_id', keepsMessage: true },
    { nodeCode: 'not_ready', code: 'node_unavailable', keepsMessage: false },
    { nodeCode: 'not_authorized', code: 'node_unavailable', keepsMessage: false },
    { nodeCode: undefined, code: 'node_unavailable', keepsMessage: false },
    { nodeCode: 'internal', code: 'internal', keepsMessage: true },
    { nodeCode: 'something_new', code: 'internal', keepsMessage: true },
  ];

  for (const { nodeCode, code, keepsMessage } of cases) {
    it(`maps nodeCode ${nodeCode ?? '(absent)'} → ${code}`, async () => {
      const message = `node said ${nodeCode ?? 'nothing'}`;
      node.failWith = new OwnerNodeUnavailableError(message, nodeCode);
      const err = await catchStrandError(service.remove('x', { confirm: false }));
      expect(err.code).toBe(code);
      if (keepsMessage) {
        expect(err.message).toBe(message);
      } else {
        // Wrapped, but the node's words survive inside.
        expect(err.message).toContain(message);
      }
    });
  }

  it('translates a transport failure (no nodeCode) on list() too', async () => {
    node.failWith = new OwnerNodeUnavailableError('Owner node unreachable: ECONNREFUSED');
    const err = await catchStrandError(service.list());
    expect(err.code).toBe('node_unavailable');
  });

  it('rethrows a non-owner-node error unchanged rather than dressing it as a strand error', async () => {
    const boom = new TypeError('something else broke');
    node.failWith = boom;
    await expect(service.list()).rejects.toBe(boom);
  });
});
