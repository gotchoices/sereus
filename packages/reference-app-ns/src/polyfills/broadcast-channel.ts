/**
 * Single-process `BroadcastChannel` stand-in for the NativeScript runtime.
 *
 * `mortice` (the async mutex behind libp2p's PersistentPeerStore write lock)
 * constructs a `BroadcastChannel` in its primary/single-process path to
 * coordinate locks across processes/workers. The NS V8/JSC runtime has no
 * `BroadcastChannel`, so the peer-store lock throws on the first patch (Connect).
 *
 * A NativeScript app is a single JS context with no sibling processes or
 * workers, so a no-op channel is correct: intra-process locking runs entirely
 * through mortice's in-memory emitter, and there is no peer context for
 * `postMessage` to reach. Guarded so a future native implementation wins.
 */

import { markPolyfilled } from './registry';

class NSBroadcastChannel {
	readonly name: string;
	onmessage: ((event: unknown) => void) | null = null;
	onmessageerror: ((event: unknown) => void) | null = null;

	constructor(name: string) {
		this.name = name;
	}

	postMessage(_message: unknown): void {
		// No other context exists in a single-process NativeScript app.
	}

	addEventListener(): void {}
	removeEventListener(): void {}
	dispatchEvent(): boolean {
		return false;
	}

	close(): void {}
	/** mortice calls `channel.unref?.()`; present so the optional call is a no-op. */
	unref(): void {}
}

const g = globalThis as unknown as { BroadcastChannel?: unknown };
if (typeof g.BroadcastChannel === 'undefined') {
	g.BroadcastChannel = NSBroadcastChannel;
	markPolyfilled('BroadcastChannel');
}
