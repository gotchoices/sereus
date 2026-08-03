/**
 * Strand-management types for cadre-host.
 *
 * A *strand* is a shared data network this party participates in. Membership is
 * canonical in the cadre control network's `Strand` table, reached over the owner
 * node's loopback admin channel (`GET /admin/strands`,
 * `DELETE /admin/strands/:id?confirm=1`).
 *
 * Unlike the trust circle — which layers host-local labels and pending invites on
 * top of the node's state — this layer holds **no host-local state at all**. There
 * is no `strands.json`. It exists for id validation, for translating the admin
 * channel's error codes into a stable vocabulary the management API can map to HTTP
 * statuses, and for nothing else. Keep it small.
 */

/** One strand this party belongs to, as projected by the admin channel. */
export interface StrandSummary {
  /** The `Strand` row id — what a removal takes. */
  id: string;
  /** `'o'` = open, `'c'` = closed (the row carries this party's membership key). */
  type: 'o' | 'c';
  /** Whether the owner node currently has a running instance for the id. */
  running: boolean;
  /**
   * The instance's status when running, else `null`. Deliberately `string` rather
   * than cadre-core's `StrandStatus`: this is a wire projection the manager only
   * forwards, and widening it keeps cadre-host from tracking a cadre-core union it
   * never inspects.
   */
  status: string | null;
}

/** The result of listing this party's strands. */
export interface StrandListSnapshot {
  strands: StrandSummary[];
  /**
   * Open control-network connections on the owner node; 0 ⇒ writes commit
   * local-only. A snapshot at read time, not a subscription — treat it as advisory.
   */
  controlConnections: number;
}

/** The result of removing this party's participation in one strand. */
export interface StrandRemovalResult {
  /** The trimmed id the call was about. */
  strandId: string;
  /** Whether a row existed before the write. */
  published: boolean;
  /** The found row's type; `null` when no row was found. */
  type: 'o' | 'c' | null;
  /**
   * Whether THIS call issued the delete — not that the row was observed to vanish.
   * The node's read and write are not atomic, so a concurrent removal landing in
   * between makes this a no-op that still reports `true`.
   */
  removed: boolean;
  /**
   * The node saw 0 control connections at the end of the call. Sampled on EVERY
   * call, including one that found no row and wrote nothing — read it as "this
   * machine currently sees no siblings", and only as "your delete may not have
   * travelled" when `removed` is also true.
   */
  alone: boolean;
}

/** Error codes thrown by StrandService. */
export type StrandErrorCode =
  /** The id was blank or whitespace-only, here or at the node. */
  | 'invalid_id'
  /** The node refused a closed-strand removal that carried no confirmation. */
  | 'confirmation_required'
  /** The owner node's admin channel is unreachable / not ready. */
  | 'node_unavailable'
  /** The node answered with a code this layer has no better word for. */
  | 'internal';

/** Typed error carrying a stable `code` for HTTP mapping. */
export class StrandError extends Error {
  readonly code: StrandErrorCode;

  constructor(code: StrandErrorCode, message: string) {
    super(message);
    this.name = 'StrandError';
    this.code = code;
  }
}

/**
 * Typed handlers exposed to the local UI server for Fastify wiring.
 *
 * Handlers either return typed results or throw a `StrandError` whose `.code`
 * `server/error-handler.ts` maps to an HTTP status:
 *
 *   - `invalid_id`            → 400
 *   - `confirmation_required` → 428
 *   - `node_unavailable`      → 503
 *   - `internal`              → 500
 */
export interface StrandHandlers {
  listStrands(): Promise<StrandListSnapshot>;
  removeStrand(strandId: string, opts: { confirm: boolean }): Promise<StrandRemovalResult>;
}
