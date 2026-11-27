<!--
	Example (Svelte 5): a person's cadrons, with a status dot each, a star to name it first in
	invitations, and how many addresses an invitation names. Copy and adapt; it is not built or
	published. A cadre-client store follows the Svelte store contract, so `$store` reads it.
	`client` is `createCadreClient(...)` from `@serfab/cadre-client/sereus`.
-->
<script lang="ts">
	import {
		cadreStore,
		cadronPresence,
		MAX_BOOTSTRAP_ADDRS,
		shortPeerId,
		type CadreMachine,
		type CadronPresence,
		type CadronPreferences,
	} from '@serfab/cadre-client';
	import type { CadreClient } from '@serfab/cadre-client/sereus';

	const { client }: { client: CadreClient } = $props();

	const machines = $derived(cadreStore(client));
	let prefs = $state<CadronPreferences | null>(null);

	$effect(() => {
		const read = () => { void client.invitations.preferences().then(p => { prefs = p; }); };
		read();
		return client.changes.invitations(read);
	});

	const DOT: Record<CadronPresence, string> = { connected: '#2c8a3f', recent: '#c98a00', quiet: '#888888', unknown: '#dddddd' };
	const PRESENCE: Record<CadronPresence, string> = {
		connected: 'Connected', recent: 'Running', quiet: 'Not heard from lately', unknown: 'Not heard from yet',
	};

	function toggleStar(m: CadreMachine) {
		if (!prefs) return;
		const preferred = prefs.preferred.includes(m.peerId)
			? prefs.preferred.filter(id => id !== m.peerId)
			: [...prefs.preferred, m.peerId];
		void client.invitations.setPreferences({ preferred });
	}

	function setCount(maxAddrs: number) {
		void client.invitations.setPreferences({ maxAddrs });
	}
</script>

{#if $machines.state === 'loading'}
	<p>Loading…</p>
{:else if $machines.state === 'failed'}
	<button onclick={() => machines.reload()}>{$machines.error.message} — retry</button>
{:else}
	<ul>
		{#each $machines.value.machines as m (m.peerId)}
			{@const presence = cadronPresence(m)}
			<li>
				<span class="dot" style:background={DOT[presence]}></span>
				<span class="grow">
					{m.thisDevice ? 'This device' : m.name || `Machine ${shortPeerId(m.peerId)}`}
					{#if !m.thisDevice}<small>{PRESENCE[presence]}{m.alwaysOn ? ' · Always on' : ''}</small>{/if}
				</span>
				{#if !m.thisDevice}
					<button onclick={() => toggleStar(m)} aria-label="Preferred for invitations">{m.preferred ? '★' : '☆'}</button>
				{/if}
			</li>
		{/each}
	</ul>
	{#if prefs}
		<p>
			Addresses per invitation:
			<button onclick={() => setCount(prefs!.maxAddrs - 1)} disabled={prefs.maxAddrs <= 1}>−</button>
			{prefs.maxAddrs}
			<button onclick={() => setCount(prefs!.maxAddrs + 1)} disabled={prefs.maxAddrs >= MAX_BOOTSTRAP_ADDRS}>+</button>
		</p>
	{/if}
{/if}

<style>
	ul { list-style: none; padding: 0; }
	li { display: flex; align-items: center; gap: 0.6rem; padding: 0.3rem 0; }
	.dot { width: 8px; height: 8px; border-radius: 50%; }
	.grow { flex: 1; display: flex; flex-direction: column; }
	small { color: #666; }
</style>
