<script lang="ts">
	import { onMount } from 'svelte';

	import {
		appState,
		applyEvent,
		refreshStatus,
		refreshNodes,
		refreshTrustCircle,
		refreshConnectivity,
		refreshUpdate,
		refreshSettings,
		pushToast,
		type OverallStatus,
	} from './lib/state.svelte.js';
	import { hrefFor, type RouteName } from './lib/router.js';
	import { routeState, startRouter, stopRouter } from './lib/router.svelte.js';
	import { subscribeEvents } from './lib/events.js';

	import Home from './routes/Home.svelte';
	import TrustCircle from './routes/TrustCircle.svelte';
	import Connectivity from './routes/Connectivity.svelte';
	import Nodes from './routes/Nodes.svelte';
	import NodeDetail from './routes/NodeDetail.svelte';
	import Settings from './routes/Settings.svelte';
	import StatusDot from './components/StatusDot.svelte';
	import Toast from './components/Toast.svelte';

	const route = routeState();
	const app = appState();

	function statusBadgeLabel(s: OverallStatus): string {
		switch (s) {
			case 'ok': return 'OK';
			case 'warn': return 'Attention';
			case 'error': return 'Error';
			default: return '…';
		}
	}

	const NAV: Array<{ name: RouteName; label: string }> = [
		{ name: 'home', label: 'Home' },
		{ name: 'trust-circle', label: 'Trust Circle' },
		{ name: 'connectivity', label: 'Connectivity' },
		{ name: 'nodes', label: 'Nodes' },
		{ name: 'settings', label: 'Settings' },
	];

	function isActive(name: RouteName): boolean {
		if (name === 'nodes') {
			return route.route.name === 'nodes' || route.route.name === 'node-detail';
		}
		return route.route.name === name;
	}

	onMount(() => {
		startRouter();
		void refreshStatus();
		void refreshNodes();
		void refreshTrustCircle();
		void refreshConnectivity();
		void refreshUpdate();
		void refreshSettings();

		let firstError = true;
		const handle = subscribeEvents(
			(event) => applyEvent(event),
			{
				onError(_attempt, nextDelayMs) {
					if (firstError) {
						firstError = false;
						pushToast('error', `Lost realtime updates; retrying in ${Math.round(nextDelayMs / 1000)}s`);
					}
				},
				onOpen() {
					firstError = true;
				},
			},
		);

		return () => {
			handle.close();
			stopRouter();
		};
	});
</script>

<a class="visually-hidden" href="#main">Skip to content</a>
<header class="topbar">
	<div class="brand">
		<span class="logo" aria-hidden="true">●</span>
		<span>cadre-host</span>
		<StatusDot status={app.status} label={statusBadgeLabel(app.status)} size={10} />
	</div>
	<nav aria-label="Primary">
		{#each NAV as item (item.name)}
			<a
				href={hrefFor(item.name)}
				class:active={isActive(item.name)}
				aria-current={isActive(item.name) ? 'page' : undefined}
			>
				{item.label}
			</a>
		{/each}
	</nav>
</header>

<main id="main">
	{#if route.route.name === 'trust-circle'}
		<TrustCircle />
	{:else if route.route.name === 'connectivity'}
		<Connectivity />
	{:else if route.route.name === 'nodes'}
		<Nodes />
	{:else if route.route.name === 'node-detail'}
		<NodeDetail id={route.route.params['id'] ?? ''} />
	{:else if route.route.name === 'settings'}
		<Settings />
	{:else}
		<Home />
	{/if}
</main>

<Toast />

<style>
	.topbar {
		position: sticky;
		top: 0;
		z-index: 10;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-4);
		padding: var(--space-3) var(--space-5);
		background: var(--color-surface);
		border-bottom: 1px solid var(--color-border);
		backdrop-filter: saturate(180%) blur(8px);
	}

	.brand {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		font-weight: 600;
	}
	.logo {
		color: var(--color-accent);
		font-size: 1.1rem;
	}

	nav {
		display: flex;
		gap: 0.125rem;
	}
	nav a {
		font-size: 0.92rem;
		color: var(--color-text-muted);
		padding: 0.375rem 0.75rem;
		border-radius: var(--radius);
		text-decoration: none;
	}
	nav a:hover { background: var(--color-surface-alt); color: var(--color-text); }
	nav a.active {
		color: var(--color-accent-on);
		background: var(--color-accent);
	}

	main {
		flex: 1 1 auto;
		width: min(64rem, 100%);
		margin: 0 auto;
		padding: var(--space-5);
	}

	@media (max-width: 640px) {
		.topbar {
			flex-direction: column;
			align-items: flex-start;
			gap: var(--space-2);
			padding: var(--space-2) var(--space-3);
		}
		nav { width: 100%; overflow-x: auto; }
		main { padding: var(--space-3); }
	}
</style>
