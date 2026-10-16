<script lang="ts">
	import { untrack } from 'svelte';
	import { parseNullableStoredDatetimeMs, type CadreInviteStatus, type CadreMachine } from '@serfab/cadre-core';
	import { nodeState } from './lib/store.svelte.js';
	import {
		askToRemove,
		cancelRemoval,
		confirmRemoval,
		lastSeenText,
		LOST_DEVICE_LINE,
		machineCode,
		machineKind,
		machinesState,
		refreshMachines,
		removalEffects,
		REFUSAL_LINE,
		withdrawDeviceInvitation,
	} from './lib/machines.svelte.js';
	import { peerCode, validUntilText } from './lib/cadre-format.js';
	import { OWNER_KEYS_CARD_ID } from './lib/owner-keys.svelte.js';

	const node = nodeState();
	const list = machinesState();

	const NOT_OWNER_LINE = 'Only an owner of this cadre can remove machines. This tab is a member.';
	const UNREADABLE_LINE = 'Could not check whether this tab is an owner of this cadre, so nothing can be removed from here until Refresh reads it.';
	const KEEPS_LINE = "It keeps whatever it already copied, including the cadre's shared data. Removing it stops it syncing with this cadre's machines.";

	const owner = $derived(list.standing === 'owner');

	// As the "Add a device or app" card: a restart or a join replaces the node, and an owner grant
	// redeemed in place changes the standing with the node still `running`.
	$effect(() => {
		if (node.status !== 'running' || node.owner === 'pending') return;
		untrack(() => void refreshMachines());
	});

	function machineTitle(machine: CadreMachine): string {
		return machine.isSelf ? `${machineKind(machine)} (this tab)` : machineKind(machine);
	}

	function machineFacts(machine: CadreMachine): string {
		return [`Last seen ${lastSeenText(machine.lastPublishedAt, list.readAtMs)}`, `Key ${machineCode(machine)}`].join(' · ');
	}

	function pendingMeta(status: CadreInviteStatus): string {
		const { invite } = status;
		return `${peerCode(invite.peerId ?? '')} · ${invite.grantsOwner ? 'owner' : 'member'} · ${validUntilText(parseNullableStoredDatetimeMs(invite.expiresAt))}`;
	}

	/** Close the confirmation and bring the Owner keys card, further down the page, into view. */
	function showOwnerKeys(): void {
		cancelRemoval();
		document.getElementById(OWNER_KEYS_CARD_ID)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
	}

	function confirmWithdraw(status: CadreInviteStatus): void {
		if (confirm('Withdraw this invitation? Nobody can join with it afterwards.')) {
			void withdrawDeviceInvitation(status.invite.key);
		}
	}
</script>

<section class="card" data-testid="machines">
	<h3>Devices and nodes</h3>

	{#if node.status !== 'running'}
		<p class="hint">The node is not running.</p>
	{:else}
		{#if list.confirming}
			{@const removal = list.confirming}
			{@const refusal = removal.plan.refusal}
			<div class="confirm" data-testid="remove-machine-confirm">
				<h4>Remove this {machineKind(removal.machine).toLowerCase()}?</h4>
				<div class="row">
					<span class="label">Key</span>
					<code class="value">{machineCode(removal.machine)}</code>
				</div>
				{#if refusal !== null}
					<p class="text">{REFUSAL_LINE[refusal]}</p>
				{:else}
					<p class="text">{removalEffects(removal.plan)}</p>
					<p class="hint">{KEEPS_LINE}</p>
					<p class="hint warn" data-testid="lost-device-line">{LOST_DEVICE_LINE}</p>
				{/if}
				<div class="buttons">
					{#if refusal === null}
						<button class="danger" onclick={() => void confirmRemoval()} data-testid="btn-confirm-remove-machine">Remove</button>
						<button onclick={showOwnerKeys} data-testid="btn-show-owner-keys">Go to Owner keys</button>
					{/if}
					<button onclick={cancelRemoval} data-testid="btn-cancel-remove-machine">{refusal === null ? 'Cancel' : 'Close'}</button>
				</div>
			</div>
		{/if}

		{#if list.standing === 'member'}
			<p class="hint">{NOT_OWNER_LINE}</p>
		{:else if list.standing === 'unreadable'}
			<p class="hint">{UNREADABLE_LINE}</p>
		{/if}
		{#if list.listError}
			<p class="bad">Could not read the cadre's machines: {list.listError}</p>
		{/if}

		<ul class="machines">
			{#each list.machines as machine (machine.peerId)}
				<li data-testid="machine-row">
					<div class="item">
						<div>
							<div class="title">{machineTitle(machine)}</div>
							<div class="meta">{machineFacts(machine)}</div>
							<!-- `trusted` is always false for this tab: the membership predicate it reads excludes self. -->
							{#if !machine.isSelf && !machine.trusted}
								<div class="untrusted">Not trusted here</div>
							{/if}
						</div>
						{#if owner && !machine.isSelf}
							<button
								onclick={() => void askToRemove(machine)}
								disabled={list.busy || list.confirming !== null}
								data-testid="btn-remove-machine"
							>
								Remove
							</button>
						{/if}
					</div>
					{#if owner && machine.isSelf}
						<p class="hint self">{REFUSAL_LINE.self}</p>
					{/if}
				</li>
			{/each}
			{#each list.pending as status (status.invite.key)}
				<li data-testid="invited-device-row">
					<div class="item">
						<div>
							<div class="title">Invited, not joined yet</div>
							<div class="meta">{pendingMeta(status)}</div>
						</div>
						{#if owner}
							<button onclick={() => confirmWithdraw(status)} data-testid="btn-withdraw-device-invitation">Withdraw</button>
						{/if}
					</div>
				</li>
			{/each}
		</ul>

		{#if list.notice}
			<div class="notice" data-testid="machines-notice">
				<strong>{list.notice.title}</strong>
				<p>{list.notice.message}</p>
			</div>
		{/if}
		<div class="buttons">
			<button onclick={() => void refreshMachines()} data-testid="btn-refresh-machines">Refresh</button>
		</div>
	{/if}
</section>

<style>
	.card {
		margin-top: 1.5rem;
		border: 1px solid #e3e5ea;
		border-radius: 0.5rem;
		background: #fafbfc;
		padding: 1rem 1.25rem;
	}

	h3 {
		margin: 0 0 0.5rem 0;
		font-size: 0.875rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: #4a4d54;
	}

	h4 {
		margin: 0.5rem 0 0.375rem 0;
		font-size: 0.8125rem;
		font-weight: 600;
		color: #4a4d54;
	}

	.hint {
		font-size: 0.8125rem;
		color: #6c6f76;
		margin: 0 0 0.5rem 0;
	}

	.hint.self {
		margin: 0.25rem 0 0 0;
	}

	.hint.warn {
		color: #6b4d00;
	}

	.text {
		font-size: 0.875rem;
		margin: 0.25rem 0 0.5rem 0;
	}

	.confirm {
		display: grid;
		gap: 0.25rem;
		padding: 0.5rem 0.75rem;
		margin-bottom: 0.75rem;
		background: #eef0f4;
		border-radius: 0.375rem;
	}

	.row {
		display: grid;
		grid-template-columns: 4rem 1fr;
		gap: 0.75rem;
		align-items: baseline;
	}

	.label {
		font-size: 0.8125rem;
		font-weight: 500;
		color: #6c6f76;
	}

	code.value {
		font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
		font-size: 0.9rem;
		word-break: break-all;
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

	button.danger {
		color: #b3261e;
		border-color: #e3b4b0;
	}

	.buttons {
		display: flex;
		gap: 0.5rem;
		margin: 0.5rem 0;
		flex-wrap: wrap;
	}

	.machines {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 0.375rem;
	}

	.machines li {
		padding: 0.375rem 0.625rem;
		border: 1px solid #e3e5ea;
		border-radius: 0.375rem;
		background: white;
	}

	.item {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
	}

	.title {
		font-size: 0.875rem;
	}

	.meta {
		font-size: 0.75rem;
		color: #8a8d94;
		margin-top: 0.125rem;
		word-break: break-word;
	}

	.untrusted {
		font-size: 0.75rem;
		color: #8a5a00;
		margin-top: 0.125rem;
	}

	.notice {
		color: #b3261e;
		font-size: 0.8125rem;
		margin: 0.5rem 0;
	}

	.notice p {
		margin: 0.125rem 0 0 0;
		word-break: break-word;
	}

	.bad {
		color: #b3261e;
		font-size: 0.8125rem;
		margin: 0 0 0.5rem 0;
	}
</style>
