<script lang="ts">
	import { onMount } from 'svelte';
	import { nodeState, start } from './lib/store.svelte.js';
	import {
		routeState,
		startRouter,
		stopRouter,
		hrefFor,
	} from './lib/router.svelte.js';
	import Home from './Home.svelte';
	import Diagnostics from './Diagnostics.svelte';
	import Messages from './Messages.svelte';
	import Activity from './Activity.svelte';

	const route = routeState();
	const node = nodeState();

	onMount(() => {
		startRouter();
		void start();
		return () => stopRouter();
	});

	const NAV: Array<{ path: string; label: string }> = [
		{ path: '/', label: 'Home' },
		{ path: '/messages', label: 'Messages' },
		{ path: '/log', label: 'Activity' },
		{ path: '/diag', label: 'Diagnostics' },
	];

	function isActive(path: string): boolean {
		if (path === '/') return route.path === '/';
		return route.path === path || route.path.startsWith(path + '/');
	}

	function testIdFor(path: string): string {
		switch (path) {
			case '/': return 'nav-home';
			case '/messages': return 'nav-messages';
			case '/log': return 'nav-activity';
			case '/diag': return 'nav-diagnostics';
			default: return `nav-${path.replace(/[^a-z0-9]+/gi, '-')}`;
		}
	}
</script>

<main>
	<header>
		<h1>Sereus Web Reference</h1>
		<span class="mode-badge mode-{node.mode}" data-testid="mode-badge">{node.mode}</span>
		<nav>
			{#each NAV as item (item.path)}
				<a
					href={hrefFor(item.path)}
					class:active={isActive(item.path)}
					data-testid={testIdFor(item.path)}
				>
					{item.label}
				</a>
			{/each}
		</nav>
	</header>

	{#if route.path === '/diag'}
		<Diagnostics />
	{:else if route.path === '/messages'}
		<Messages />
	{:else if route.path === '/log'}
		<Activity />
	{:else}
		<Home />
	{/if}
</main>

<style>
	main {
		max-width: 880px;
		margin: 2rem auto;
		padding: 0 1.25rem;
		font-family: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto,
			sans-serif;
		color: #1d1f24;
	}

	header {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		margin-bottom: 1.5rem;
		flex-wrap: wrap;
	}

	h1 {
		margin: 0;
		font-size: 1.5rem;
		font-weight: 600;
	}

	.mode-badge {
		font-size: 0.75rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		padding: 0.125rem 0.5rem;
		border-radius: 999px;
	}

	.mode-solo {
		background: #ffe9b3;
		color: #6b4d00;
	}

	.mode-distributed {
		background: #d8f1e0;
		color: #1f7a3b;
	}

	nav {
		margin-left: auto;
		display: flex;
		gap: 0.25rem;
	}

	nav a {
		font-size: 0.875rem;
		color: #4a4d54;
		text-decoration: none;
		padding: 0.25rem 0.625rem;
		border-radius: 0.25rem;
	}

	nav a:hover {
		background: #eef0f4;
	}

	nav a.active {
		background: #1d1f24;
		color: white;
	}
</style>
