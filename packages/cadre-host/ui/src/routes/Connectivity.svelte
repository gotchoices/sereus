<script lang="ts">
	import { onMount } from 'svelte';

	import { apiFetch, apiPost, apiPut, ApiError } from '../lib/api.js';
	import {
		appState,
		refreshConnectivity,
		refreshHostedNodes,
		pushToast,
	} from '../lib/state.svelte.js';
	import { formatRelativeTime } from '../lib/format.js';
	import { hostedLabel } from '../lib/hosted-nodes.js';
	import { hrefFor } from '../lib/router.js';

	import ConnectivityBadge from '../components/ConnectivityBadge.svelte';
	import NodeReachabilityCard from '../components/NodeReachabilityCard.svelte';

	type DdnsProvider = {
		id: string;
		displayName: string;
		configFields: Array<{ key: string; label: string; secret: boolean }>;
	};

	const app = appState();

	let providers: DdnsProvider[] = $state([]);
	let providerId = $state('');
	let hostname = $state('');
	let externallyManaged = $state(false);
	let fieldValues: Record<string, string> = $state({});
	let upnpEnabled = $state(true);

	let testing = $state(false);
	let savingDdns = $state(false);
	let savingUpnp = $state(false);

	const currentProvider = $derived(
		providers.find((p) => p.id === providerId) ?? null,
	);

	const runningNodes = $derived((app.connectivity?.nodes ?? []).filter((n) => n.running));
	const unreachableCount = $derived(runningNodes.filter((n) => n.verdict === 'unreachable').length);

	const cgnatDetected = $derived(app.connectivity?.cgnatDetected === true);

	onMount(() => {
		void refreshConnectivity();
		void refreshHostedNodes();
		void loadProviders();
	});

	$effect(() => {
		const c = app.connectivity;
		if (!c) return;
		if (providerId === '' && c.ddns.providerId) providerId = c.ddns.providerId;
		if (hostname === '' && c.ddns.hostname) hostname = c.ddns.hostname;
		externallyManaged = c.ddns.externallyManaged;
		upnpEnabled = c.upnpEnabled;
	});

	async function loadProviders(): Promise<void> {
		try {
			const list = await apiFetch<DdnsProvider[]>('/nat/providers');
			providers = list;
		} catch (err) {
			pushToast('error', `Could not load DDNS providers: ${(err as Error).message}`);
		}
	}

	async function testReachability(): Promise<void> {
		testing = true;
		try {
			await apiPost('/nat/test');
			pushToast('success', 'Reachability test complete');
			await refreshConnectivity();
		} catch (err) {
			pushToast('error', `Test failed: ${(err as Error).message}`);
		} finally {
			testing = false;
		}
	}

	async function saveDdns(event: Event): Promise<void> {
		event.preventDefault();
		savingDdns = true;
		try {
			await apiPut('/nat/ddns', {
				providerId,
				hostname,
				config: { ...fieldValues },
				externallyManaged,
			});
			pushToast('success', 'DDNS settings saved');
			fieldValues = {};
			await refreshConnectivity();
		} catch (err) {
			const code = err instanceof ApiError ? err.code : 'error';
			pushToast('error', `Save failed: ${(err as Error).message} (${code})`);
		} finally {
			savingDdns = false;
		}
	}

	async function saveUpnp(event: Event): Promise<void> {
		event.preventDefault();
		savingUpnp = true;
		try {
			await apiPut('/nat/settings', { upnpEnabled });
			pushToast('success', 'Port mapping settings saved');
			await refreshConnectivity();
		} catch (err) {
			pushToast('error', `Save failed: ${(err as Error).message}`);
		} finally {
			savingUpnp = false;
		}
	}
</script>

<section class="stack">
	<header>
		<h2>Connectivity</h2>
		<p class="muted">How the outside world reaches the nodes this machine runs.</p>
	</header>

	<div class="grid two">
		<div class="card status-card">
			<h3>Current status</h3>
			{#if app.connectivity}
				<ConnectivityBadge reachability={app.connectivity.directReachability} />
				<dl class="kv">
					<div><dt>UPnP</dt><dd>{app.connectivity.upnpEnabled ? 'on' : 'off'}</dd></div>
					<div>
						<dt>Router</dt>
						<dd>
							{#if app.connectivity.gateway.found}
								found · this machine is {app.connectivity.gateway.lanAddress ?? '—'} on its network
							{:else}
								not found{app.connectivity.gateway.lastError ? ` · ${app.connectivity.gateway.lastError}` : ''}
							{/if}
						</dd>
					</div>
					<div><dt>External IP</dt><dd>{app.connectivity.externalIp ?? '—'}</dd></div>
					<div><dt>Router IP</dt><dd>{app.connectivity.gateway.routerExternalIp ?? '—'}</dd></div>
					<div><dt>Last tested</dt><dd>{formatRelativeTime(app.connectivity.lastTestedAt)}</dd></div>
					<div><dt>External IP detected</dt><dd>{formatRelativeTime(app.connectivity.externalIpDetectedAt)}</dd></div>
				</dl>
				<button onclick={testReachability} disabled={testing}>
					{testing ? 'Testing…' : 'Test reachability'}
				</button>
			{:else}
				<p class="muted">Loading…</p>
			{/if}
		</div>

		{#if cgnatDetected}
			<div class="card warning">
				<h3>Behind carrier-grade NAT</h3>
				<p>Your ISP appears to use carrier-grade NAT (CGNAT), so a port forward on your router will not help. Ask your ISP for a public IP address.</p>
				<p>A relay would reach nodes behind CGNAT, but cadre-host cannot reserve one for its nodes yet.</p>
				<p class="muted small">The detection can be wrong. If you did forward ports, enter them on each node below.</p>
			</div>
		{:else if unreachableCount > 0}
			<div class="card warning">
				<h3>Needs a port forward</h3>
				<p>
					{unreachableCount} of {runningNodes.length} running {runningNodes.length === 1 ? 'node' : 'nodes'} cannot be reached from outside your home network.
					Each one below says which ports to forward on your router, and to which address.
				</p>
				<p class="muted small">
					See <a href="https://github.com/gotchoices/sereus/blob/master/docs/cadre-host.md#manual-port-forwarding" target="_blank" rel="noreferrer">docs/cadre-host.md</a> for how manual forwarding works.
				</p>
			</div>
		{/if}
	</div>

	<div class="card stack">
		<h3>Nodes</h3>
		{#if !app.connectivity}
			<p class="muted">Loading…</p>
		{:else if app.connectivity.nodes.length === 0}
			<p class="muted">No nodes are running on this machine yet.</p>
		{:else}
			<ul class="nodes">
				{#each app.connectivity.nodes as n (n.nodeId)}
					<li>
						<NodeReachabilityCard node={n} connectivity={app.connectivity}>
							{#snippet header()}
								<a href={hrefFor('node-detail', { id: n.nodeId })}><strong><code>{n.nodeId}</code></strong></a>
								<span class="muted small">{hostedLabel(app.hostedNodes.list.find((h) => h.id === n.nodeId))}</span>
							{/snippet}
						</NodeReachabilityCard>
					</li>
				{/each}
			</ul>
		{/if}
	</div>

	<form class="card stack" onsubmit={saveUpnp}>
		<h3>Port mapping</h3>
		<label class="row inline">
			<input type="checkbox" bind:checked={upnpEnabled} />
			<span>Ask the router to map each node's ports automatically (UPnP)</span>
		</label>
		<div class="actions">
			<button type="submit" class="primary" disabled={savingUpnp}>
				{savingUpnp ? 'Saving…' : 'Save'}
			</button>
		</div>
	</form>

	<form class="card stack" onsubmit={saveDdns}>
		<h3>Dynamic DNS</h3>
		<p class="muted">Publish a stable hostname so your friends don't need to track your IP.</p>

		<div>
			<label for="ddns-provider">Provider</label>
			<select id="ddns-provider" bind:value={providerId}>
				<option value="">— none —</option>
				{#each providers as p (p.id)}
					<option value={p.id}>{p.displayName}</option>
				{/each}
			</select>
		</div>

		<div>
			<label for="ddns-hostname">Hostname</label>
			<input
				id="ddns-hostname"
				type="text"
				bind:value={hostname}
				placeholder="e.g. yourname.duckdns.org"
				autocomplete="off"
			/>
		</div>

		{#if currentProvider}
			{#each currentProvider.configFields as field (field.key)}
				<div>
					<label for={`ddns-${field.key}`}>
						{field.label}
						{#if field.secret}
							<span class="muted small"> (stored in OS keychain)</span>
						{/if}
					</label>
					<input
						id={`ddns-${field.key}`}
						type={field.secret ? 'password' : 'text'}
						value={fieldValues[field.key] ?? ''}
						oninput={(e) => (fieldValues = { ...fieldValues, [field.key]: (e.currentTarget as HTMLInputElement).value })}
						autocomplete="off"
					/>
				</div>
			{/each}
		{/if}

		<label class="row inline">
			<input type="checkbox" bind:checked={externallyManaged} />
			<span>I manage this DDNS record outside cadre-host (don't auto-update)</span>
		</label>

		<div class="actions">
			<button type="submit" class="primary" disabled={savingDdns || providerId === ''}>
				{savingDdns ? 'Saving…' : 'Save DDNS settings'}
			</button>
		</div>

		{#if app.connectivity?.ddns.lastUpdateAt}
			<p class="muted small">
				Last DDNS update {formatRelativeTime(app.connectivity.ddns.lastUpdateAt)}
				{app.connectivity.ddns.lastUpdateOk === true ? '· ok' : app.connectivity.ddns.lastUpdateOk === false ? `· failed: ${app.connectivity.ddns.lastError ?? 'error'}` : ''}
			</p>
		{/if}
	</form>
</section>

<style>
	.grid.two { grid-template-columns: repeat(auto-fit, minmax(20rem, 1fr)); }
	.kv {
		margin: var(--space-3) 0;
		display: grid;
		grid-template-columns: max-content 1fr;
		gap: var(--space-1) var(--space-3);
		font-size: 0.9rem;
	}
	.kv > div { display: contents; }
	.kv dt { color: var(--color-text-muted); }
	.kv dd { margin: 0; }
	.row.inline { gap: 0.5rem; }
	.row.inline input[type='checkbox'] { width: auto; }
	.nodes { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-3); }
	.nodes li { border-top: 1px solid var(--color-border); padding-top: var(--space-3); }
	.nodes li:first-child { border-top: 0; padding-top: 0; }
	.warning {
		background: var(--color-warn-bg);
		border-color: var(--color-warn);
	}
	.actions { display: flex; justify-content: flex-end; gap: 0.5rem; }
	.small { font-size: 0.85rem; }
</style>
