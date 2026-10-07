<script lang="ts">
	import { onMount } from 'svelte';

	import { appState, refreshHostedNodes, refreshNodes } from '../lib/state.svelte.js';
	import { claimedCadre, connectedText, joinNodeRows, ownerFingerprint, STATUS_BADGE } from '../lib/hosted-nodes.js';
	import { hrefFor } from '../lib/router.js';
	import { formatRelativeTime, shortPeerId } from '../lib/format.js';

	const app = appState();

	const rows = $derived(joinNodeRows(app.hostedNodes.list, app.nodes));

	onMount(() => {
		void refreshNodes();
		void refreshHostedNodes();
	});
</script>

<section class="stack">
	<header>
		<h2>Nodes</h2>
		<p class="muted">Cadre nodes this machine runs, and the cadre each one joined.</p>
	</header>

	<div class="card">
		{#if app.hostedNodes.error}
			<p class="error">Couldn’t load hosted nodes: {app.hostedNodes.error}</p>
		{/if}
		{#if rows.length === 0 && app.hostedNodes.loaded}
			<p class="muted">
				No nodes yet. <a href={hrefFor('join')}>Join a cadre</a> to start one, then scan its code with the phone that owns the cadre.
			</p>
		{:else if rows.length === 0}
			{#if !app.hostedNodes.error}<p class="muted">Loading…</p>{/if}
		{:else}
			<div class="scroll">
				<table>
					<thead>
						<tr>
							<th scope="col">ID</th>
							<th scope="col">Status</th>
							<th scope="col">Cadre</th>
							<th scope="col">Owner</th>
							<th scope="col">Connected</th>
							<th scope="col">Spawned</th>
							<th scope="col"></th>
						</tr>
					</thead>
					<tbody>
						{#each rows as row (row.id)}
							{@const cadre = row.hosted ? claimedCadre(row.hosted) : null}
							<tr>
								<td><code>{row.id}</code></td>
								<td>
									<span class="badges">
										{#if row.hosted}
											<span class="badge {STATUS_BADGE[row.hosted.status].tone}">{STATUS_BADGE[row.hosted.status].text}</span>
										{/if}
										{#if !row.handle}
											<span class="badge">no process</span>
										{:else if row.handle.status !== 'running'}
											<span class="badge err">{row.handle.status}</span>
										{/if}
									</span>
								</td>
								<td>
									{#if cadre}<code title={cadre}>{shortPeerId(cadre)}</code>{:else}—{/if}
								</td>
								<td><code title={row.hosted?.ownerKey}>{ownerFingerprint(row.hosted?.ownerKey)}</code></td>
								<td>{row.hosted ? connectedText(row.hosted) : '—'}</td>
								<td class="muted">{formatRelativeTime(row.handle?.spawnedAt ?? row.hosted?.createdAt)}</td>
								<td>
									<a href={hrefFor('node-detail', { id: row.id })}>Details →</a>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</div>
</section>

<style>
	/* The table scrolls inside its card on a narrow screen rather than widening the page. */
	.scroll { overflow-x: auto; }
	table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.92rem;
	}
	th, td {
		padding: 0.5rem 0.75rem;
		text-align: left;
		border-bottom: 1px solid var(--color-border);
		white-space: nowrap;
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
	.badges { display: inline-flex; gap: 0.25rem; }
	.error { color: var(--color-danger); }
</style>
