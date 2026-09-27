/**
 * Integration test harness exports
 */

export * from './types.js';
export * from './port-allocator.js';
export * from './wait-utils.js';
export * from './error-chain.js';
export * from './test-party.js';
export * from './test-network.js';
export * from './node-fixtures.js';
export * from './formation-mocks.js';
export * from './slow-raw-storage.js';
export * from './child-node-fixtures.js';
export * from './peer-dial-gate.js';
export * from './control-trio.js';
export * from './test-cadre-host.js';
export * from './forced-cluster.js';
export * from './control-cohort.js';
export * from './topology.js';
export * from './strand-join.js';
export * from './block-store-probe.js';
export * from './dedicated-relay.js';
// The relay round-trip measurement's instruments (`scenarios/relay-round-trip-measure`):
// a per-link counting TCP proxy with the gater that keeps a node from dialing around
// it, and a per-protocol outbound stream counter. Importing either instruments
// nothing until it is called.
export * from './counting-proxy.js';
export * from './stream-counter.js';
// Safe in the barrel: importing it instruments nothing unless `installWsLatency` is called
// or one of its environment variables is set, and those are process-wide by intent.
export * from './ws-latency.js';
export * from './provider-process-orchestrator.js';
export * from './fixtures/loopback-http-server.js';
export * from './fixtures/approval-hook-server.js';
// build-freshness moved to the repo-root `test-harness/`, shared with other
// packages' suites; `test/global-setup.ts` is its only importer and reaches it
// directly, so it is deliberately not re-exported here.

