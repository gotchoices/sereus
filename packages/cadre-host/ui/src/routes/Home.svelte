<script lang="ts">
	import { onMount } from 'svelte';

	import {
		appState,
		refreshHostedNodes,
		refreshStatus,
		refreshUpdate,
	} from '../lib/state.svelte.js';
	import { isPending } from '../lib/hosted-nodes.js';
	import { formatUptime, formatRelativeTime } from '../lib/format.js';
	import { hrefFor } from '../lib/router.js';
	import StatusDot from '../components/StatusDot.svelte';
	import ConnectivityBadge from '../components/ConnectivityBadge.svelte';

	const app = appState();

	onMount(() => {
		void refreshStatus();
		void refreshUpdate();
		void refreshHostedNodes();
	});

	const updateAvailable = $derived(app.update?.available?.version ?? null);
	const nodesRunning = $derived(app.nodes.filter((n) => n.status === 'running').length);
	const runningReachability = $derived((app.connectivity?.nodes ?? []).filter((n) => n.running));
	const reachableNodes = $derived(runningReachability.filter((n) => n.verdict !== 'unreachable').length);
	const allReachable = $derived(reachableNodes === runningReachability.length);
	const hostedJoined = $derived(app.hostedNodes.list.filter((n) => n.status === 'joined').length);
	// Waiting to be claimed, or redeeming an invitation.
	const hostedWaiting = $derived(app.hostedNodes.list.filter((n) => isPending(n)).length);
	const hostedFailed = $derived(app.hostedNodes.list.filter((n) => n.status === 'error').length);
</script>

<section class="stack">
	{#if updateAvailable}
		<div class="banner info">
			<div>
				<strong>Update available</strong>
				<span class="muted">— version {updateAvailable}</span>
			</div>
			<a class="link" href={hrefFor('settings')}>View update</a>
		</div>
	{/if}

	<div class="grid summary">
		<div class="card">
			<h3>Overall</h3>
			<StatusDot status={app.status} />
			<dl class="kv">
				<div><dt>Service</dt><dd>{app.service?.name ?? 'cadre-host'}</dd></div>
				<div><dt>Version</dt><dd>{app.service?.version ?? '—'}</dd></div>
				<div><dt>Uptime</dt><dd>{formatUptime(app.service?.uptimeSeconds)}</dd></div>
			</dl>
		</div>

		<div class="card">
			<h3>Connectivity</h3>
			{#if app.connectivity}
				<ConnectivityBadge reachability={app.connectivity.directReachability} />
				{#if runningReachability.length === 0}
					<p class="muted">No nodes are running yet.</p>
				{:else if reachableNodes === 0}
					<p class="none">
						{runningReachability.length === 1 ? 'The running node cannot' : `None of the ${runningReachability.length} running nodes can`}
						be reached from outside your home network.
					</p>
				{:else}
					<p class="big">{reachableNodes} <span class="muted">of {runningReachability.length} nodes reachable from outside</span></p>
				{/if}
				<dl class="kv">
					<div><dt>External IP</dt><dd>{app.connectivity.externalIp ?? '—'}</dd></div>
					<div><dt>Last tested</dt><dd>{formatRelativeTime(app.connectivity.lastTestedAt)}</dd></div>
				</dl>
				<a class="link" href={hrefFor('connectivity')}>{allReachable ? 'Details →' : 'Resolve →'}</a>
			{:else}
				<p class="muted">Loading connectivity…</p>
			{/if}
		</div>

		<div class="card">
			<h3>Hosted nodes</h3>
			{#if app.hostedNodes.loaded}
				<p class="big">{hostedJoined} <span class="muted">joined, {hostedWaiting} waiting</span></p>
				{#if hostedFailed > 0}
					<p class="none">{hostedFailed} failed; <a href={hrefFor('nodes')}>see Nodes</a></p>
				{/if}
			{:else}
				<p class="muted">This machine runs cadre nodes for the cadres that claim them.</p>
			{/if}
			<a class="link" href={hrefFor('join')}>Join a cadre →</a>
		</div>

		<div class="card">
			<h3>Nodes</h3>
			<p class="big">{nodesRunning}<span class="muted"> / {app.nodes.length} running</span></p>
			<a class="link" href={hrefFor('nodes')}>Details →</a>
		</div>
	</div>
</section>

<style>
	.banner {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
		padding: var(--space-3) var(--space-4);
		border-radius: var(--radius);
		background: var(--color-info-bg);
		color: var(--color-info);
		border: 1px solid var(--color-info);
	}
	.summary { grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr)); }
	.kv {
		margin: var(--space-3) 0 0 0;
		display: grid;
		grid-template-columns: max-content 1fr;
		gap: var(--space-1) var(--space-3);
		font-size: 0.9rem;
	}
	.kv > div { display: contents; }
	.kv dt { color: var(--color-text-muted); }
	.kv dd { margin: 0; }
	.big {
		font-size: 1.75rem;
		font-weight: 600;
		margin: var(--space-2) 0;
	}
	.big .muted { font-size: 0.95rem; font-weight: 400; }
	.none { margin: var(--space-2) 0; color: var(--color-warn); font-weight: 500; }
	.link { display: inline-block; margin-top: var(--space-2); font-weight: 500; }
</style>
