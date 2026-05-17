<script lang="ts">
	import { onMount } from 'svelte';

	import { appState, refreshNodes } from '../lib/state.svelte.js';
	import { hrefFor } from '../lib/router.js';
	import { formatRelativeTime, shortPeerId } from '../lib/format.js';

	const app = appState();

	onMount(() => {
		void refreshNodes();
	});
</script>

<section class="stack">
	<header>
		<h2>Nodes</h2>
		<p class="muted">Cadre nodes managed by this host.</p>
	</header>

	<div class="card">
		{#if app.nodes.length === 0}
			<p class="muted">
				No managed nodes yet. cadre-host v1 doesn't auto-spawn nodes — they
				come up once you complete an invite redemption.
			</p>
		{:else}
			<table>
				<thead>
					<tr>
						<th scope="col">ID</th>
						<th scope="col">Profile</th>
						<th scope="col">Status</th>
						<th scope="col">Party</th>
						<th scope="col">Spawned</th>
						<th scope="col"></th>
					</tr>
				</thead>
				<tbody>
					{#each app.nodes as node (node.id)}
						<tr>
							<td><code>{node.id}</code></td>
							<td>{node.profile}</td>
							<td>
								<span class={`badge ${node.status === 'running' ? 'ok' : 'err'}`}>
									{node.status}
								</span>
							</td>
							<td><code title={node.partyId}>{shortPeerId(node.partyId)}</code></td>
							<td class="muted">{formatRelativeTime(node.spawnedAt)}</td>
							<td>
								<a href={hrefFor('node-detail', { id: node.id })}>Details →</a>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		{/if}
	</div>
</section>

<style>
	table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.92rem;
	}
	th, td {
		padding: 0.5rem 0.75rem;
		text-align: left;
		border-bottom: 1px solid var(--color-border);
	}
	th {
		font-weight: 600;
		font-size: 0.78rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--color-text-muted);
		border-bottom-color: var(--color-border-strong);
	}
	tr:last-child td { border-bottom: none; }
</style>
