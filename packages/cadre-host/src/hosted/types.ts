/**
 * Hosted-node types for cadre-host.
 *
 * A **hosted node** is a child process the host runs for some cadre. The host starts it
 * waiting to be claimed and shows its addresses and claim secret as a QR code; the
 * owner's phone scans it, claims the node (`CadreNode.claimNode`), and the node becomes
 * part of that phone's cadre. The node belongs to whoever claims it; the host holds no
 * owner key and is not an owner of any cadre its nodes serve.
 *
 * Records live in `<dataDir>/hosted-nodes.json` (`HostedNodeStore`). A record's id is also
 * its orchestrator container id and the name of its working directory.
 */

/**
 * Lifecycle of one hosted node:
 *   spawning   → the record is written, the child not yet spawned.
 *   unclaimed  → the child is up with a claim secret, waiting for a phone to claim it.
 *   joined     → claimed; the claim named the party and the owner.
 *   error      → the supervisor gave up on it, or the stuck-`spawning` reap found it.
 *
 * Removal deletes the row; there is no terminal "removed" status. An `error` record keeps
 * its working directory (its identity key) until it is removed or reset.
 */
export type HostedNodeStatus = 'spawning' | 'unclaimed' | 'joined' | 'error';

/**
 * How a node gets into its cadre. `claim`: the node was started with a claim secret and
 * waits for a phone to present it. (`cadre-host-join-by-invitation` adds a second kind.)
 */
export interface HostedNodeClaimJoin {
  kind: 'claim';
  /** The node's one-time claim secret, base64url. Only `claimDetails` ever returns it. */
  secret: string;
}

export type HostedNodeJoin = HostedNodeClaimJoin;

/** One hosted node, as persisted in `hosted-nodes.json`. */
export interface HostedNode {
  /** `hn_<base64url of 12 random bytes>` — also the orchestrator container id and workdir name. */
  id: string;
  join: HostedNodeJoin;
  /**
   * `unclaimed` (the placeholder party the child's config names) until the claim reports
   * the party; the claimant's party after.
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
  /** `/status.node.claimedBy` once claimed; the UI shows its first 8 characters. */
  ownerKey?: string;
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
}

/** `join` without its secret: what `list`, `get`, the routes and the events carry. */
export type HostedNodeJoinView = { kind: HostedNodeJoin['kind'] };

/** The wire shape of a hosted node: the record with the claim secret stripped. */
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
 * What changed about a hosted node: `added` (a join finished and the node waits to be
 * claimed), `claimed` (the watcher saw the claim), `removed`, or `changed` (anything else:
 * a respawn, a liveness change, a give-up). The server publishes each as the
 * `hosted-nodes-changed` SSE event.
 */
export type HostedNodeChangeKind = 'added' | 'claimed' | 'removed' | 'changed';

export interface HostedNodeChange {
  kind: HostedNodeChangeKind;
  id: string;
}

export type HostedNodeChangeListener = (change: HostedNodeChange) => void;
