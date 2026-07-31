import { describe, it, expect } from 'vitest';
import { ControlFormationUsageRecorder } from '../src/control-formation-recorder.js';
import { FormationAbortedError, type ControlDatabase } from '../src/control-database.js';
import { FormationApprovalError, type FormationApprover } from '../src/formation-approval.js';

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

/**
 * The minimum database surface a redemption touches once its signal is still live: an invite
 * that DEMANDS approval, plus the nonce mint. `onInviteRead` is the seam a test uses to abort
 * at the one moment `obtainApproval`'s own check covers — after the read, before the ask.
 */
function approvalDemandingDatabase(onInviteRead?: () => void): ControlDatabase {
  return {
    queryFormationInvite: async (token: string) => {
      onInviteRead?.();
      return {
        token, sAppId: 'sapp-1', expiresAtMs: null, totalUses: null,
        validationUrl: 'https://hook.example/approve', strandId: null,
      };
    },
    recordFormationUsage: async () => { throw new Error('recordFormationUsage must not be reached'); },
  } as unknown as ControlDatabase;
}

const REDEMPTION = {
  token: 'invite-abc', peerKey: 'joiner-pub-key', peerSignature: 'joiner-consent-sig',
  usageStampId: 'stamp-1', strandId: 'strand-1', disclosure: '{}',
};

describe('ControlFormationUsageRecorder abort plumbing', () => {
  it('recordUsage rejects a pre-aborted signal before reading the invite', async () => {
    const error = await recorder().recordUsage({
      token: 'invite-abc',
      peerKey: 'joiner-pub-key',
      peerSignature: 'joiner-consent-sig',
      usageStampId: 'stamp-1',
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
      peerKey: 'joiner-pub-key',
      peerSignature: 'joiner-consent-sig',
      usageStampId: 'stamp-1',
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
      peerKey: 'joiner-pub-key',
      peerSignature: 'joiner-consent-sig',
      usageStampId: 'stamp-1',
      strandId: 'strand-1',
      disclosure: '{}',
      signal: controller.signal
    })).rejects.toThrow('must not be reached');
  });

  it('rejects an abort observed between the invite read and the approval ask', async () => {
    const controller = new AbortController();
    let asks = 0;
    const approver: FormationApprover = {
      requestApproval: async () => { asks += 1; throw new Error('unreachable'); }
    };
    const subject = new ControlFormationUsageRecorder(
      approvalDemandingDatabase(() => controller.abort()),
      { approver }
    );

    await expect(subject.recordUsage({ ...REDEMPTION, signal: controller.signal }))
      .rejects.toThrow(FormationAbortedError);
    // The hook is where an approval is SPENT (a review queue charges a human for it), so the
    // check before the ask is not merely an optimisation.
    expect(asks).toBe(0);
  });

  it('re-labels a caller-abort during the approval ask as FormationAbortedError', async () => {
    // A relayed caller-abort reaches the recorder as an `unavailable` FormationApprovalError,
    // which the manager would MAP to a rejection reason and return; only the aborted class
    // makes it rethrow and leave the reply to the listener's timeout path.
    let entered!: () => void;
    const asked = new Promise<void>((resolve) => { entered = resolve; });
    const approver: FormationApprover = {
      requestApproval: (_request, signal) => new Promise((_resolve, reject) => {
        entered();
        signal?.addEventListener('abort', () => reject(
          new FormationApprovalError('unavailable', 'Formation was cancelled while the hook was being asked')
        ));
      })
    };
    const controller = new AbortController();
    const subject = new ControlFormationUsageRecorder(approvalDemandingDatabase(), { approver });

    const pending = subject.recordUsage({ ...REDEMPTION, signal: controller.signal });
    await asked;
    controller.abort();

    const error = await pending.then(
      () => { throw new Error('expected recordUsage to reject'); },
      (caught: unknown) => caught
    );
    expect(error).toBeInstanceOf(FormationAbortedError);
    // The transport-level detail is kept rather than swallowed.
    expect((error as Error).cause).toBeInstanceOf(FormationApprovalError);
  });
});
