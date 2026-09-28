import { describe, it, expect } from 'vitest';
import type { CircuitRelayServerInit } from '@libp2p/circuit-relay-v2';
import {
  PARTY_RELAY_MAX_RESERVATIONS,
  PARTY_RELAY_RESERVATION_TTL_MS,
  resolveRelayServer
} from '../src/relay-server.js';

/**
 * A party-run relay must forward without libp2p's 128 KiB / 2 min per-connection cap
 * unless the embedder asks for it back — and an embedder tuning one reservation key must
 * not re-arm the cap by accident. That is a MERGE, pinned here case by case; that the
 * resolved init actually reaches each node kind is pinned beside each build site
 * (`cadre-node-control-node-options.spec.ts`, `strand-instance-manager-cluster-size.spec.ts`).
 */
describe('resolveRelayServer init', () => {
  const defaults = {
    applyDefaultLimit: false,
    maxReservations: PARTY_RELAY_MAX_RESERVATIONS,
    reservationTtl: PARTY_RELAY_RESERVATION_TTL_MS
  };

  it.each<[string, CircuitRelayServerInit | undefined, CircuitRelayServerInit]>([
    ['no override: limit off, party-sized store, 2 h TTL', undefined, { reservations: defaults }],
    ['only maxReservations: the limit stays off', { reservations: { maxReservations: 20 } }, { reservations: { ...defaults, maxReservations: 20 } }],
    ['applyDefaultLimit: true turns libp2p\'s cap back on', { reservations: { applyDefaultLimit: true } }, { reservations: { ...defaults, applyDefaultLimit: true } }],
    ['reservationTtl reaches the resolved TTL', { reservations: { reservationTtl: 60_000 } }, { reservations: { ...defaults, reservationTtl: 60_000 } }],
    ['an undefined key counts as unset', { reservations: { applyDefaultLimit: undefined } }, { reservations: defaults }],
    ['other top-level keys pass through as given', { hopTimeout: 5_000 }, { hopTimeout: 5_000, reservations: defaults }]
  ])('%s', (_label, relayServerInit, expected) => {
    expect(resolveRelayServer({ relayServerInit }, 'storage').init).toEqual(expected);
  });
});
