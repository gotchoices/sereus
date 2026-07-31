import { describe, it, expect } from 'vitest';
import { ControlFormationUsageRecorder } from '../src/control-formation-recorder.js';
import { FormationAbortedError, type ControlDatabase } from '../src/control-database.js';
import type { FormationApprover } from '../src/formation-approval.js';

/**
 * Abort plumbing for the write-path recorder: a signal that is ALREADY aborted when
 * `recordUsage` / `provisionAndRecord` is entered must reject with
 * {@link FormationAbortedError} before anything else happens — no invite read, no approval
 * request, no write. The full happy paths run against the real control database in
 * `control-formation-invite.spec.ts`; this file only pins the early-exit ordering, so the
 * collaborators are booby-trapped rather than faked.
 */

/**
 * A ControlDatabase whose EVERY member access throws. Safe to hand to the constructor —
 * it only stores the reference — so any test failure here means the recorder touched the
 * database before honouring the abort.
 */
function unreachableDatabase(): ControlDatabase {
  return new Proxy({}, {
    get(_target, prop) {
      throw new Error(`ControlDatabase.${String(prop)} must not be reached`);
    }
  }) as unknown as ControlDatabase;
}

/** Injected so the default HTTP approver is never constructed, and any ask is loud. */
const unreachableApprover: FormationApprover = {
  requestApproval() {
    throw new Error('approver must not be reached');
  }
};

function abortedSignal(): AbortSignal {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
}

function recorder(): ControlFormationUsageRecorder {
  return new ControlFormationUsageRecorder(unreachableDatabase(), { approver: unreachableApprover });
}

describe('ControlFormationUsageRecorder abort plumbing', () => {
  it('recordUsage rejects a pre-aborted signal before reading the invite', async () => {
    const error = await recorder().recordUsage({
      token: 'invite-abc',
      peerId: '12D3KooWJoiner',
      strandId: 'strand-1',
      disclosure: '{}',
      signal: abortedSignal()
    }).then(
      () => { throw new Error('expected recordUsage to reject'); },
      (caught: unknown) => caught
    );

    expect(error).toBeInstanceOf(FormationAbortedError);
    expect((error as FormationAbortedError).token).toBe('invite-abc');
    expect((error as FormationAbortedError).message).toContain('usage recording');
  });

  it('provisionAndRecord rejects a pre-aborted signal before minting a strand id', async () => {
    const error = await recorder().provisionAndRecord({
      token: 'invite-abc',
      peerId: '12D3KooWJoiner',
      sAppId: 'sapp-1',
      disclosure: '{}',
      signal: abortedSignal()
    }).then(
      () => { throw new Error('expected provisionAndRecord to reject'); },
      (caught: unknown) => caught
    );

    expect(error).toBeInstanceOf(FormationAbortedError);
    expect((error as FormationAbortedError).token).toBe('invite-abc');
    expect((error as FormationAbortedError).message).toContain('redemption');
  });

  it('an unaborted signal changes nothing about the read path', async () => {
    // Sanity guard on the guard itself: the recorder must consult the database when the
    // signal is live, proving the booby-trap actually distinguishes the two cases.
    const controller = new AbortController();
    await expect(recorder().recordUsage({
      token: 'invite-abc',
      peerId: '12D3KooWJoiner',
      strandId: 'strand-1',
      disclosure: '{}',
      signal: controller.signal
    })).rejects.toThrow('must not be reached');
  });
});
