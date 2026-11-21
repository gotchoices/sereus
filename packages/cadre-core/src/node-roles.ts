/**
 * The separately-settable decisions that make up a node's behaviour, and the {@link NodeClass}
 * presets that supply the ones an embedder does not set.
 *
 * A node class says what kind of machine this is; it does not say what the machine should do.
 * Four decisions follow from it by default, and each is worth setting on its own in a real
 * deployment: whether the machine is always on, how much overlay work it takes, whether it
 * forwards other subscribers' change notifications, and whether it holds and signs the data of
 * the strands it runs. Bundling them into the class meant every consumer mapped the class
 * itself, in its own place, with its own reasoning.
 *
 * Inside cadre-core this module is the only place a node class is turned into behaviour: a
 * reader that wants behaviour reads the resolved {@link NodeRoles} instead of comparing
 * `nodeClass` to a literal. The one site still deriving behaviour from the class itself is
 * `arachnode-stub.ts`, a stub with no callers whose storage rings are unimplemented —
 * `backlog/later/5-ring-zulu-storage-rings` owns it. (`provider/client.ts` also names the two
 * values, to narrow an untrusted field of an HTTP response; that is parsing, not behaviour.)
 *
 * Outside cadre-core, cadre-host's orchestrator reads the class to decide what to PROVISION for
 * a child — push credentials and a file store — before any node exists, which is its own
 * decision and not a node role. Anything that configures a node, the integration-test harness
 * included, reads {@link NODE_ROLE_PRESETS} rather than mapping the class again.
 *
 * See `docs/cadre/node.md` → "Node classes".
 */

import type { NodeClass } from './node-class.js';

/** How much overlay work a node takes: FRET's resource tier. */
export type OverlayTier = 'edge' | 'core';

/** Whether a node may carry other subscribers' change notifications, or only receive its own. */
export type ReactivityRole = 'forwarder' | 'subscriber';

/**
 * What one node does, with every decision settled. Resolved once per node by
 * {@link resolveNodeRoles} from the node's class and the embedder's overrides, and read from
 * there by everything that configures the node.
 */
export interface NodeRoles {
	/**
	 * Is this machine always on?
	 *
	 * Published to the party as this machine's `CadrePeer.Profile` (`node-class.ts` →
	 * `encodeAlwaysOn`), which is how a sibling knows to dial this machine first and how a seed
	 * marks a preferred peer. Also the default for running a circuit-relay server
	 * (`network.enableRelay`), for keeping a storage replica of every admitted strand
	 * (`CadreNodeConfig.hostUnclaimedStrands`) and for joining Arachnode's Ring Zulu.
	 *
	 * Setting this alone does not make a machine reachable — it states that it is, so set it to
	 * match the deployment.
	 */
	alwaysOn: boolean;
	/**
	 * FRET's resource tier for this node's libp2p nodes — the control node and every strand
	 * node, both built with it. `'core'` raises the rate limits, snapshot sizes and dial and
	 * inbound concurrency a machine with the capacity for them should use; `'edge'` is the
	 * settings a phone or a browser tab should run at.
	 */
	overlayTier: OverlayTier;
	/**
	 * This node's part in change notifications: the Optimystic cohort-topic node profile every
	 * strand node with reactivity enabled is built with.
	 *
	 * `'forwarder'` may serve notifications on behalf of other subscribers (cohort-topic's core
	 * profile, willing to forward every tier). `'subscriber'` receives only its own (the edge
	 * profile, which forwards the tiers that carry transactions and chain serving and is
	 * permanently unwilling to forward reactivity pushes).
	 *
	 * No effect on a strand with reactivity off, and none on the control node, which never
	 * enables it. See `docs/strands/app-schema.md` → "Change notifications".
	 */
	reactivity: ReactivityRole;
	/**
	 * Does this node hold and sign blocks for the strands it runs?
	 *
	 * Strands only: the control network always replicates to every party member, which is what
	 * lets any machine read the whole control database. `false` builds each strand node as an
	 * Optimystic **client** (`NodeOptions.servesBlocks: false`): it runs the strand — reads,
	 * writes, membership, change notifications — but stores none of its blocks, asks the
	 * embedder's storage provider for no per-strand store, and is in no cohort, so its reads
	 * and writes go to the strand's serving machines and a sleeping phone is never on the path
	 * of another machine's save. The shape a very large strand needs. Read in one place,
	 * `StrandInstanceManager.buildStrandRuntime`; what follows from it is in `docs/cadre/node.md`
	 * → "Node classes". Contradicts `hostUnclaimedStrands: true` ({@link resolveHostUnclaimedStrands}).
	 */
	strandCohortMember: boolean;
}

/**
 * Whether a node runs the admitted strands no app has claimed as storage replicas
 * (`CadreNodeConfig.hostUnclaimedStrands`): the explicit setting, else `alwaysOn` on a node that
 * holds strand blocks and `false` on one that does not.
 *
 * A replica's whole job is to store and serve a strand, so a node with `strandCohortMember:
 * false` cannot be one. The default therefore comes out `false` on such a node whatever
 * `alwaysOn` says — an always-on dashboard node that holds no blocks is a plausible deployment
 * and must not be refused for a setting it never made — and an EXPLICIT `true` beside
 * `strandCohortMember: false` throws naming both, because the embedder asked for two things that
 * cannot both hold.
 */
export function resolveHostUnclaimedStrands(explicit: boolean | undefined, roles: NodeRoles): boolean {
	if (explicit === undefined) {
		return roles.alwaysOn && roles.strandCohortMember;
	}
	if (explicit && !roles.strandCohortMember) {
		throw new Error(
			'hostUnclaimedStrands: true contradicts roles.strandCohortMember: false — a storage replica stores and '
			+ 'serves a strand\'s blocks, which a node that holds none cannot do. Drop one of the two.'
		);
	}
	return explicit;
}

/**
 * What each node class means, in roles. These are defaults an embedder overrides one at a time,
 * not a classification of the machine: a `device` that happens to be always on says so with
 * `roles: { alwaysOn: true }` and keeps every other device default.
 *
 * `reactivity` is `'forwarder'` for both classes because that is what every node does today
 * (cohort-topic's own default is its core profile). Whether a phone should forward is an open
 * question — `feat-decide-phone-reactivity-role-by-simulation` — and this setting is what lets
 * it be answered by configuring a simulation rather than by changing code.
 */
export const NODE_ROLE_PRESETS: Readonly<Record<NodeClass, Readonly<NodeRoles>>> = {
	device: { alwaysOn: false, overlayTier: 'edge', reactivity: 'forwarder', strandCohortMember: true },
	server: { alwaysOn: true, overlayTier: 'core', reactivity: 'forwarder', strandCohortMember: true }
};

const OVERLAY_TIERS: readonly OverlayTier[] = ['edge', 'core'];
const REACTIVITY_ROLES: readonly ReactivityRole[] = ['forwarder', 'subscriber'];

/**
 * Every role name, as a record so a role added to {@link NodeRoles} without a line here is a
 * type error rather than a key {@link refuseUnknownRoles} then rejects as a typo.
 */
const ROLE_NAMES: Record<keyof NodeRoles, true> = {
	alwaysOn: true,
	overlayTier: true,
	reactivity: true,
	strandCohortMember: true
};

/**
 * The roles a node built with `nodeClass` runs, with `overrides` applied over its preset.
 *
 * A role the caller leaves out (absent, or present as `undefined`) takes the preset's value.
 * A role the caller MISNAMES, or sets to anything outside its own set, THROWS rather than
 * falling back to the preset: these values reach here from a config file or an environment
 * variable by way of a JavaScript embedder, where a typo resolving silently to the preset would
 * leave a node quietly doing the opposite of what was asked for.
 */
export function resolveNodeRoles(nodeClass: NodeClass, overrides?: Partial<NodeRoles>): NodeRoles {
	const preset: Readonly<NodeRoles> | undefined = NODE_ROLE_PRESETS[nodeClass];
	if (preset === undefined) {
		throw new Error(`Unknown nodeClass ${describeValue(nodeClass)}: expected 'device' or 'server'.`);
	}
	const given: Partial<NodeRoles> = overrides ?? {};
	refuseUnknownRoles(given);
	return {
		alwaysOn: given.alwaysOn === undefined
			? preset.alwaysOn
			: checkedBoolean('alwaysOn', given.alwaysOn),
		overlayTier: given.overlayTier === undefined
			? preset.overlayTier
			: checkedOneOf('overlayTier', given.overlayTier, OVERLAY_TIERS),
		reactivity: given.reactivity === undefined
			? preset.reactivity
			: checkedOneOf('reactivity', given.reactivity, REACTIVITY_ROLES),
		strandCohortMember: given.strandCohortMember === undefined
			? preset.strandCohortMember
			: checkedBoolean('strandCohortMember', given.strandCohortMember)
	};
}

/**
 * Throw on a key of `given` that names no role. A misspelled role would otherwise resolve to the
 * preset in silence — the same failure a bad role VALUE is rejected for, and the likelier of the
 * two, since a key has no small set of right answers to land in by accident. TypeScript refuses
 * one in an object literal, so this is for the JavaScript embedder and the config file behind it.
 */
function refuseUnknownRoles(given: Partial<NodeRoles>): void {
	// A lookup rather than `Object.hasOwn` (an ES2022 builtin this package's ES2020 emit target
	// does not down-level) and rather than `in` (which would accept `toString` as a role).
	const unknown = Object.keys(given).filter(key => ROLE_NAMES[key as keyof NodeRoles] !== true);
	if (unknown.length > 0) {
		throw new Error(
			`Unknown roles ${unknown.map(key => `'${key}'`).join(', ')}: expected one of ${Object.keys(ROLE_NAMES).map(role => `'${role}'`).join(', ')}.`
		);
	}
}

/** `value` as a boolean role, else a throw naming the role. `unknown` because a JavaScript caller's value is. */
function checkedBoolean(role: string, value: unknown): boolean {
	if (typeof value === 'boolean') {
		return value;
	}
	throw badRoleValue(role, value, ['true', 'false']);
}

/** `value` as one of `allowed`, else a throw naming the role and what it admits. */
function checkedOneOf<T extends string>(role: string, value: unknown, allowed: readonly T[]): T {
	if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) {
		// The `includes` is the proof of this narrowing; TypeScript cannot carry it off the
		// widening to `readonly string[]`, so the assertion restates what the branch established.
		return value as T;
	}
	throw badRoleValue(role, value, allowed);
}

function badRoleValue(role: string, value: unknown, allowed: readonly string[]): Error {
	return new Error(
		`Invalid roles.${role} ${describeValue(value)}: expected one of ${allowed.map(one => `'${one}'`).join(', ')}.`
	);
}

/** A bad value named for an error message, without letting a huge or cyclic one into it. */
function describeValue(value: unknown): string {
	return typeof value === 'string' ? `'${value}'` : `of type ${typeof value}`;
}
