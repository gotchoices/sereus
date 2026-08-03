import debug from 'debug';

import { OwnerNodeUnavailableError } from '../owner/owner-node-client.js';

import type {
  StrandHandlers,
  StrandListSnapshot,
  StrandRemovalResult,
} from './types.js';
import { StrandError } from './types.js';

const log = debug('cadre:host:strands');

/**
 * Minimal slice of the owner node that StrandService uses. Declared here (rather
 * than reaching into `OwnerNodeClient`) so unit tests can inject a fake without
 * standing up an admin channel — the third such trimmed interface the client
 * satisfies, alongside the trust-circle and NAT ones.
 */
export interface CadreNodeLike {
  listStrands(): Promise<StrandListSnapshot>;
  removeStrand(strandId: string, opts: { confirm: boolean }): Promise<StrandRemovalResult>;
}

/** Constructor options. */
export interface StrandServiceOptions {
  /** The owner node — provides listStrands / removeStrand over the admin channel. */
  cadreNode: CadreNodeLike;
}

/**
 * StrandService — validation and error translation over the owner node's strand
 * admin routes.
 *
 * It owns no state and makes no policy. In particular it does NOT decide whether a
 * closed strand needs confirmation: it never reads the row, so it could only guess.
 * The node enforces that rule and answers `confirmation_required`; this layer
 * forwards the caller's flag verbatim and surfaces the refusal as a distinct code
 * so the UI can raise the right dialog.
 */
export class StrandService {
  private readonly cadreNode: CadreNodeLike;

  constructor(opts: StrandServiceOptions) {
    this.cadreNode = opts.cadreNode;
  }

  /** This party's strands, plus the node's current control-connection count. */
  async list(): Promise<StrandListSnapshot> {
    return await this.cadreNode.listStrands().catch((err: unknown) => toDomainError(err));
  }

  /**
   * Remove this party's participation in one strand.
   *
   * `confirm` is forwarded exactly as given — never defaulted to true, never
   * re-sent as true after a refusal. A closed strand's row carries this party's
   * membership key for that network and is stored nowhere else, so an automatic
   * retry would destroy it on the caller's behalf.
   */
  async remove(rawId: string, opts: { confirm: boolean }): Promise<StrandRemovalResult> {
    const strandId = validateStrandId(rawId);
    log('remove %s (confirm=%s)', strandId, opts.confirm);
    return await this.cadreNode
      .removeStrand(strandId, { confirm: opts.confirm })
      .catch((err: unknown) => toDomainError(err));
  }
}

/**
 * Trim and reject an id this surface cannot act on. Blank is the only such id.
 *
 * A `/` is deliberately NOT refused. `/api/strands/:id` is one path segment, but a
 * caller that percent-encodes the id reaches this layer with the `/` restored
 * (Fastify decodes `params`), `OwnerNodeClient` re-encodes it, and the admin channel
 * splits on the still-encoded `%2F` and decodes it back — so the whole chain carries
 * it. Refusing here would break the only form that works, while doing nothing about
 * an UNencoded `/`, which never reaches this handler at all (the router 404s it).
 */
function validateStrandId(rawId: string): string {
  const strandId = typeof rawId === 'string' ? rawId.trim() : '';
  if (!strandId) {
    throw new StrandError('invalid_id', 'A strand id is required');
  }
  return strandId;
}

/**
 * Translate an owner-node failure into the strand error vocabulary.
 *
 * `OwnerNodeUnavailableError` is thrown for *every* non-ok admin response, not only
 * for a node that is down — so read `nodeCode` first and fall back to
 * `node_unavailable` only when nothing better fits. Reporting a 428 as "your node is
 * down" would be actively misleading.
 *
 * Declared to return `never` so callers can `.catch((err) => toDomainError(err))`.
 *
 * NOTE: the trust-circle and NAT services translate the SAME error blanket-style —
 * every `OwnerNodeUnavailableError` becomes `node_unavailable` — because neither has
 * a code worth distinguishing yet. If a second surface ever needs a code-aware
 * mapping, hoist this switch into a shared owner-error translator instead of growing
 * a third copy.
 */
function toDomainError(err: unknown): never {
  if (!(err instanceof OwnerNodeUnavailableError)) {
    throw err instanceof Error ? err : new Error(String(err));
  }
  switch (err.nodeCode) {
    case 'confirmation_required':
      throw new StrandError('confirmation_required', err.message);
    case 'bad_request':
      throw new StrandError('invalid_id', err.message);
    case undefined:
    case 'not_ready':
    case 'not_authorized':
      throw new StrandError('node_unavailable', `Owner node unavailable: ${err.message}`);
    default:
      throw new StrandError('internal', err.message);
  }
}

/**
 * Wrap a StrandService into the typed handler shape the local UI server mounts.
 * Errors propagate as StrandError; `server/error-handler.ts` maps `.code` → status.
 */
export function createStrandHandlers(service: StrandService): StrandHandlers {
  return {
    async listStrands() {
      return await service.list();
    },
    async removeStrand(strandId, opts) {
      return await service.remove(strandId, { confirm: opts.confirm === true });
    },
  };
}
