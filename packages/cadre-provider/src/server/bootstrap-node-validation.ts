/**
 * Shape validation for the tenant-supplied `bootstrapNodes` of `POST /containers`
 * — the control-network addresses the created node is started with as
 * `CADRE_BOOTSTRAP_NODES`, and which it hands to `@libp2p/bootstrap`.
 *
 * Its own module rather than part of `routes.ts`: the rule is a duplicate of
 * cadre-host's copy (`packages/cadre-host/src/server/routes/bootstrap-node-validation.ts`),
 * so it is worth reading, testing and changing on its own, without a routing file
 * around it. Same arrangement, and same reasons, as `owner-key-validation.ts`.
 *
 * ## The rule, and why each clause is there
 *
 * An entry is usable exactly when it is a string, parses as a multiaddr, carries
 * a `/p2p/<peerId>` component, and that peer id decodes. Each clause corresponds
 * to a distinct downstream failure the caller would otherwise never be told about
 * — the value is forwarded verbatim into the spawned child, so every one of these
 * surfaces inside a container the caller cannot see:
 *
 * - **Not parsable as a multiaddr → the child dies at boot.** `@libp2p/bootstrap`'s
 *   constructor maps `multiaddr()` over the whole list *before* filtering anything,
 *   and `multiaddr()` throws on a string that does not start with `/` (and on a
 *   non-string outright). libp2p construction throws and the node never starts.
 * - **No `/p2p/<peerId>` → the node starts and never joins.** The quiet one.
 *   `/ip4/127.0.0.1/tcp/4001` parses fine, then `@libp2p/bootstrap` filters it out
 *   ("invalid bootstrap multiaddr without peer id", logged inside the child) and
 *   the node comes up with *zero* bootstrap peers: healthy-looking, permanently
 *   alone, never reaching the party it was created for. cadre-core's
 *   `getBootstrapPeerIds` (`packages/cadre-core/src/cadre-node.ts`) skips such an
 *   entry silently for the same reason.
 * - **Malformed peer id → the child dies at boot.** `multiaddr()` does *not*
 *   validate the `/p2p/` value — parsing `/ip4/1.2.3.4/tcp/1/p2p/12D3KooReq` yields
 *   a `p2p` component whose value is the junk string unchanged — but
 *   `@libp2p/bootstrap` then calls `peerIdFromString` on it, unguarded, and it
 *   throws `Incorrect length`. A truncated copy-paste of a 52-character peer id is
 *   the likeliest human typo in this field.
 *
 * The peer id is read the way `@libp2p/bootstrap` reads it — the `p2p` components
 * of `getComponents()` — rather than through the deprecated `getPeerId()`, so the
 * two cannot disagree about which part of the address is the peer. Bootstrap uses
 * only the *last* `p2p` component; this checks **every** one, so the relay half of
 * a `…/p2p/<relay>/p2p-circuit/p2p/<target>` address must decode too. An address
 * naming an undecodable relay is not dialable either, and bootstrap's own
 * `P2P.matches` filter accepts any address carrying a `p2p` component, so nothing
 * this accepts is dropped there.
 *
 * Requiring a multiaddr also closes a downstream ambiguity: `service/container-env.ts`
 * joins the list with `,` into `CADRE_BOOTSTRAP_NODES`, and cadre-cli's env loader
 * splits it back on `,`. An entry containing a comma would silently become two
 * addresses; a multiaddr contains no comma, so the rule below is what makes that
 * join lossless.
 *
 * Reachability is deliberately NOT checked: a well-formed address for a peer that
 * happens to be down is indistinguishable here from one that is up, and no
 * boundary check can tell them apart. This validates the *shape* the child must be
 * able to parse, nothing more.
 *
 * Keeping the two copies in step is **manual** — neither package can see the
 * other's rule, so no test can compare them. What the tests give instead is a
 * tripwire on each side: `__tests__/bootstrap-node-validation.test.ts` here and
 * `packages/cadre-host/src/server/__tests__/bootstrap-node-validation.test.ts`
 * there each pin their own copy to the same accept/reject table, so changing
 * either rule fails that package's own suite — and the comment above the rule you
 * just changed is what points at the other copy.
 */

import debug from 'debug';
import { CODE_P2P, multiaddr, type Multiaddr } from '@multiformats/multiaddr';
import { peerIdFromString } from '@libp2p/peer-id';

const log = debug('cadre:provider:bootstrap-nodes');

/**
 * Longest rejected address echoed back in an error message. Generous compared to
 * the owner-key limit because a legitimate address is long: a plain
 * `/ip4/…/tcp/…/p2p/<52 chars>` runs ~80 characters and a relayed
 * `…/p2p-circuit/p2p/<52 chars>` about 150, so a smaller cap would truncate the
 * very values an operator needs to read back.
 */
const REJECTED_ADDRESS_ECHO_LIMIT = 192;

/**
 * Render a rejected address for an error message, capped: `bootstrapNodes`
 * arrives from a caller over the network, so an unbounded echo would let one junk
 * string become a megabyte of log line.
 */
function describeRejectedAddress(value: string): string {
  return value.length <= REJECTED_ADDRESS_ECHO_LIMIT
    ? value
    : `${value.slice(0, REJECTED_ADDRESS_ECHO_LIMIT)}… (${value.length} chars)`;
}

/** The message of a thrown parse/decode failure, whatever the thrower used. */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Apply the rule above to one entry. Returns the trimmed value, so the create
 * request carries exactly what was validated.
 */
function validateBootstrapNode(value: string): { node: string } | { error: string } {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return { error: 'bootstrapNodes entries must not be empty or whitespace-only' };
  }

  let address: Multiaddr;
  try {
    address = multiaddr(trimmed);
  } catch (error) {
    log('rejecting bootstrapNodes entry: %s', reasonOf(error));
    return {
      error: `bootstrapNodes entries must be multiaddrs (could not parse "${describeRejectedAddress(trimmed)}": ${reasonOf(error)})`,
    };
  }

  const peerIds = address.getComponents().filter(component => component.code === CODE_P2P);
  if (peerIds.length === 0) {
    return {
      error: `bootstrapNodes entries must include a /p2p/<peerId> component ("${describeRejectedAddress(trimmed)}" names no peer, so the node would drop it and start with no bootstrap peers)`,
    };
  }

  for (const { value } of peerIds) {
    try {
      peerIdFromString(value ?? '');
    } catch (error) {
      log('rejecting bootstrapNodes peer id: %s', reasonOf(error));
      return {
        error: `bootstrapNodes entries must carry a decodable peer id ("${describeRejectedAddress(trimmed)}" names peer "${describeRejectedAddress(value ?? '')}", which does not decode: ${reasonOf(error)})`,
      };
    }
  }

  return { node: trimmed };
}

/**
 * Validate the required `bootstrapNodes` field of a create request: a non-empty
 * array of dialable control-network addresses (see {@link validateBootstrapNode}).
 *
 * Create is the last point at which the caller can still fix a typo, so the shape
 * is checked here: without it a bad address is answered 201 and then produces a
 * container that either dies at boot or comes up permanently alone — the caller
 * learning about it, if ever, from container status rather than from a 400 naming
 * the bad address.
 *
 * Every rejection names the offending entry: with several addresses in one
 * request the message is the only thing that says WHICH one.
 *
 * @returns the trimmed addresses, so the create request carries exactly what was validated.
 */
export function validateBootstrapNodes(value: unknown): { nodes: string[] } | { error: string } {
  if (value === undefined || (Array.isArray(value) && value.length === 0)) {
    return { error: 'bootstrapNodes is required' };
  }
  if (!Array.isArray(value) || !value.every((entry): entry is string => typeof entry === 'string')) {
    return { error: 'bootstrapNodes must be an array of strings' };
  }

  const nodes: string[] = [];
  for (const entry of value) {
    const checked = validateBootstrapNode(entry);
    if ('error' in checked) return checked;
    nodes.push(checked.node);
  }
  return { nodes };
}
