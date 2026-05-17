<script lang="ts">
	import { onMount } from 'svelte';

	import {
		appState,
		refreshStatus,
		refreshUpdate,
	} from '../lib/state.svelte.js';
	import { formatUptime, formatRelativeTime } from '../lib/format.js';
	import { hrefFor } from '../lib/router.js';
	import StatusDot from '../components/StatusDot.svelte';
	import ConnectivityBadge from '../components/ConnectivityBadge.svelte';

	const app = appState();

	onMount(() => {
		void refreshStatus();
		void refreshUpdate();
	});

	const updateAvailable = $derived(app.update?.available?.version ?? null);
	const memberCount = $derived(app.trustCircle.members.length);
	const pendingCount = $derived(app.trustCircle.pending.length);
	const nodesRunning = $derived(app.nodes.filter((n) => n.status === 'running').length);
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
				<ConnectivityBadge
					reachability={app.connectivity.directReachability}
					portMode={app.connectivity.portMode}
				/>
				<dl class="kv">
					<div><dt>External IP</dt><dd>{app.connectivity.externalIp ?? '—'}</dd></div>
					<div><dt>External port</dt><dd>{app.connectivity.externalPort}</dd></div>
					<div><dt>Last tested</dt><dd>{formatRelativeTime(app.connectivity.lastTestedAt)}</dd></div>
				</dl>
				{#if app.connectivity.directReachability !== 'reachable'}
					<a class="link" href={hrefFor('connectivity')}>Resolve →</a>
				{/if}
			{:else}
				<p class="muted">Loading connectivity…</p>
			{/if}
		</div>

		<div class="card">
			<h3>Trust circle</h3>
			<p class="big">{memberCount}<span class="muted"> members</span></p>
			{#if pendingCount > 0}
				<p class="muted">{pendingCount} pending invite{pendingCount === 1 ? '' : 's'}</p>
			{/if}
			<a class="link" href={hrefFor('trust-circle')}>Manage →</a>
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
	.link { display: inline-block; margin-top: var(--space-2); font-weight: 500; }
</style>
