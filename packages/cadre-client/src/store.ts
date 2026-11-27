/**
 * The store primitive cadre screens bind to: the Svelte store contract — `subscribe(fn)`
 * calls `fn` at once with the current value and returns an unsubscribe function — plus
 * `get()`, with two rules:
 *
 * - `get()` returns the same object until the value changes. React's
 *   `useSyncExternalStore` re-renders whenever the snapshot is a new object, so a store
 *   that rebuilt its value on every read would loop.
 * - Reference-counted: `start` runs when the first subscriber arrives and the function it
 *   returns runs when the last one leaves, so a store costs nothing while nothing shows it.
 *
 * Binding: Svelte uses a store directly (`$store`); React through
 * `useSyncExternalStore(store.subscribe, store.get)`; NativeScript by copying each value
 * into an `Observable` from `subscribe`. Self-contained on purpose, so the package
 * depends on nothing but cadre-core; an app with its own store type of the same contract
 * binds these the same way.
 */

export interface Readable<T> {
	subscribe(run: (value: T) => void): () => void;
	get(): T;
}

export interface Writable<T> extends Readable<T> {
	set(value: T): void;
	update(fn: (value: T) => T): void;
}

export type StartStop<T> = (set: (value: T) => void, update: (fn: (value: T) => T) => void) => void | (() => void);

export function writable<T>(initial: T, start?: StartStop<T>): Writable<T> {
	let value = initial;
	let stop: (() => void) | void = undefined;
	const subscribers = new Set<(value: T) => void>();

	const set = (next: T) => {
		if (Object.is(next, value)) return;
		value = next;
		for (const run of [...subscribers]) run(value);
	};
	const update = (fn: (value: T) => T) => set(fn(value));

	return {
		get: () => value,
		set,
		update,
		subscribe(run) {
			subscribers.add(run);
			if (subscribers.size === 1 && start) stop = start(set, update);
			run(value);
			return () => {
				if (!subscribers.delete(run)) return;
				if (subscribers.size === 0 && stop) {
					const halt = stop;
					stop = undefined;
					halt();
				}
			};
		},
	};
}
