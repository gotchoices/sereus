<script lang="ts">
	import { nodeState, start, stop } from './lib/store.svelte.js';
	import {
		networkState,
		setBootstrapInput,
		hydrate,
		connect,
		disconnect,
	} from './lib/network.svelte.js';
	import { ensureReady as ensureMessagesReady } from './lib/messages.svelte.js';

	const node = nodeState();
	const net = networkState();

	let busy = $state(false);
	let panelError: string | null = $state(null);

	$effect(() => {
		if (node.status === 'running') {
			void hydrate();
			void ensureMessagesReady();
		}
	});

	async function handleRestart() {
		busy = true;
		panelError = null;
		try {
			await stop();
			await start();
			await ensureMessagesReady();
		} finally {
			busy = false;
		}
	}

	async function handleConnect() {
		busy = true;
		panelError = null;
		try {
			await connect();
		} catch (err) {
			panelError = err instanceof Error ? err.message : String(err);
		} finally {
			busy = false;
		}
	}

	async function handleDisconnect() {
		busy = true;
		panelError = null;
		try {
			await disconnect();
		} catch (err) {
			panelError = err instanceof Error ? err.message : String(err);
		} finally {
			busy = false;
		}
	}

	function onBootstrapInput(evt: Event) {
		const target = evt.currentTarget as HTMLTextAreaElement;
		setBootstrapInput(target.value);
	}
</script>

<section class="status">
	<div class="row">
		<span class="label">Status</span>
		<span class="value status-{node.status}" data-testid="home-status">{node.status}</span>
	</div>
	<div class="row">
		<span class="label">Mode</span>
		<span class="value mode-{node.mode}" data-testid="home-mode">{node.mode}</span>
	</div>
	<div class="row">
		<span class="label">Peer ID</span>
		<code class="value peer-id" data-testid="home-peer-id">{node.peerId ?? '—'}</code>
	</div>
	{#if node.error}
		<div class="row error">
			<span class="label">Error</span>
			<span class="value">{node.error}</span>
		</div>
	{/if}
</section>

<section class="actions">
	<button onclick={handleRestart} disabled={busy || node.status === 'starting'}>
		Restart node
	</button>
</section>

<section class="card">
	<h2>Network</h2>
	<p class="hint">
		Paste a bootstrap multiaddr (e.g.
		<code>/ip4/127.0.0.1/tcp/9091/ws/p2p/12D…</code>) and connect. Two browser
		tabs pointed at the same bootstrap converge on the same data after the
		next refresh tick.
	</p>
	<label for="bootstrap-input">Bootstrap multiaddr(s)</label>
	<textarea
		id="bootstrap-input"
		data-testid="bootstrap-input"
		rows="2"
		spellcheck="false"
		placeholder="/ip4/127.0.0.1/tcp/9091/ws/p2p/12D3..."
		value={net.bootstrapInput}
		oninput={onBootstrapInput}
	></textarea>

	<div class="net-actions">
		{#if node.mode === 'distributed'}
			<button onclick={handleDisconnect} disabled={busy} data-testid="btn-disconnect">
				Disconnect
			</button>
		{:else}
			<button
				onclick={handleConnect}
				disabled={busy || net.bootstrapInput.trim() === ''}
				data-testid="btn-connect"
			>
				Connect
			</button>
		{/if}
		{#if net.lastBootstrap && node.mode === 'solo'}
			<span class="last-used" data-testid="last-bootstrap">
				last used: <code>{net.lastBootstrap}</code>
			</span>
		{/if}
	</div>

	{#if panelError}
		<p class="panel-error">{panelError}</p>
	{/if}
</section>

<footer>
	{#if node.mode === 'solo'}
		<p>
			Solo mode: no bootstrap, no listen addresses. Identity persists in
			IndexedDB and survives reloads. Messages stored locally via the
			LocalTransactor.
		</p>
	{:else}
		<p>
			Distributed mode: writes fan out via NetworkTransactor through the
			configured bootstrap. Open a second tab to the same bootstrap to
			observe convergence after the next poll tick.
		</p>
	{/if}
</footer>

<style>
	.status {
		display: grid;
		gap: 0.5rem;
		padding: 1rem 1.25rem;
		border: 1px solid #e3e5ea;
		border-radius: 0.5rem;
		background: #fafbfc;
	}

	.row {
		display: grid;
		grid-template-columns: 6rem 1fr;
		gap: 1rem;
		align-items: baseline;
	}

	.label {
		font-size: 0.8125rem;
		font-weight: 500;
		color: #6c6f76;
	}

	.value {
		font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
		font-size: 0.9rem;
		word-break: break-all;
	}

	.peer-id {
		background: #eef0f4;
		padding: 0.125rem 0.375rem;
		border-radius: 0.25rem;
	}

	.status-running {
		color: #1f7a3b;
	}
	.status-starting {
		color: #8a5a00;
	}
	.status-error {
		color: #b3261e;
	}
	.status-idle,
	.status-stopped {
		color: #4a4d54;
	}

	.mode-solo {
		color: #6b4d00;
	}
	.mode-distributed {
		color: #1f7a3b;
	}

	.error .value {
		color: #b3261e;
	}

	.actions {
		margin-top: 1.5rem;
	}

	button {
		padding: 0.5rem 1rem;
		font: inherit;
		font-weight: 500;
		border: 1px solid #d4d6db;
		border-radius: 0.375rem;
		background: white;
		cursor: pointer;
	}

	button:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	.card {
		margin-top: 1.5rem;
		border: 1px solid #e3e5ea;
		border-radius: 0.5rem;
		background: #fafbfc;
		padding: 1rem 1.25rem;
	}

	.card h2 {
		margin: 0 0 0.25rem 0;
		font-size: 0.875rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: #4a4d54;
	}

	.hint {
		font-size: 0.8125rem;
		color: #6c6f76;
		margin: 0 0 0.75rem 0;
	}

	.hint code {
		font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
		font-size: 0.78rem;
		background: #eef0f4;
		padding: 0.0625rem 0.25rem;
		border-radius: 0.25rem;
	}

	label {
		display: block;
		font-size: 0.8125rem;
		color: #6c6f76;
		margin-bottom: 0.25rem;
	}

	textarea {
		width: 100%;
		font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
		font-size: 0.85rem;
		padding: 0.375rem 0.5rem;
		border: 1px solid #d4d6db;
		border-radius: 0.25rem;
		box-sizing: border-box;
		resize: vertical;
	}

	.net-actions {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		margin-top: 0.625rem;
	}

	.last-used {
		font-size: 0.75rem;
		color: #6c6f76;
	}

	.last-used code {
		font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
		font-size: 0.7rem;
		background: #eef0f4;
		padding: 0.0625rem 0.25rem;
		border-radius: 0.25rem;
	}

	.panel-error {
		margin: 0.625rem 0 0 0;
		color: #b3261e;
		font-size: 0.8125rem;
	}

	footer {
		margin-top: 2rem;
		color: #6c6f76;
		font-size: 0.875rem;
	}
</style>
