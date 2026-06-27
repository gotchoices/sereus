/**
 * Minimal `node:cluster` shim for the NativeScript runtime.
 *
 * `mortice` (libp2p PersistentPeerStore write lock) imports `cluster` and, in
 * its primary/single-process path, reads `cluster.isPrimary` and registers
 * `cluster.on('message', …)` to service lock requests from worker processes.
 * The previous webpack fallback stubbed `cluster` to an empty module, so
 * `cluster.on` was undefined and the lock threw on Connect.
 *
 * A NativeScript app is always a single primary process with no cluster
 * workers, so report `isPrimary` and make the listener registrations no-ops —
 * no worker will ever message us; locking stays in-process via mortice's
 * in-memory emitter. Pairs with the BroadcastChannel polyfill the same path uses.
 */

const cluster = {
	isPrimary: true,
	isMaster: true,
	isWorker: false,
	on(): void {},
	once(): void {},
	off(): void {},
	addListener(): void {},
	removeListener(): void {},
};

export default cluster;
