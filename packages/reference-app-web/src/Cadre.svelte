<script lang="ts">
	import JoinCadre from './JoinCadre.svelte';
	import AddDevice from './AddDevice.svelte';
	import Machines from './Machines.svelte';
	import { nodeState, start } from './lib/store.svelte.js';
	import { ownerFingerprint } from './lib/cadre-format.js';

	const node = nodeState();

	const removedBy = $derived(node.removed?.signerKey ? `an owner (${ownerFingerprint(node.removed.signerKey)})` : 'an owner');
	const starting = $derived(node.status === 'starting');
</script>

<section class="page">
	<header class="page-head">
		<h2>Cadre</h2>
	</header>

	<p class="hint">
		Your cadre is the set of devices and apps that hold your data together. An owner adds
		another device or app by giving it an invitation, and a tab that started on its own can
		join the cadre another app already holds.
	</p>

	<!-- Until a start reaches `running` again, so it stays while Go back starts and after that start fails. -->
	{#if node.removed}
		<section class="card removed" data-testid="removed-notice">
			<p class="line">
				This tab was removed from cadre <code>{node.removed.partyId}</code> by {removedBy}. Its copy of that
				cadre has been deleted from this browser.
			</p>
			<div class="buttons">
				{#if node.removed.formerPartyId !== undefined}
					<button onclick={() => void start()} disabled={starting} data-testid="btn-return-to-own-cadre">
						{starting ? 'Going back to your own cadre…' : 'Go back to your own cadre'}
					</button>
				{:else}
					<button onclick={() => void start()} disabled={starting} data-testid="btn-start-new-cadre">
						{starting ? 'Starting a new cadre…' : 'Start a new cadre'}
					</button>
				{/if}
			</div>
			<p class="hint">
				To join another cadre, start this tab's own first, then use Join my existing cadre below.
			</p>
		</section>
	{/if}

	<JoinCadre />
	<AddDevice />
	<Machines />
</section>

<style>
	.page-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 1rem;
		margin-bottom: 0.5rem;
	}

	h2 {
		margin: 0;
		font-size: 1.25rem;
		font-weight: 600;
	}

	.hint {
		font-size: 0.8125rem;
		color: #6c6f76;
		margin: 0;
	}

	.card {
		margin-top: 1.5rem;
		border: 1px solid #f0d68a;
		border-radius: 0.5rem;
		background: #fff6e0;
		padding: 1rem 1.25rem;
	}

	.line {
		margin: 0;
		font-size: 0.9rem;
		color: #1d1f24;
	}

	code {
		font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
		font-size: 0.85rem;
		word-break: break-all;
	}

	.buttons {
		display: flex;
		gap: 0.5rem;
		margin: 0.75rem 0 0.5rem 0;
		flex-wrap: wrap;
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
</style>
