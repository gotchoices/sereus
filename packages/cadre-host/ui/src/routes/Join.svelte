<script lang="ts">
	import { onMount, untrack } from 'svelte';

	import {
		appState,
		joinCadre,
		refreshHostedNodes,
		removeHostedNode,
		reportError,
		retryHostedNode,
		type HostedNodeView,
		type NodeReachability,
	} from '../lib/state.svelte.js';
	import { canRetryInvitation, isPending, isWaiting, stateLine, STATUS_BADGE, UNREACHABLE_HINT } from '../lib/hosted-nodes.js';
	import { hrefFor } from '../lib/router.js';

	import ClaimCode from '../components/ClaimCode.svelte';
	import NodeReachabilityCard from '../components/NodeReachabilityCard.svelte';

	const app = appState();

	let joining = $state(false);
	let joiningByInvitation = $state(false);
	let invitation = $state('');
	let cancelling: string[] = $state([]);
	let retrying: string[] = $state([]);
	/**
	 * Every node this page has shown since it opened. A node waiting to be claimed or
	 * redeeming an invitation is added as it appears, and stays after it joins (or fails)
	 * so its line can step on here. A reload starts again from the pending ones.
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
		const pending = app.hostedNodes.list.filter((n) => isPending(n)).map((n) => n.id);
		untrack(() => follow(pending));
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

	/** Join with the pasted invitation; the text is cleared once the node has started, since it carries a credential. */
	async function joinByInvitation(): Promise<void> {
		joiningByInvitation = true;
		try {
			const node = await joinCadre(invitation.trim());
			invitation = '';
			follow([node.id]);
		} catch (err) {
			reportError('Join by invitation', err);
		} finally {
			joiningByInvitation = false;
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

	async function retry(node: HostedNodeView): Promise<void> {
		retrying = [...retrying, node.id];
		try {
			await retryHostedNode(node.id);
		} catch (err) {
			reportError('Retry', err);
		} finally {
			retrying = retrying.filter((id) => id !== node.id);
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

	<form class="card stack invitation" onsubmit={(e) => { e.preventDefault(); void joinByInvitation(); }}>
		<label for="invitation"><strong>Or paste a cadre invitation</strong></label>
		<p class="muted small">
			The invitation the owner's app copied. The node redeems it at a member of the cadre this
			machine can reach, so it works once the cadre has an always-on node; for the cadre's first
			one, use the button above and scan the code instead.
		</p>
		<textarea id="invitation" rows="3" spellcheck="false" autocomplete="off" bind:value={invitation}></textarea>
		<div class="actions">
			<button type="submit" disabled={joiningByInvitation || invitation.trim() === ''}>
				{joiningByInvitation ? 'Joining…' : 'Join'}
			</button>
		</div>
	</form>

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
			<p class="state" class:error={node.status === 'error'} aria-live="polite">{stateLine(node)}</p>

			{#if isWaiting(node)}
				<ClaimCode {node} />
				{#if reach && app.connectivity}
					<NodeReachabilityCard node={reach} connectivity={app.connectivity} />
				{/if}
				<div class="actions">
					<button disabled={cancelling.includes(node.id)} onclick={() => cancel(node)}>
						{cancelling.includes(node.id) ? 'Cancelling…' : 'Cancel'}
					</button>
				</div>
			{:else if isPending(node)}
				<div class="actions">
					<button disabled={cancelling.includes(node.id)} onclick={() => cancel(node)}>
						{cancelling.includes(node.id) ? 'Cancelling…' : 'Cancel'}
					</button>
				</div>
			{:else if canRetryInvitation(node)}
				<p class="small">{UNREACHABLE_HINT}</p>
				<div class="actions">
					<button disabled={cancelling.includes(node.id)} onclick={() => cancel(node)}>
						{cancelling.includes(node.id) ? 'Removing…' : 'Remove'}
					</button>
					<button class="primary" disabled={retrying.includes(node.id)} onclick={() => retry(node)}>
						{retrying.includes(node.id) ? 'Retrying…' : 'Retry'}
					</button>
				</div>
			{:else}
				<a href={hrefFor('node-detail', { id: node.id })}>Open this node's page →</a>
			{/if}
		</article>
	{:else}
		{#if app.hostedNodes.loaded}
			<p class="muted">No node is waiting to join a cadre.</p>
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
	.invitation p { margin: 0; }
	.invitation textarea {
		width: 100%;
		box-sizing: border-box;
		font-family: var(--font-mono);
		font-size: 0.85rem;
		word-break: break-all;
	}
	.node-head { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
	.node-head code { word-break: break-all; }
	.state { margin: 0; font-weight: 500; }
	.small { font-size: 0.85rem; margin: 0; }
	.actions { display: flex; justify-content: flex-end; gap: 0.5rem; flex-wrap: wrap; }
	.error { color: var(--color-danger); }
</style>
