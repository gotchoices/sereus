/**
 * The host's `bootstrapNodes` rule — the requester addresses a donated node is
 * started with — exercised directly.
 *
 * This is one half of a **manual tripwire**: cadre-provider carries a
 * byte-identical copy of this rule
 * (`packages/cadre-provider/src/server/bootstrap-node-validation.ts`) and the table
 * below is the same table
 * `packages/cadre-provider/src/server/__tests__/bootstrap-node-validation.test.ts`
 * pins that copy to. Neither suite can observe the other package — nothing here
 * imports cadre-provider's server module — so this does not detect a change made
 * over there; what it does is fail if *this* copy is changed, which is how an
 * editor is landed on the comment pointing at the other one.
 *
 * The route contract (`POST /grants` → 400, nothing provisioned) lives in
 * `grants-route.test.ts`, next to the rest of that route's HTTP behaviour.
 */

import { describe, it, expect } from 'vitest';

import { validateBootstrapNodes } from '../routes/bootstrap-node-validation.js';

/**
 * A real, decodable peer id. Placeholder strings like `12D3KooReq` look right and
 * are not: `peerIdFromString` throws `Incorrect length` on them, which is exactly
 * the typo this rule exists to catch.
 */
const PEER = '12D3KooWA9hbnKrRnPRSPTRkzXqTHzGE8YpJ3JHZmQ5tGwLRTMmp';
const GOOD = `/ip4/127.0.0.1/tcp/4001/p2p/${PEER}`;
/** A second, distinct dialable address, for "which entry was bad" assertions. */
const GOOD_2 = `/dns4/bootstrap.example/tcp/443/wss/p2p/${PEER}`;

describe('validateBootstrapNodes (the host copy of the address rule)', () => {
  function errorOf(value: unknown): string {
    const result = validateBootstrapNodes(value);
    if (!('error' in result)) throw new Error(`expected a rejection, got ${JSON.stringify(result)}`);
    return result.error;
  }

  it('accepts a dialable address and returns it trimmed', () => {
    expect(validateBootstrapNodes([`  ${GOOD}\n`])).toEqual({ nodes: [GOOD] });
  });

  it('accepts several dialable addresses across transports', () => {
    expect(validateBootstrapNodes([GOOD, GOOD_2])).toEqual({ nodes: [GOOD, GOOD_2] });
  });

  it('accepts a relayed address whose relay and target peer ids both decode', () => {
    const relayed = `/ip4/1.2.3.4/tcp/4001/p2p/${PEER}/p2p-circuit/p2p/${PEER}`;
    expect(validateBootstrapNodes([relayed])).toEqual({ nodes: [relayed] });
  });

  it('treats an absent field and an empty list alike: the field is required', () => {
    expect(errorOf(undefined)).toBe('bootstrapNodes is required');
    expect(errorOf([])).toBe('bootstrapNodes is required');
  });

  it('rejects a non-array, and an array with a non-string element', () => {
    expect(errorOf(GOOD)).toBe('bootstrapNodes must be an array of strings');
    expect(errorOf(null)).toBe('bootstrapNodes must be an array of strings');
    expect(errorOf([42])).toBe('bootstrapNodes must be an array of strings');
    expect(errorOf([GOOD, { addr: GOOD }])).toBe('bootstrapNodes must be an array of strings');
  });

  it('rejects an empty or whitespace-only entry with the blank-value message', () => {
    for (const blank of ['', '   ', '\t\n']) {
      expect(errorOf([blank])).toMatch(/must not be empty or whitespace-only/);
    }
  });

  // Case 1: `@libp2p/bootstrap` maps `multiaddr()` over the list before filtering,
  // so this one throws during libp2p construction and the child never starts.
  it('rejects a string that is not a multiaddr, naming it', () => {
    for (const bad of ['not-an-address', '42', 'bootstrap.example:4001']) {
      const message = errorOf([bad]);
      expect(message).toMatch(/must be multiaddrs/);
      expect(message).toContain(bad);
    }
  });

  // Case 2: the quiet one — parses, then gets filtered out inside the child and
  // the node comes up healthy-looking with zero bootstrap peers.
  it('rejects a valid multiaddr with no /p2p/ component, naming it', () => {
    const message = errorOf(['/ip4/127.0.0.1/tcp/4001']);
    expect(message).toMatch(/must include a \/p2p\/<peerId> component/);
    expect(message).toContain('/ip4/127.0.0.1/tcp/4001');
  });

  // Case 3: `multiaddr()` does not validate the /p2p/ value; `peerIdFromString`
  // does, and throws inside the child's libp2p construction.
  it('rejects a /p2p/ component whose peer id does not decode, naming the entry and the id', () => {
    const bad = '/ip4/127.0.0.1/tcp/4001/p2p/12D3KooReq';
    const message = errorOf([bad]);
    expect(message).toMatch(/must carry a decodable peer id/);
    expect(message).toContain(bad);
    expect(message).toContain('12D3KooReq');
  });

  it('rejects a relayed address whose relay peer id does not decode', () => {
    expect(errorOf([`/ip4/1.2.3.4/tcp/4001/p2p/12D3KooReq/p2p-circuit/p2p/${PEER}`]))
      .toMatch(/must carry a decodable peer id/);
  });

  it('names the offending entry when only one address in a batch is bad', () => {
    const message = errorOf([GOOD, '/ip4/10.0.0.9/tcp/4001', GOOD_2]);
    expect(message).toContain('/ip4/10.0.0.9/tcp/4001');
  });

  // A requester must not be able to turn one junk string into a megabyte of log line.
  it('caps the echoed value for an over-long rejected address', () => {
    const message = errorOf([`/ip4/1.2.3.4/tcp/${'9'.repeat(5000)}`]);
    expect(message).toContain('chars)');
    expect(message.length).toBeLessThan(400);
  });
});
