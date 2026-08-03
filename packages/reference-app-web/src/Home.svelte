<script lang="ts">
	import { nodeState, restart } from './lib/store.svelte.js';
	import {
		formationState,
		setJoinInput,
		doCreateInvitation,
		doJoinViaInvitation,
	} from './lib/network.svelte.js';
	import { copyToClipboard } from './lib/diagnostics.svelte.js';
	import { ensureReady as ensureMessagesReady } from './lib/messages.svelte.js';

	const node = nodeState();
	const formation = formationState();

	let busy = $state(false);
	let copied = $state(false);

	const relayReady = $derived(node.relay.status === 'reserved');

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

	function onJoinInput(evt: Event) {
		const target = evt.currentTarget as HTMLTextAreaElement;
		setJoinInput(target.value);
	}

	async function onCopyInvitation() {
		if (!formation.invitation) return;
		copied = await copyToClipboard(formation.invitation.encoded);
		if (copied) setTimeout(() => (copied = false), 1500);
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
		<span class="label">Owner</span>
		<span class="value" data-testid="home-owner">{node.owner}</span>
	</div>
	<div class="row">
		<span class="label">Relay</span>
		<span
			class="value relay-{node.relay.status}"
			data-testid="home-relay"
			title={node.relay.error ?? ''}
		>
			{node.relay.status}
			{#if node.relay.status === 'reserved'}<span class="muted"> · dialable</span>{/if}
			{#if node.relay.error}<span class="muted"> · {node.relay.error}</span>{/if}
		</span>
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
	<h2>Strand formation</h2>
	<p class="hint">
		Form a <strong>closed</strong> chat strand with another party via the
		consent/invitation flow. One tab is the <em>responder</em> (creates an
		invitation), the other is the <em>initiator</em> (joins via it). The
		encoded invitation moves out-of-band — copy it from the responder and paste
		it into the initiator. Both tabs must be <strong>dialable</strong> through a
		circuit relay (see Relay status above).
	</p>

	{#if !relayReady}
		<p class="hint warn" data-testid="formation-relay-warning">
			⚠ This tab is not dialable (relay: <code>{node.relay.status}</code>).
			Creating an invitation needs a relay reservation — set
			<code>VITE_RELAY_ADDR</code> or <code>localStorage["relay-addr"]</code> to
			a circuit-relay multiaddr and restart. Joining still works if the pasted
			invitation reaches a dialable responder.
		</p>
	{/if}

	<div class="formation-grid">
		<div class="formation-col">
			<h3>Responder — create invitation</h3>
			<button
				onclick={doCreateInvitation}
				disabled={formation.createBusy || node.status !== 'running'}
				data-testid="btn-create-invitation"
			>
				{formation.createBusy ? 'Creating…' : 'Create invitation'}
			</button>
			{#if formation.createError}
				<p class="bad" data-testid="formation-create-error">{formation.createError}</p>
			{/if}
			{#if formation.invitation}
				<label for="invitation-out">Encoded invitation (copy to the other tab)</label>
				<textarea
					id="invitation-out"
					data-testid="invitation-out"
					rows="3"
					readonly
					spellcheck="false"
					value={formation.invitation.encoded}
				></textarea>
				<div class="net-actions">
					<button onclick={onCopyInvitation} data-testid="btn-copy-invitation">
						{copied ? 'Copied ✓' : 'Copy'}
					</button>
					<span class="muted">token <code>{formation.invitation.token}</code></span>
				</div>
			{/if}
		</div>

		<div class="formation-col">
			<h3>Initiator — join via invitation</h3>
			<label for="invitation-in">Paste an encoded invitation</label>
			<textarea
				id="invitation-in"
				data-testid="invitation-in"
				rows="3"
				spellcheck="false"
				placeholder="Paste the responder's encoded invitation here"
				value={formation.joinInput}
				oninput={onJoinInput}
				disabled={node.status !== 'running'}
			></textarea>
			<div class="net-actions">
				<button
					onclick={doJoinViaInvitation}
					disabled={formation.joinBusy || node.status !== 'running'}
					data-testid="btn-join"
				>
					{formation.joinBusy ? 'Forming…' : 'Form strand'}
				</button>
			</div>
			{#if formation.joinError}
				<p class="bad" data-testid="formation-join-error">{formation.joinError}</p>
			{/if}
			{#if formation.joined}
				<div class="joined" data-testid="formation-joined">
					<div class="row">
						<span class="label">Strand</span>
						<code class="value">{formation.joined.strandId}</code>
					</div>
					<div class="row">
						<span class="label">Membership</span>
						<span class="value">{formation.joined.type === 'c' ? 'closed (member key)' : 'open'}</span>
					</div>
				</div>
			{/if}
		</div>
	</div>
</section>

<footer>
	<p>
		Identity and party id persist in IndexedDB and survive reloads. The solo
		chat strand runs in bootstrap mode; a strand formed via an invitation is a
		closed strand keyed by the minted member key. Control-network authorization
		(owner keys, formation invites/usage, strand membership) is visible on
		the <a href="#/diag">Diagnostics</a> page.
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

	.relay-reserved {
		color: #1f7a3b;
	}
	.relay-dialing {
		color: #8a5a00;
	}
	/* In-progress, same as `dialing`: the reservation was lost and the node's
	   supervisor has the next attempt scheduled — not a resting failure. */
	.relay-retrying {
		color: #8a5a00;
	}
	.relay-error {
		color: #b3261e;
	}
	.relay-none {
		color: #8a8d94;
	}

	.hint.warn {
		color: #6b4d00;
		background: #fff6e0;
		border: 1px solid #f0d68a;
		border-radius: 0.375rem;
		padding: 0.5rem 0.625rem;
	}

	.formation-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr));
		gap: 1.25rem;
		margin-top: 0.5rem;
	}

	.formation-col h3 {
		margin: 0 0 0.5rem 0;
		font-size: 0.8125rem;
		font-weight: 600;
		color: #4a4d54;
	}

	.formation-col label {
		margin-top: 0.625rem;
	}

	.joined {
		margin-top: 0.625rem;
		display: grid;
		gap: 0.375rem;
		padding: 0.5rem 0.625rem;
		background: #eef0f4;
		border-radius: 0.375rem;
	}

	.joined .label {
		color: #6c6f76;
	}

	.bad {
		color: #b3261e;
		font-size: 0.8125rem;
		margin: 0.5rem 0 0 0;
	}

	footer {
		margin-top: 2rem;
		color: #6c6f76;
		font-size: 0.875rem;
	}
</style>
