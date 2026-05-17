<script lang="ts">
	import { onMount } from 'svelte';

	import { apiPost, apiPut, ApiError } from '../lib/api.js';
	import {
		appState,
		refreshSettings,
		refreshUpdate,
		pushToast,
	} from '../lib/state.svelte.js';
	import { formatRelativeTime } from '../lib/format.js';

	import CopyIcon from '../components/icons/CopyIcon.svelte';

	const app = appState();

	let autoApply = $state(false);
	let manifestUrl = $state('');
	let savingUpdates = $state(false);
	let applying = $state(false);

	onMount(() => {
		void refreshSettings();
		void refreshUpdate();
	});

	$effect(() => {
		const s = app.settings;
		if (!s) return;
		autoApply = s.updates.autoApply;
		manifestUrl = s.updates.manifestUrl ?? '';
	});

	async function saveUpdates(event: Event): Promise<void> {
		event.preventDefault();
		savingUpdates = true;
		try {
			const body: { updates: { autoApply: boolean; manifestUrl?: string } } = {
				updates: { autoApply },
			};
			if (manifestUrl.trim()) body.updates.manifestUrl = manifestUrl.trim();
			await apiPut('/api/settings', body);
			pushToast('success', 'Update preferences saved');
			await refreshSettings();
		} catch (err) {
			const code = err instanceof ApiError ? err.code : 'error';
			pushToast('error', `Save failed: ${(err as Error).message} (${code})`);
		} finally {
			savingUpdates = false;
		}
	}

	async function applyUpdate(): Promise<void> {
		applying = true;
		try {
			const r = await apiPost<{ fromVersion: string; toVersion: string; restarted: boolean }>(
				'/update/apply',
			);
			pushToast(
				'success',
				`Applied ${r.fromVersion} → ${r.toVersion}` +
					(r.restarted ? ' (service restarting)' : ''),
			);
			await refreshUpdate();
		} catch (err) {
			const code = err instanceof ApiError ? err.code : 'error';
			pushToast('error', `Apply failed: ${(err as Error).message} (${code})`);
		} finally {
			applying = false;
		}
	}

	async function copy(text: string): Promise<void> {
		try {
			await navigator.clipboard.writeText(text);
			pushToast('success', 'Copied');
		} catch (err) {
			pushToast('error', `Copy failed: ${(err as Error).message}`);
		}
	}
</script>

<section class="stack">
	<header>
		<h2>Settings</h2>
		<p class="muted">Update preferences and install metadata.</p>
	</header>

	<form class="card stack" onsubmit={saveUpdates}>
		<h3>Updates</h3>
		<label class="row inline">
			<input type="checkbox" bind:checked={autoApply} />
			<span>Apply updates automatically when available</span>
		</label>
		<div>
			<label for="manifest-url">Manifest URL (optional override)</label>
			<input
				id="manifest-url"
				type="url"
				bind:value={manifestUrl}
				placeholder="https://example.org/latest.json"
				autocomplete="off"
			/>
		</div>

		{#if app.update?.available?.version}
			<div class="banner info">
				<div>
					<strong>Update available</strong>
					<span class="muted"> → version {app.update.available.version}</span>
					{#if app.update.available.releaseNotesUrl}
						<a href={app.update.available.releaseNotesUrl} target="_blank" rel="noreferrer">Release notes</a>
					{/if}
				</div>
				<button type="button" class="primary" onclick={applyUpdate} disabled={applying}>
					{applying ? 'Applying…' : 'Apply now'}
				</button>
			</div>
		{:else if app.update?.lastChecked}
			<p class="muted small">No update available. Last checked {formatRelativeTime(app.update.lastChecked)}.</p>
		{/if}

		{#if app.update?.lastError}
			<p class="error small">Last error: {app.update.lastError.message} ({app.update.lastError.code})</p>
		{/if}

		<div class="actions">
			<button type="submit" class="primary" disabled={savingUpdates}>
				{savingUpdates ? 'Saving…' : 'Save update preferences'}
			</button>
		</div>
	</form>

	<div class="card">
		<h3>Install</h3>
		{#if app.settings}
			<dl class="kv">
				<div><dt>Install ID</dt><dd><code>{app.settings.installId}</code></dd></div>
				<div><dt>Installed at</dt><dd>{formatRelativeTime(app.settings.installedAt)}</dd></div>
				<div><dt>Installer version</dt><dd>{app.settings.installerVersion ?? '—'}</dd></div>
				<div><dt>UI port</dt><dd>{app.settings.uiPort}</dd></div>
				<div><dt>libp2p port</dt><dd>{app.settings.libp2pPort}</dd></div>
				<div>
					<dt>Data dir</dt>
					<dd class="copy-row">
						<code>{app.settings.dataDir}</code>
						<button type="button" class="ghost" aria-label="Copy data dir" onclick={() => copy(app.settings!.dataDir)}>
							<CopyIcon />
						</button>
					</dd>
				</div>
				<div>
					<dt>Identity</dt>
					<dd class="copy-row">
						<code>{app.settings.identityPath}</code>
						<button type="button" class="ghost" aria-label="Copy identity path" onclick={() => copy(app.settings!.identityPath)}>
							<CopyIcon />
						</button>
					</dd>
				</div>
			</dl>
			<p class="muted small">UI port, libp2p port, and data dir are set at install time and can only be changed by editing <code>host.config.json</code> and restarting the service.</p>
		{:else}
			<p class="muted">Loading…</p>
		{/if}
	</div>

	<div class="card">
		<h3>Uninstall</h3>
		<p class="muted">
			Stop the cadre-host service, then remove the data directory above and the
			installed package:
		</p>
		<pre>npm uninstall -g @serfab/cadre-host</pre>
		<p class="muted small">
			See the README under <a href="https://github.com/gotchoices/sereus/blob/master/packages/cadre-host/README.md" target="_blank" rel="noreferrer">Uninstall</a> for OS-specific service teardown.
		</p>
	</div>
</section>

<style>
	.row.inline { gap: 0.5rem; }
	.row.inline input[type='checkbox'] { width: auto; }
	.banner {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
		padding: var(--space-3);
		border-radius: var(--radius);
		background: var(--color-info-bg);
		color: var(--color-info);
		border: 1px solid var(--color-info);
		flex-wrap: wrap;
	}
	.kv {
		margin: var(--space-3) 0;
		display: grid;
		grid-template-columns: max-content 1fr;
		gap: var(--space-1) var(--space-3);
		font-size: 0.92rem;
	}
	.kv > div { display: contents; }
	.kv dt { color: var(--color-text-muted); }
	.kv dd { margin: 0; }
	.copy-row {
		display: flex;
		align-items: center;
		gap: 0.375rem;
	}
	.actions { display: flex; justify-content: flex-end; }
	.small { font-size: 0.85rem; }
	.error { color: var(--color-danger); }
</style>
