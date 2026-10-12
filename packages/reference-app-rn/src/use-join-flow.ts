/**
 * use-join-flow.ts — the part of `useCadreInternal` behind Settings → "Join my existing cadre":
 * the join and the steps after it (moving this app's chats, removing the cadre it left), held as
 * a `JoinFlow` (`join-flow.ts`; docs/reference-app-rn.md → "Joining an Existing Cadre"). The
 * node it switches is `use-cadre.ts`'s, reached through the {@link JoinFlowHost} callbacks. Asking
 * an owner app on this phone by link, whose answer joins through this flow, is `use-link-request.ts`.
 */

import { useCallback, useRef, useState } from 'react';
import { decodeCadreInvitation } from '@serfab/cadre-core';
import type { CadreInvitation } from '@serfab/cadre-core';
import {
  getOwnerPublicKey,
  getRunningOptions,
  joinCadreByInvitation,
  identityPeerId,
  pendingStrandMove,
  finishStrandMove,
  dissolveFormerParty,
  FormerPartyNotEmptyError,
  StrandMoveNotOwnerError,
  StrandMovePendingError,
  type JoinCadreResult,
  type PhoneNodeOptions,
  type StrandMoveOutcome,
} from './cadre-phone';
import { flowForProgress, JoinCancelledError, type JoinFlow } from './join-flow';
import { acquireAndRegisterDeviceToken } from './push-wake-native';
import { useLinkRequest, type LinkRequestActions } from './use-link-request';

const RESPONSE_FOR_ANOTHER_APP = 'This response was made for another app. Copy this app\'s request again and ask for a new one.';

/** Why a strand move stopped short: the `move-incomplete` step's reason and message. */
type MoveStall = Pick<Extract<JoinFlow, { step: 'move-incomplete' }>, 'reason' | 'message'>;

/** What the flow needs of the hook that owns the node. Each must be stable across renders. */
export interface JoinFlowHost {
  /** Hold no node and show `connecting`: a join or a dissolve is stopping the running one. */
  holdNoNode: () => void;
  /** Take on whatever node the kit runs now (or none), after a transition the kit drove. */
  adoptRunningNode: () => void;
  /** Refill the Connect form. */
  setSavedStartOptions: (options: PhoneNodeOptions) => void;
  setError: (error: string | null) => void;
}

export interface JoinFlowActions extends LinkRequestActions {
  /**
   * Where "Join my existing cadre" is (`join-flow.ts`): set by {@link joinExistingCadre}, and
   * after a launch or Connect into a party whose join an earlier session left unfinished.
   * Null when nothing is on screen. Held in the hook, not in Settings, so it survives a tab switch.
   */
  joinFlow: JoinFlow | null;
  /**
   * Join the cadre a pasted response or invitation (`sereus-invite:1.…`) names, then move this
   * app's chats into it and remove the cadre it leaves, each step shown in {@link joinFlow}.
   * The kit's `PhoneNode.joinCadre` stops the node, starts it in the invitation's party and
   * redeems there, waiting for one of the members it lists to answer; needs no started node.
   *
   * Throws, with no flow left on screen and the app back in the cadre it ran before, when the
   * join itself does not happen: the decoder's error, a response made for another app's request,
   * the redemption's error (`describeJoinFailure` words them), or `JoinCancelledError` after
   * {@link cancelJoin}. Once a member admitted the app it does not throw: what is left to do
   * shows as a step.
   */
  joinExistingCadre: (encoded: string) => Promise<void>;
  /** Cancel the join while it waits for a member; does nothing once admitted, which the kit never rolls back. */
  cancelJoin: () => void;
  /** Adopt the chats a join left waiting, then remove the old cadre once none waits. Ignored while a step runs. */
  retryStrandMove: () => Promise<void>;
  /**
   * Remove the cadre this app founded and left; `discard` gives up the strand and join ids the
   * joined cadre does not hold. Ignored while a step runs.
   */
  removeOldCadre: (discard?: string[]) => Promise<void>;
  /** Keep the old cadre with what only it holds (the other answer to `confirm-discard`). */
  keepOldCadre: () => void;
  /** Clear the flow off the screen. */
  dismissJoinFlow: () => void;
}

export interface UseJoinFlowResult extends JoinFlowActions {
  /** Show the step a join an earlier session left unfinished, if any; called after each start. */
  resumeUnfinishedJoin: () => Promise<void>;
}

/**
 * Refuse, before anything stops, a response the owner app made from another app's request: the
 * members would refuse it too, but only after this app had left its own cadre to ask.
 */
async function refuseResponseForAnotherApp(invitation: CadreInvitation): Promise<void> {
  const target = invitation.invite.peerId;
  if (target && target !== await identityPeerId()) throw new Error(RESPONSE_FOR_ANOTHER_APP);
}

/** Why the move a join reported did not finish, or null when it did or there was none. */
function joinMoveStall(move: StrandMoveOutcome | undefined): MoveStall | null {
  if (!move || move.state === 'done') return null;
  if (move.state !== 'deferred') return { reason: 'partial' };
  if (move.reason === 'owner-key-not-wired') return { reason: 'owner-key-not-wired' };
  return { reason: 'adoption-failed', message: move.error.message };
}

/** Why `finishStrandMove` threw. */
function retryMoveStall(err: unknown): MoveStall {
  if (err instanceof StrandMoveNotOwnerError) return { reason: 'owner-key-not-wired' };
  console.warn('[use-join-flow] moving the strands failed:', err);
  return { reason: 'adoption-failed', message: err instanceof Error ? err.message : String(err) };
}

/**
 * Why a move the kit still records has not finished, when nothing reported it: this app's key is
 * not an owner of the joined party yet (the kit reports no owner key then), or an adoption failed.
 */
function recordedMoveStall(): MoveStall {
  return { reason: getOwnerPublicKey() === null ? 'owner-key-not-wired' : 'partial' };
}

/** The `move-incomplete` step, with the strands the kit's move record still lists. */
async function incompleteMoveFlow(moved: number, stall: MoveStall): Promise<JoinFlow> {
  let waiting: string[] = [];
  try {
    waiting = (await pendingStrandMove())?.strandIds ?? [];
  } catch (err) {
    // The step still shows, its count read as "some".
    console.warn('[use-join-flow] could not read the strands still waiting to move:', err);
  }
  return { step: 'move-incomplete', moved, waiting, ...stall };
}

/** The step a refused or failed `dissolveFormerParty` leaves the flow at. */
function flowAfterRefusedDissolve(err: unknown, moved: number): JoinFlow {
  if (err instanceof StrandMovePendingError) {
    return { step: 'move-incomplete', moved, waiting: err.pending.strandIds, ...recordedMoveStall() };
  }
  if (err instanceof FormerPartyNotEmptyError) {
    // Other machines may hold the old cadre's data, so they are never discarded from here.
    if (err.otherMachines.length > 0) return { step: 'old-cadre-kept', otherMachines: err.otherMachines };
    return { step: 'confirm-discard', strandIds: err.strandIds, pendingJoinIds: err.pendingJoinIds };
  }
  // NOTE: a removal that deleted the old cadre and then failed to start the joined party again
  // also lands here, so the line says the old cadre remains when it is gone (the Node card shows
  // the start's error). If restart failures show up in practice, check the saved start's
  // `formerPartyId` here to tell the two apart.
  console.warn('[use-join-flow] removing the old cadre failed:', err);
  return { step: 'old-cadre-remains', error: err instanceof Error ? err.message : String(err) };
}

/** The last step. Standing is read off the kit, which reports an owner key only once it is wired. */
function doneFlow(moved: number): JoinFlow {
  return { step: 'done', grantsOwner: getOwnerPublicKey() !== null, moved };
}

/** The steps during which the kit is joining, moving or removing; a button tapped twice must not queue another. */
function flowRunning(flow: JoinFlow | null): boolean {
  return flow !== null && ['joining', 'admitted', 'moving-strands', 'removing-old-cadre'].includes(flow.step);
}

export function useJoinFlow({ holdNoNode, adoptRunningNode, setSavedStartOptions, setError }: JoinFlowHost): UseJoinFlowResult {
  const [joinFlow, setJoinFlowState] = useState<JoinFlow | null>(null);
  // `joinFlow` as of now, for callbacks that must not act on a render's copy: a second Join,
  // and the launch check racing a join.
  const joinFlowRef = useRef<JoinFlow | null>(null);
  // Cancels the join; set while it waits for a member.
  const joinAbortRef = useRef<AbortController | null>(null);
  // Chats the join on screen has moved so far, for the `done` step. 0 when the flow resumed a
  // join an earlier session left, which recorded no count.
  const movedRef = useRef(0);

  const setJoinFlow = useCallback((flow: JoinFlow | null) => {
    joinFlowRef.current = flow;
    setJoinFlowState(flow);
  }, []);

  // A join an earlier session left unfinished, found once the node runs in the joined party:
  // the app was killed between the join's steps, or the user tapped Later. The old cadre is
  // still named as `formerPartyId` until it is removed.
  //
  // NOTE: an old cadre kept on purpose (it has other machines, or the user kept what only it
  // holds) is still named, so every Connect and launch shows it again, with Later to dismiss.
  // If that nags, remember the answer per old party in the node-local store.
  const resumeUnfinishedJoin = useCallback(async () => {
    if (joinFlowRef.current || getRunningOptions()?.formerPartyId === undefined) return;
    let waiting: string[] | undefined;
    try {
      waiting = (await pendingStrandMove())?.strandIds;
    } catch (err) {
      // Removing the old cadre reads the same record, and says what failed.
      console.warn('[use-join-flow] could not read the strand move a join left:', err);
    }
    if (joinFlowRef.current) return;
    movedRef.current = 0;
    setJoinFlow(waiting
      ? { step: 'move-incomplete', moved: 0, waiting, ...recordedMoveStall() }
      : { step: 'old-cadre-remains' });
  }, [setJoinFlow]);

  // A join or a dissolve stops the node at once and runs another (or the same party's again)
  // when it ends. Until then the hook holds none, so no screen writes through a stopped node.
  const showSwitching = useCallback((flow: JoinFlow) => {
    setJoinFlow(flow);
    holdNoNode();
  }, [setJoinFlow, holdNoNode]);

  // After a join or a dissolve: take on the node the kit runs now, and refill the Connect form
  // from its party, or Disconnect → Connect would start the party the form was filled from.
  const adoptSwitchedNode = useCallback(() => {
    adoptRunningNode();
    const running = getRunningOptions();
    if (running) setSavedStartOptions(running);
  }, [adoptRunningNode, setSavedStartOptions]);

  const dissolveOldCadre = useCallback(async (discard?: string[]) => {
    showSwitching({ step: 'removing-old-cadre' });
    let next: JoinFlow;
    try {
      await dissolveFormerParty(discard ? { discard } : undefined);
      next = doneFlow(movedRef.current);
    } catch (err) {
      next = flowAfterRefusedDissolve(err, movedRef.current);
    }
    adoptSwitchedNode();
    setJoinFlow(next);
  }, [showSwitching, adoptSwitchedNode, setJoinFlow]);

  // Admitted: finish the move the join reported, then remove the cadre the app left, as far as
  // each goes now; what is left shows as a step.
  const settleAfterJoin = useCallback(async (joined: JoinCadreResult) => {
    const move = joined.strandMove;
    movedRef.current = move && 'report' in move ? move.report.moved.length : 0;
    const stall = joinMoveStall(move);
    if (stall) {
      setJoinFlow(await incompleteMoveFlow(movedRef.current, stall));
    } else if (joined.formerPartyId !== undefined) {
      await dissolveOldCadre();
    } else {
      setJoinFlow(doneFlow(movedRef.current));
    }
  }, [setJoinFlow, dissolveOldCadre]);

  const joinExistingCadre = useCallback(async (encoded: string) => {
    const invitation = decodeCadreInvitation(encoded);
    await refuseResponseForAnotherApp(invitation);
    // After the last await before the flow is set, so two taps in one frame cannot both pass.
    if (joinFlowRef.current) throw new Error('A join is already on screen; finish it first.');
    const controller = new AbortController();
    joinAbortRef.current = controller;
    movedRef.current = 0;
    setError(null);
    showSwitching({ step: 'joining' });
    let joined: JoinCadreResult;
    try {
      joined = await joinCadreByInvitation(invitation, {
        signal: controller.signal,
        onProgress: (progress) => setJoinFlow(flowForProgress(progress)),
      });
    } catch (err) {
      setJoinFlow(null);
      throw controller.signal.aborted ? new JoinCancelledError() : err;
    } finally {
      joinAbortRef.current = null;
      adoptSwitchedNode();
    }
    await settleAfterJoin(joined);
    // As after a Connect: publish the device token, now in the joined party. After the old
    // cadre's removal, which restarts the node.
    void acquireAndRegisterDeviceToken();
  }, [setError, showSwitching, setJoinFlow, adoptSwitchedNode, settleAfterJoin]);

  const cancelJoin = useCallback(() => {
    if (joinFlowRef.current?.step === 'joining') joinAbortRef.current?.abort();
  }, []);

  const removeOldCadre = useCallback(async (discard?: string[]) => {
    if (!flowRunning(joinFlowRef.current)) await dissolveOldCadre(discard);
  }, [dissolveOldCadre]);

  // The move runs on the running node; nothing stops.
  const retryStrandMove = useCallback(async () => {
    if (flowRunning(joinFlowRef.current)) return;
    setJoinFlow({ step: 'moving-strands' });
    let report: Awaited<ReturnType<typeof finishStrandMove>>;
    try {
      report = await finishStrandMove();
    } catch (err) {
      setJoinFlow(await incompleteMoveFlow(movedRef.current, retryMoveStall(err)));
      return;
    }
    // The adoption seated strands, and wired the owner key when it was not yet.
    adoptRunningNode();
    // `moved` counts every strand seated so far, those an earlier attempt seated included.
    if (report) movedRef.current = report.moved.length;
    if (report && report.failed.length > 0) {
      setJoinFlow(await incompleteMoveFlow(movedRef.current, { reason: 'partial' }));
    } else {
      await dissolveOldCadre();
    }
  }, [setJoinFlow, adoptRunningNode, dissolveOldCadre]);

  const keepOldCadre = useCallback(() => {
    setJoinFlow({ step: 'old-cadre-kept', otherMachines: [] });
  }, [setJoinFlow]);

  const dismissJoinFlow = useCallback(() => {
    setJoinFlow(null);
  }, [setJoinFlow]);

  const linkRequestActions = useLinkRequest(joinFlowRef, joinExistingCadre);

  return {
    joinFlow, joinExistingCadre, cancelJoin, retryStrandMove, removeOldCadre, keepOldCadre, dismissJoinFlow,
    resumeUnfinishedJoin, ...linkRequestActions,
  };
}
