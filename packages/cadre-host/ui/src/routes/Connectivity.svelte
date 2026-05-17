<script lang="ts">
	import { onMount } from 'svelte';

	import { apiFetch, apiPost, apiPut, ApiError } from '../lib/api.js';
	import {
		appState,
		refreshConnectivity,
		pushToast,
	} from '../lib/state.svelte.js';
	import { formatRelativeTime } from '../lib/format.js';

	import ConnectivityBadge from '../components/ConnectivityBadge.svelte';

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
	let externalPort: number = $state(4001);

	let testing = $state(false);
	let savingDdns = $state(false);
	let savingPort = $state(false);

	const currentProvider = $derived(
		providers.find((p) => p.id === providerId) ?? null,
	);

	const needsFix = $derived(
		!!app.connectivity &&
		(app.connectivity.directReachability === 'unreachable' ||
			app.connectivity.portMode === 'failed'),
	);

	const cgnatDetected = $derived(app.connectivity?.cgnatDetected === true);

	onMount(() => {
		void refreshConnectivity();
		void loadProviders();
	});

	$effect(() => {
		const c = app.connectivity;
		if (!c) return;
		if (providerId === '' && c.ddns.providerId) providerId = c.ddns.providerId;
		if (hostname === '' && c.ddns.hostname) hostname = c.ddns.hostname;
		externallyManaged = c.ddns.externallyManaged;
		externalPort = c.externalPort;
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

	async function savePortSettings(event: Event): Promise<void> {
		event.preventDefault();
		savingPort = true;
		try {
			await apiPut('/nat/settings', { upnpEnabled, externalPort });
			pushToast('success', 'Port settings saved');
			await refreshConnectivity();
		} catch (err) {
			pushToast('error', `Save failed: ${(err as Error).message}`);
		} finally {
			savingPort = false;
		}
	}
</script>

<section class="stack">
	<header>
		<h2>Connectivity</h2>
		<p class="muted">How the outside world reaches your cadre.</p>
	</header>

	<div class="grid two">
		<div class="card status-card">
			<h3>Current status</h3>
			{#if app.connectivity}
				<ConnectivityBadge
					reachability={app.connectivity.directReachability}
					portMode={app.connectivity.portMode}
				/>
				<dl class="kv">
					<div><dt>External IP</dt><dd>{app.connectivity.externalIp ?? '—'}</dd></div>
					<div><dt>Router IP</dt><dd>{app.connectivity.routerExternalIp ?? '—'}</dd></div>
					<div><dt>External port</dt><dd>{app.connectivity.externalPort}</dd></div>
					<div><dt>Internal port</dt><dd>{app.connectivity.internalPort}</dd></div>
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

		{#if needsFix || cgnatDetected}
			<div class="card warning">
				<h3>Manual fix</h3>
				{#if cgnatDetected}
					<p>Your ISP is using Carrier-Grade NAT (CGNAT). You'll need to either:</p>
					<ul>
						<li>Ask your ISP for a public IP.</li>
						<li>Use a relay / tunnel (e.g. Cloudflare Tunnel, Tailscale Funnel).</li>
					</ul>
				{:else}
					<p>Your cadre isn't reachable from the open internet. The most likely causes:</p>
					<ul>
						<li>Your router doesn't allow UPnP / NAT-PMP — open it and enable the feature, or set up a manual port-forward for port {app.connectivity?.externalPort}.</li>
						<li>A firewall on this machine is blocking inbound TCP on port {app.connectivity?.internalPort}.</li>
					</ul>
				{/if}
				<p class="muted small">
					See <a href="https://github.com/gotchoices/sereus/blob/master/docs/cadre-host.md" target="_blank" rel="noreferrer">docs/cadre-host.md</a> for vendor-specific router instructions.
				</p>
			</div>
		{/if}
	</div>

	<form class="card stack" onsubmit={savePortSettings}>
		<h3>Port forwarding</h3>
		<label class="row inline">
			<input type="checkbox" bind:checked={upnpEnabled} />
			<span>Attempt UPnP / NAT-PMP automatically</span>
		</label>
		<div>
			<label for="external-port">External port</label>
			<input id="external-port" type="number" min="1" max="65535" bind:value={externalPort} />
		</div>
		<div class="actions">
			<button type="submit" class="primary" disabled={savingPort}>
				{savingPort ? 'Saving…' : 'Save port settings'}
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
	.warning {
		background: var(--color-warn-bg);
		border-color: var(--color-warn);
	}
	.warning ul { margin: 0; padding-left: 1.25rem; }
	.actions { display: flex; justify-content: flex-end; gap: 0.5rem; }
	.small { font-size: 0.85rem; }
</style>
