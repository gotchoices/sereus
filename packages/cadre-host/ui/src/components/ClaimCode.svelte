<script lang="ts">
	import { ApiError } from '../lib/api.js';
	import {
		appState,
		fetchClaimDetails,
		refreshHostedNodes,
		type ClaimDetails,
		type HostedNodeView,
	} from '../lib/state.svelte.js';

	import TokenShare from './TokenShare.svelte';

	interface Props {
		/** A node waiting to be claimed; the code is read only while it is `unclaimed`. */
		node: HostedNodeView;
	}

	const { node }: Props = $props();

	/** The claim route answers 503 until the child reports an address; the CLI polls it the same way. */
	const STARTING_RETRY_MS = 1_000;
	/**
	 * How long a 503 counts as "starting", as the CLI's `CLAIM_DETAILS_WAIT_MS`. Past it
	 * the server's reason is shown with Try again: a host with no address a phone could
	 * dial answers 503 for as long as the node waits.
	 */
	const STARTING_WAIT_MS = 60_000;

	const app = appState();

	// Holds the claim secret: page-local by design, dropped once the node is claimed.
	let details = $state<ClaimDetails | null>(null);
	let failure: string | null = $state(null);
	let attempt = $state(0);

	// Primitives, so the effect below re-runs only when one of them changes, not on
	// every refresh of the slice that hands this component a new `node` object.
	const id = $derived(node.id);
	const unclaimed = $derived(node.status === 'unclaimed');
	const liveReachability = $derived(app.connectivity?.nodes.find((n) => n.nodeId === node.id) ?? null);
	/**
	 * The code lists the public addresses the NAT layer knows at the time it is read,
	 * and a mapping can complete after the node starts; a change re-reads the code
	 * so the QR carries them.
	 */
	const publicAddrs = $derived(liveReachability?.publicAddrs.join(' ') ?? '');
	const verdict = $derived((liveReachability ?? details?.reachability)?.verdict ?? null);

	$effect(() => {
		void attempt;
		void publicAddrs;
		if (!unclaimed) {
			details = null;
			failure = null;
			return;
		}
		return readCode(id);
	});

	/** Read the code, retrying while the child starts. Returns the effect's cleanup. */
	function readCode(nodeId: string): () => void {
		let stopped = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const deadline = Date.now() + STARTING_WAIT_MS;
		async function load(): Promise<void> {
			try {
				const read = await fetchClaimDetails(nodeId);
				if (stopped) return;
				details = read;
				failure = null;
			} catch (err) {
				if (stopped) return;
				if (err instanceof ApiError && err.code === 'node_unavailable' && Date.now() < deadline) {
					timer = setTimeout(() => void load(), STARTING_RETRY_MS);
					return;
				}
				if (err instanceof ApiError && err.code === 'invalid_state') {
					// Claimed (or failed) since the list was read; the list catches up.
					void refreshHostedNodes();
					return;
				}
				console.error(`[cadre-host-ui] claim details for ${nodeId}:`, err);
				failure = err instanceof Error ? err.message : String(err);
			}
		}
		void load();
		return () => {
			stopped = true;
			if (timer) clearTimeout(timer);
		};
	}
</script>

{#if failure}
	<div class="row">
		<p class="error small">Could not read this node's code: {failure}</p>
		<button type="button" onclick={() => (attempt += 1)}>Try again</button>
	</div>
{/if}
{#if details}
	<TokenShare value={details.payload} copyLabel="Copy join details" />
	<p class="small">Scan this with the Sereus app on the phone that owns the cadre, or paste the text into it.</p>
	{#if verdict === 'unreachable'}
		<p class="small warn">Works from your home network now; forward the ports below for a phone elsewhere.</p>
	{/if}
{:else if !failure}
	<p class="muted">Starting the node…</p>
{/if}

<style>
	p { margin: 0; }
	.small { font-size: 0.85rem; }
	.error { color: var(--color-danger); }
	.warn { color: var(--color-warn); font-weight: 500; }
</style>
