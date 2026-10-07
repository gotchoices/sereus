/**
 * Hosted-node types for cadre-host.
 *
 * A **hosted node** is a child process the host runs for some cadre. It gets into its
 * cadre one of two ways: the host starts it waiting to be claimed and shows its addresses
 * and claim secret as a QR code, which the owner's phone scans to claim the node
 * (`CadreNode.claimNode`); or the host starts it with a cadre invitation the owner's app
 * minted, which the node redeems at a member of the cadre. Either way the host holds no
 * owner key and is not an owner of any cadre its nodes serve.
 *
 * Records live in `<dataDir>/hosted-nodes.json` (`HostedNodeStore`). A record's id is also
 * its orchestrator container id and the name of its working directory.
 */

/**
 * Lifecycle of one hosted node:
 *   spawning   → the record is written, the child not yet spawned.
 *   unclaimed  → (claim) the child is up with a claim secret, waiting for a phone to claim it.
 *   joining    → (invitation) the child is up, its redemption of the invitation not yet settled.
 *   joined     → in its cadre: claimed, or the invitation accepted by a member.
 *   error      → the supervisor gave up on it, the stuck-`spawning` reap found it, or the
 *                invitation was refused or no member could be reached (`retryable` says which).
 *
 * Removal deletes the row; there is no terminal "removed" status. An `error` record keeps
 * its working directory (its identity key) until it is removed or reset.
 */
export type HostedNodeStatus = 'spawning' | 'unclaimed' | 'joining' | 'joined' | 'error';

/**
 * The node was started with a claim secret and waits for a phone to present it.
 */
export interface HostedNodeClaimJoin {
  kind: 'claim';
  /** The node's one-time claim secret, base64url. Only `claimDetails` ever returns it. */
  secret: string;
}

/**
 * The node was started with a cadre invitation and redeems it at a member of the cadre.
 * Kept for a respawn while `joining`: the child redeems again, and a member answers a node
 * that already got in as accepted.
 */
export interface HostedNodeInvitationJoin {
  kind: 'invitation';
  /**
   * The bundle as the owner's app encoded it (`encodeCadreInvitation`). It carries the
   * invitation's private key, so it is redacted like the claim secret.
   */
  encoded: string;
}

/** How a node gets into its cadre. */
export type HostedNodeJoin = HostedNodeClaimJoin | HostedNodeInvitationJoin;

/** One hosted node, as persisted in `hosted-nodes.json`. */
export interface HostedNode {
  /** `hn_<base64url of 12 random bytes>` — also the orchestrator container id and workdir name. */
  id: string;
  join: HostedNodeJoin;
  /**
   * A claim node: `unclaimed` (the placeholder party the child's config names) until the
   * claim reports the party; the claimant's party after. An invitation node: the
   * invitation's party from the start.
   */
  partyId: string;
  /** Hosted nodes run the `storage` profile: they participate in strands and are dialable. */
  profile: 'storage';
  status: HostedNodeStatus;
  /** Orchestrator handle (opaque `pid:token`), set once the child is spawned. */
  dockerId?: string;
  /** The child's loopback `/status` URL, from the spawn result. */
  statusEndpoint?: string;
  /** Read once from `/status`; the claim details need it before the claim. */
  peerId?: string;
  /**
   * Set when the node joins: `/status.node.claimedBy` for a claim, the invitation's issuer
   * key for an invitation. The UI shows its first 8 characters.
   */
  ownerKey?: string;
  /** An invitation node, once joined: the member that admitted it, when its address named one. */
  memberPeerId?: string;
  /** From the last status poll: the node holds at least one control connection. */
  connected?: boolean;
  /**
   * Respawn bookkeeping, owned by the supervisor's backoff. Absent until the first
   * respawn attempt. Not secret — it rides along in `HostedNodeView`.
   */
  respawn?: { attempts: number; lastAttemptAt: string };
  createdAt: string;
  updatedAt: string;
  /** Failure detail when `status === 'error'`. */
  error?: string;
  /**
   * Set with `error` when an invitation failed: whether Retry may start the node again with
   * the same invitation (no member could be reached), or the invitation itself was refused.
   * Absent on every other `error`.
   */
  retryable?: boolean;
}

/** `join` without its secret: what `list`, `get`, the routes and the events carry. */
export type HostedNodeJoinView = { kind: HostedNodeJoin['kind'] };

/** The wire shape of a hosted node: the record with the claim secret or the invitation stripped. */
export interface HostedNodeView extends Omit<HostedNode, 'join'> {
  join: HostedNodeJoinView;
}

/** On-disk shape of `hosted-nodes.json`. Keyed by node id. */
export interface HostedNodeFile {
  version: 1;
  nodes: Record<string, Omit<HostedNode, 'id'>>;
}

/** Error codes thrown by the hosted-node service, mapped to HTTP status by `server/error-handler.ts`. */
export type HostedNodeErrorCode =
  | 'not_found'           // 404 — no such hosted node
  | 'invalid_state'       // 409 — the operation does not apply to the node's current status
  | 'invalid_request'     // 400 — malformed input
  | 'node_unavailable'    // 503 — the child's /status does not answer yet
  | 'orchestrator_error'  // 500 — spawn / stop failure
  | 'storage_error';      // 500 — hosted-nodes.json read/write failure

/** Typed hosted-node error carrying a stable `code` for HTTP mapping. */
export class HostedNodeError extends Error {
  readonly code: HostedNodeErrorCode;

  constructor(code: HostedNodeErrorCode, message: string) {
    super(message);
    this.name = 'HostedNodeError';
    this.code = code;
  }
}

/**
 * What changed about a hosted node: `added` (a join started the node), `claimed` (the
 * watcher saw the claim), `joined` (the watcher saw a member accept the invitation),
 * `removed`, or `changed` (anything else: a respawn, a liveness change, a refused
 * invitation, a retry, a give-up). The server publishes each as the `hosted-nodes-changed`
 * SSE event.
 */
export type HostedNodeChangeKind = 'added' | 'claimed' | 'joined' | 'removed' | 'changed';

export interface HostedNodeChange {
  kind: HostedNodeChangeKind;
  id: string;
}

export type HostedNodeChangeListener = (change: HostedNodeChange) => void;
