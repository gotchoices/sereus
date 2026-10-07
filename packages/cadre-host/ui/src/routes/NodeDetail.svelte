<script lang="ts">
	import { onDestroy, onMount } from 'svelte';

	import {
		appState,
		refreshHostedNodes,
		refreshNodeDetail,
		removeHostedNode,
		reportError,
		resetHostedNode,
		pushToast,
	} from '../lib/state.svelte.js';
	import {
		claimedCadre,
		connectedText,
		isWaiting,
		ownerFingerprint,
		stateLine,
		STATUS_BADGE,
	} from '../lib/hosted-nodes.js';
	import { hrefFor, navigate } from '../lib/router.js';
	import { formatBytes, formatRelativeTime } from '../lib/format.js';

	import ClaimCode from '../components/ClaimCode.svelte';
	import ConfirmDialog from '../components/ConfirmDialog.svelte';
	import LogTail from '../components/LogTail.svelte';
	import NodeReachabilityCard from '../components/NodeReachabilityCard.svelte';

	interface Props { id: string }
	const { id }: Props = $props();

	type ConfirmedAction = 'remove' | 'reset' | 'retry';

	const CONFIRM: Record<ConfirmedAction, { title: string; label: string; message: (nodeId: string) => string }> = {
		remove: {
			title: 'Remove hosted node',
			label: 'Remove',
			message: (nodeId) => `Remove ${nodeId}? This stops the node and deletes its data on this machine. The cadre keeps the node's row until its owner removes it there.`,
		},
		reset: {
			title: 'Reset hosted node',
			label: 'Reset',
			message: (nodeId) => `Reset ${nodeId}? Use this if someone you did not intend claimed the node. The node is stopped, its data on this machine deleted, and a fresh node with a new code starts.`,
		},
		retry: {
			title: 'Retry hosted node',
			label: 'Retry',
			message: (nodeId) => `Retry ${nodeId}? The failed node is removed and its data on this machine deleted, and a fresh node with a new code starts for the phone that owns the cadre to scan.`,
		},
	};

	const app = appState();

	let confirming: ConfirmedAction | null = $state(null);
	let busyAction: ConfirmedAction | 'cancel' | null = $state(null);
	/** The first read of the orchestrator handle has answered, found or not. */
	let handleRead = $state(false);
	let pollTimer: ReturnType<typeof setInterval> | undefined;
	// A mutation outlives the page if the user leaves mid-request; its
	// navigation must not act on a page that is gone.
	let destroyed = false;

	/** The orchestrator handle: absent for a node whose spawn failed. */
	const node = $derived(app.nodes.find((n) => n.id === id) ?? null);
	/** The hosted-node record: absent for a handle whose record was lost. */
	const hosted = $derived(app.hostedNodes.list.find((n) => n.id === id) ?? null);
	const stats = $derived(app.nodeStats[id] ?? null);
	const reachability = $derived(app.connectivity?.nodes.find((n) => n.nodeId === id) ?? null);
	const missing = $derived(!node && !hosted && handleRead && app.hostedNodes.loaded);

	onMount(() => {
		void refreshHostedNodes();
		void refreshNodeDetail(id).then(() => (handleRead = true));
		pollTimer = setInterval(() => void refreshNodeDetail(id), 5_000);
	});

	onDestroy(() => {
		destroyed = true;
		if (pollTimer) clearInterval(pollTimer);
	});

	/** Remove, then leave for the list: the node is gone. Through the same route as `cadre-host node remove`. */
	async function remove(action: 'remove' | 'cancel'): Promise<void> {
		busyAction = action;
		try {
			await removeHostedNode(id);
		} catch (err) {
			reportError(action === 'cancel' ? 'Cancel' : 'Remove', err);
			busyAction = null;
			return;
		}
		pushToast('success', `Removed hosted node ${id}`);
		if (!destroyed) navigate(hrefFor('nodes'));
	}

	/** Reset (or retry a failed node): a fresh node with a new id replaces this one, so the page moves to it. */
	async function reset(action: 'reset' | 'retry'): Promise<void> {
		busyAction = action;
		try {
			const fresh = await resetHostedNode(id);
			pushToast('success', `Started ${fresh.id} in place of ${id}; show its code only to the person it is for`);
			if (!destroyed) navigate(hrefFor('node-detail', { id: fresh.id }));
		} catch (err) {
			reportError(action === 'retry' ? 'Retry' : 'Reset', err);
			busyAction = null;
		}
	}

	async function confirmed(action: ConfirmedAction): Promise<void> {
		confirming = null;
		if (action === 'remove') await remove('remove');
		else await reset(action);
	}

	function busyLabel(action: ConfirmedAction | 'cancel', idle: string, busy: string): string {
		return busyAction === action ? busy : idle;
	}
</script>

<section class="stack">
	<header class="row">
		<a href={hrefFor('nodes')} class="back">← Back to nodes</a>
	</header>

	{#if missing}
		<div class="card">
			<p class="muted">There is no node {id} on this machine. It may have been removed.</p>
		</div>
	{:else if !node && !hosted}
		<div class="card">
			<p class="muted">Loading node {id}…</p>
		</div>
	{:else}
		<div class="card">
			<div class="page-header">
				<div>
					<h2><code>{id}</code></h2>
					<p class="muted">Hosted node · {node?.profile ?? 'storage'} profile</p>
				</div>
				{#if node}
					<span class={`badge ${node.status === 'running' ? 'ok' : 'err'}`}>{node.status}</span>
				{:else}
					<span class="badge">no process</span>
				{/if}
			</div>

			{#if node}
				<dl class="kv">
					<div><dt>Workdir</dt><dd><code>{node.workdir || '—'}</code></dd></div>
					<div><dt>Spawned</dt><dd>{formatRelativeTime(node.spawnedAt)}</dd></div>
					<div><dt>Ports</dt><dd>health {node.ports.health} · metrics {node.ports.metrics} · p2p {node.ports.p2p} · ws {node.ports.ws}</dd></div>
					<div><dt>CPU</dt><dd>{stats ? stats.cpuPercent.toFixed(1) + '%' : '—'}</dd></div>
					<div><dt>Memory (RSS)</dt><dd>{formatBytes(stats?.memoryBytes)}</dd></div>
				</dl>
			{:else}
				<p class="muted">No process is running for this node on this machine.</p>
			{/if}
		</div>

		<div class="card stack">
			<div class="card-head">
				<h3>Cadre</h3>
				{#if hosted}
					<span class="badge {STATUS_BADGE[hosted.status].tone}">{STATUS_BADGE[hosted.status].text}</span>
				{/if}
			</div>

			{#if !hosted}
				{#if app.hostedNodes.loaded}
					<p class="muted">No hosted-node record names this node, so its cadre is unknown. Remove stops it and deletes its data on this machine.</p>
					<div class="actions">
						<button class="danger" disabled={busyAction !== null} onclick={() => (confirming = 'remove')}>
							{busyLabel('remove', 'Remove', 'Removing…')}
						</button>
					</div>
				{:else}
					<p class="muted">Loading…</p>
				{/if}
			{:else}
				<p class="state" class:error={hosted.status === 'error'}>{stateLine(hosted)}</p>
				<dl class="kv">
					<div><dt>Cadre ID</dt><dd><code>{claimedCadre(hosted) ?? '—'}</code></dd></div>
					<div><dt>Owner</dt><dd><code title={hosted.ownerKey}>{ownerFingerprint(hosted.ownerKey)}</code></dd></div>
					<div><dt>Connected</dt><dd>{connectedText(hosted)}</dd></div>
				</dl>

				{#if isWaiting(hosted.status)}
					<ClaimCode node={hosted} />
					<div class="actions">
						<button disabled={busyAction !== null} onclick={() => remove('cancel')}>
							{busyLabel('cancel', 'Cancel', 'Cancelling…')}
						</button>
					</div>
				{:else}
					<!-- Enabled even while stopped: a crashed node awaiting respawn is removed the same way. -->
					<div class="actions">
						{#if hosted.status === 'error'}
							<button disabled={busyAction !== null} onclick={() => (confirming = 'retry')}>
								{busyLabel('retry', 'Retry', 'Retrying…')}
							</button>
						{:else}
							<button disabled={busyAction !== null} onclick={() => (confirming = 'reset')}>
								{busyLabel('reset', 'Reset', 'Resetting…')}
							</button>
						{/if}
						<button class="danger" disabled={busyAction !== null} onclick={() => (confirming = 'remove')}>
							{busyLabel('remove', 'Remove', 'Removing…')}
						</button>
					</div>
				{/if}
			{/if}
		</div>

		{#if node}
			<div class="card stack">
				<h3>Reachable from outside</h3>
				{#if !app.connectivity}
					<p class="muted">Loading…</p>
				{:else if !reachability}
					<p class="muted">The port mapping table has no entry for this node yet.</p>
				{:else}
					<NodeReachabilityCard node={reachability} connectivity={app.connectivity} />
				{/if}
			</div>

			<LogTail nodeId={node.id} />
		{/if}
	{/if}
</section>

{#if confirming}
	{@const action = confirming}
	<ConfirmDialog
		open
		title={CONFIRM[action].title}
		message={CONFIRM[action].message(id)}
		confirmLabel={CONFIRM[action].label}
		danger
		onConfirm={() => confirmed(action)}
		onCancel={() => (confirming = null)}
	/>
{/if}

<style>
	.back { font-size: 0.92rem; }
	.page-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		flex-wrap: wrap;
		gap: var(--space-3);
	}
	.page-header h2 code { word-break: break-all; }
	.card-head { display: flex; align-items: center; gap: 0.5rem; }
	.card-head h3 { margin: 0; }
	.state { margin: 0; font-weight: 500; }
	.error { color: var(--color-danger); }
	.kv {
		margin: var(--space-3) 0;
		display: grid;
		grid-template-columns: max-content 1fr;
		gap: var(--space-1) var(--space-3);
		font-size: 0.92rem;
	}
	.kv > div { display: contents; }
	.kv dt { color: var(--color-text-muted); }
	.kv dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
	.actions { display: flex; justify-content: flex-end; gap: 0.5rem; flex-wrap: wrap; }
</style>
