<script lang="ts">
	import { onMount, untrack } from 'svelte';

	import {
		appState,
		joinCadre,
		refreshHostedNodes,
		removeHostedNode,
		reportError,
		type HostedNodeView,
		type NodeReachability,
	} from '../lib/state.svelte.js';
	import { isWaiting, stateLine, STATUS_BADGE } from '../lib/hosted-nodes.js';
	import { hrefFor } from '../lib/router.js';

	import ClaimCode from '../components/ClaimCode.svelte';
	import NodeReachabilityCard from '../components/NodeReachabilityCard.svelte';

	const app = appState();

	let joining = $state(false);
	let cancelling: string[] = $state([]);
	/**
	 * Every node this page has shown since it opened. A node waiting to be claimed
	 * is added as it appears, and stays after the claim so its line can step on to
	 * "claimed" and "connected" here. A reload starts again from the waiting ones.
	 */
	let followed: string[] = $state([]);

	const shown = $derived(
		app.hostedNodes.list
			.filter((n) => followed.includes(n.id))
			.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
	);

	onMount(() => {
		void refreshHostedNodes();
	});

	$effect(() => {
		const waiting = app.hostedNodes.list.filter((n) => isWaiting(n.status)).map((n) => n.id);
		untrack(() => follow(waiting));
	});

	function follow(ids: string[]): void {
		const added = ids.filter((id) => !followed.includes(id));
		if (added.length > 0) followed = [...followed, ...added];
	}

	async function join(): Promise<void> {
		joining = true;
		try {
			const node = await joinCadre();
			follow([node.id]);
		} catch (err) {
			reportError('Join', err);
		} finally {
			joining = false;
		}
	}

	async function cancel(node: HostedNodeView): Promise<void> {
		cancelling = [...cancelling, node.id];
		try {
			await removeHostedNode(node.id);
		} catch (err) {
			reportError('Cancel', err);
		} finally {
			cancelling = cancelling.filter((id) => id !== node.id);
		}
	}

	function reachabilityOf(id: string): NodeReachability | null {
		return app.connectivity?.nodes.find((n) => n.nodeId === id) ?? null;
	}
</script>

<section class="stack">
	<header class="page-header">
		<div>
			<h2>Join a cadre</h2>
			<p class="muted">
				Start a node on this machine for someone's cadre. The phone that owns the cadre scans
				the node's code, and the node joins that cadre. Anyone who scans the code claims the
				node, so show it only to the person it is for.
			</p>
		</div>
		<button class="primary" onclick={join} disabled={joining}>
			{joining ? 'Starting a node…' : 'Join a cadre'}
		</button>
	</header>

	{#if app.hostedNodes.error}
		<p class="error">Couldn’t load hosted nodes: {app.hostedNodes.error}</p>
	{/if}

	{#each shown as node (node.id)}
		{@const reach = reachabilityOf(node.id)}
		<article class="card stack">
			<div class="node-head">
				<a href={hrefFor('node-detail', { id: node.id })}><code>{node.id}</code></a>
				<span class="badge {STATUS_BADGE[node.status].tone}">{STATUS_BADGE[node.status].text}</span>
			</div>
			<p class="state" aria-live="polite">{stateLine(node)}</p>

			{#if isWaiting(node.status)}
				<ClaimCode {node} />
				{#if reach && app.connectivity}
					<NodeReachabilityCard node={reach} connectivity={app.connectivity} />
				{/if}
				<div class="actions">
					<button disabled={cancelling.includes(node.id)} onclick={() => cancel(node)}>
						{cancelling.includes(node.id) ? 'Cancelling…' : 'Cancel'}
					</button>
				</div>
			{:else}
				<a href={hrefFor('node-detail', { id: node.id })}>Open this node's page →</a>
			{/if}
		</article>
	{:else}
		{#if app.hostedNodes.loaded}
			<p class="muted">No node is waiting to be claimed.</p>
		{:else if !app.hostedNodes.error}
			<p class="muted">Loading…</p>
		{/if}
	{/each}
</section>

<style>
	.page-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		flex-wrap: wrap;
		gap: var(--space-3);
	}
	.page-header > div { flex: 1 1 20rem; }
	.node-head { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
	.node-head code { word-break: break-all; }
	.state { margin: 0; font-weight: 500; }
	.actions { display: flex; justify-content: flex-end; }
	.error { color: var(--color-danger); }
</style>
