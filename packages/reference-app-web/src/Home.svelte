<script lang="ts">
	import { nodeState, restart } from './lib/store.svelte.js';
	import { networkState, setSeedInput } from './lib/network.svelte.js';
	import { ensureReady as ensureMessagesReady } from './lib/messages.svelte.js';

	const node = nodeState();
	const net = networkState();

	let busy = $state(false);

	$effect(() => {
		if (node.status === 'running') {
			void ensureMessagesReady();
		}
	});

	async function handleRestart() {
		busy = true;
		try {
			await restart();
			await ensureMessagesReady();
		} finally {
			busy = false;
		}
	}

	function onSeedInput(evt: Event) {
		const target = evt.currentTarget as HTMLTextAreaElement;
		setSeedInput(target.value);
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
		<span class="label">Party ID</span>
		<code class="value party-id" data-testid="home-party-id">{node.partyId ?? '—'}</code>
	</div>
	<div class="row">
		<span class="label">Peer ID</span>
		<code class="value peer-id" data-testid="home-peer-id">{node.peerId ?? '—'}</code>
	</div>
	<div class="row">
		<span class="label">Control</span>
		<span
			class="value control-{node.controlConnected ? 'up' : 'down'}"
			data-testid="home-control"
		>
			{node.controlConnected ? 'connected' : 'disconnected'}
		</span>
	</div>
	<div class="row">
		<span class="label">Chat strand</span>
		<span class="value strand-{node.strandStatus}" data-testid="home-strand-status">
			{node.strandStatus ?? '—'}
			{#if node.strandPeers != null}<span class="muted"> · {node.strandPeers} peers</span>{/if}
		</span>
	</div>
	<div class="row">
		<span class="label">Authority</span>
		<span class="value" data-testid="home-authority">{node.authority}</span>
	</div>
	{#if node.error}
		<div class="row error">
			<span class="label">Error</span>
			<span class="value">{node.error}</span>
		</div>
	{/if}
	{#if node.strandError}
		<div class="row error">
			<span class="label">Strand error</span>
			<span class="value" data-testid="home-strand-error">{node.strandError}</span>
		</div>
	{/if}
</section>

<section class="actions">
	<button onclick={handleRestart} disabled={busy || node.status === 'starting'}>
		Restart node
	</button>
</section>

<section class="card">
	<h2>Cadre</h2>
	<p class="hint">
		This browser is a real <strong>Sereus cadre node</strong>: it runs a control
		network (<code>CadreControl</code>), self-seeds as its own authority, and
		hosts a signed open chat strand. Phase 1 is a solo single-node cadre.
	</p>
	<label for="seed-input">Control-network seed (Phase 2)</label>
	<textarea
		id="seed-input"
		data-testid="seed-input"
		rows="2"
		spellcheck="false"
		placeholder="Joining another party's cadre via a signed seed lands in Phase 2"
		value={net.seedInput}
		oninput={onSeedInput}
		disabled
	></textarea>
	<div class="net-actions">
		<button disabled data-testid="btn-join" title="Phase 2">Join cadre (Phase 2)</button>
		<span class="muted">consent formation · RBAC · cross-party convergence — forthcoming</span>
	</div>
</section>

<footer>
	<p>
		Solo cadre: no control bootstrap, no listen addresses. Identity and party id
		persist in IndexedDB and survive reloads. Messages are stored in the chat
		strand's IndexedDB-backed database via its bootstrap-mode local transactor.
	</p>
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
		grid-template-columns: 7rem 1fr;
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

	.muted {
		color: #8a8d94;
	}

	.party-id,
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

	.control-up,
	.strand-active {
		color: #1f7a3b;
	}
	.control-down {
		color: #b3261e;
	}
	.strand-starting {
		color: #8a5a00;
	}
	.strand-error {
		color: #b3261e;
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
		flex-wrap: wrap;
	}

	.net-actions .muted {
		font-size: 0.75rem;
	}

	footer {
		margin-top: 2rem;
		color: #6c6f76;
		font-size: 0.875rem;
	}
</style>
