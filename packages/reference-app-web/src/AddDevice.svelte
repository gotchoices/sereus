<script lang="ts">
	import { untrack } from 'svelte';
	import {
		OWNER_INVITATION_DEFAULT_TTL_MS,
		parseNullableStoredDatetimeMs,
		type CadreInvitationReach,
		type CadreInviteStatus,
	} from '@serfab/cadre-core';
	import { nodeState } from './lib/store.svelte.js';
	import {
		addDeviceState,
		approveRequest,
		cancelRequest,
		dismissMinted,
		makeOpenInvitation,
		refreshAddDevice,
		useRequest,
		withdrawInvitation,
		type NoticeArea,
	} from './lib/add-device.svelte.js';
	import { peerCode, validUntilText } from './lib/cadre-format.js';
	import Copyable from './lib/Copyable.svelte';
	import QrCode from './lib/QrCode.svelte';

	const node = nodeState();
	const add = addDeviceState();

	const OWNER_LINE =
		'An owner can add and remove devices and apps and approve everything in this cadre. Turn this off for an app that should only take part.';

	/** Shown before an open owner invitation is made: whoever holds its text becomes an owner. */
	const BEARER_WARNING = `Anyone who gets this invitation in the next ${OWNER_INVITATION_DEFAULT_TTL_MS / 60_000} minutes can manage your cadre. Send it only to your own app, and not through a chat or email others can read.`;

	/** What a minted invitation's reach means for the new app; nothing to add when it is `anywhere`. */
	const REACH_LINE: Record<CadreInvitationReach, { text: string; warning: boolean } | null> = {
		anywhere: null,
		'local-network': {
			text: "Your cadre's other machines are reachable only on their home network: the new app must be on the same Wi-Fi to join.",
			warning: false,
		},
		'issuer-only': {
			text: 'No always-on machine of your cadre can answer this invitation, so the new app can join only while this tab is open and reachable. Add an always-on node (a cadre-host machine can join with an invitation made here) to avoid this.',
			warning: true,
		},
	};

	const reachLine = $derived(add.minted ? REACH_LINE[add.minted.reach] : null);

	// The standing follows the owner step: a restart replaces the node, and an invitation
	// redeemed in place (an owner grant for the party the tab already runs) changes it with
	// the node still `running`, so the step's outcome is a dependency too.
	$effect(() => {
		if (node.status !== 'running' || node.owner === 'pending') return;
		untrack(() => void refreshAddDevice());
	});

	function confirmWithdraw(status: CadreInviteStatus): void {
		if (confirm('Withdraw this invitation? Nobody can join with it afterwards.')) {
			void withdrawInvitation(status.invite.key);
		}
	}

	function inviteTarget(status: CadreInviteStatus): string {
		return status.invite.peerId ? `For ${peerCode(status.invite.peerId)}` : 'Anyone with the text';
	}

	function inviteMeta(status: CadreInviteStatus): string {
		const { invite } = status;
		const uses = invite.totalUses !== null && invite.totalUses > 1 ? ` · ${status.usesRecorded} of ${invite.totalUses} used` : '';
		return `${invite.grantsOwner ? 'owner' : 'member'} · ${validUntilText(parseNullableStoredDatetimeMs(invite.expiresAt))}${uses}`;
	}
</script>

{#snippet ownerChoice(field: 'requestOwner' | 'openOwner', testId: string)}
	<label class="check">
		<input type="checkbox" bind:checked={add[field]} data-testid={testId} />
		Also an owner
	</label>
	<p class="hint">{OWNER_LINE}</p>
{/snippet}

{#snippet noticeFor(area: NoticeArea)}
	{#if add.notice?.area === area}
		<div class="notice" data-testid="add-device-notice">
			<strong>{add.notice.title}</strong>
			<p>{add.notice.message}</p>
			{#if add.notice.detail}<p class="detail">{add.notice.detail}</p>{/if}
		</div>
	{/if}
{/snippet}

<section class="card" data-testid="add-device">
	<h3>Add a device or app</h3>

	{#if node.status !== 'running'}
		<p class="hint">The node is not running.</p>
	{:else if add.standing === 'checking'}
		<p class="hint">Checking whether this tab is an owner of this cadre…</p>
	{:else if add.standing === 'member'}
		<p class="hint" data-testid="add-device-member">
			{#if node.owner === 'error'}
				Only an owner of this cadre can add a device or app, and this tab could not make itself the owner of its cadre (Home shows why).
			{:else}
				Only an owner of this cadre can add a device or app. This tab is a member.
			{/if}
		</p>
	{:else if add.standing === 'unreadable'}
		<p class="hint">Could not check whether this tab is an owner of this cadre.</p>
		<button onclick={() => void refreshAddDevice()}>Try again</button>
	{:else}
		{#if add.minted}
			<div class="minted" data-testid="minted-invitation">
				<h4>{add.minted.title}</h4>
				<QrCode text={add.minted.encoded} label={add.minted.title} />
				<div class="invitation-text" data-testid="minted-invitation-text">
					<Copyable value={add.minted.encoded} />
				</div>
				<p class="hint">{validUntilText(add.minted.expiresAtMs)}</p>
				{#if reachLine}
					<p class="hint" class:warn={reachLine.warning} data-testid="minted-invitation-reach">{reachLine.text}</p>
				{/if}
				<button onclick={dismissMinted} data-testid="btn-invitation-done">Done</button>
			</div>
		{:else if add.pending}
			<div class="approval" data-testid="join-request-approval">
				<h4>Add {add.pending.appName} to your cadre?</h4>
				<div class="row">
					<span class="label">App</span>
					<span class="value">{add.pending.appName}</span>
				</div>
				<p class="hint">The name is what the app calls itself; check the code below matches the one it shows.</p>
				<div class="row">
					<span class="label">Code</span>
					<code class="value">{peerCode(add.pending.peerId)}</code>
				</div>
				{@render ownerChoice('requestOwner', 'request-owner')}
				<div class="buttons">
					<button onclick={() => void approveRequest()} data-testid="btn-approve-request">Add</button>
					<button onclick={cancelRequest} data-testid="btn-cancel-request">Cancel</button>
				</div>
			</div>
		{:else}
			<h4>Paste request</h4>
			<p class="hint">
				In the other app, choose Join my existing cadre and copy its request, then paste it here. Only that app can use the invitation this makes.
			</p>
			<label for="join-request-in">The other app's request</label>
			<textarea
				id="join-request-in"
				rows="3"
				spellcheck="false"
				placeholder="sereus-join-request:1.…"
				bind:value={add.requestText}
				data-testid="join-request-in"
			></textarea>
			<div class="buttons">
				<button
					onclick={() => void useRequest()}
					disabled={add.minting !== null || !add.requestText.trim()}
					data-testid="btn-use-request"
				>
					{add.minting === 'request' ? 'Making the invitation…' : 'Use request'}
				</button>
			</div>
			{@render noticeFor('request')}

			<h4>Copy invitation</h4>
			<p class="hint">An open invitation: whichever app is given its text first can join with it.</p>
			{@render ownerChoice('openOwner', 'open-invitation-owner')}
			{#if add.openOwner}
				<p class="hint warn" data-testid="bearer-warning">{BEARER_WARNING}</p>
			{/if}
			<div class="buttons">
				<button onclick={() => void makeOpenInvitation()} disabled={add.minting !== null} data-testid="btn-make-invitation">
					{add.minting === 'open' ? 'Making the invitation…' : 'Make invitation'}
				</button>
			</div>
			{@render noticeFor('open')}
		{/if}

		<h4>Outstanding invitations</h4>
		{#if add.listError}
			<p class="bad">Could not read the invitations: {add.listError}</p>
		{:else if add.invitations.length === 0}
			<p class="hint">None.</p>
		{/if}
		<ul class="invites">
			{#each add.invitations as status (status.invite.key)}
				<li data-testid="invitation-row">
					<div>
						<div class="invite-for">{inviteTarget(status)}</div>
						<div class="invite-meta">{inviteMeta(status)}</div>
					</div>
					<button onclick={() => confirmWithdraw(status)} data-testid="btn-withdraw-invitation">Withdraw</button>
				</li>
			{/each}
		</ul>
		{@render noticeFor('list')}
		<div class="buttons">
			<button onclick={() => void refreshAddDevice()} data-testid="btn-refresh-invitations">Refresh</button>
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
		margin: 1.25rem 0 0.375rem 0;
		font-size: 0.8125rem;
		font-weight: 600;
		color: #4a4d54;
	}

	.minted h4,
	.approval h4 {
		margin-top: 0.5rem;
	}

	.hint {
		font-size: 0.8125rem;
		color: #6c6f76;
		margin: 0 0 0.5rem 0;
	}

	.hint.warn {
		color: #6b4d00;
		background: #fff6e0;
		border: 1px solid #f0d68a;
		border-radius: 0.375rem;
		padding: 0.5rem 0.625rem;
	}

	label {
		display: block;
		font-size: 0.8125rem;
		color: #6c6f76;
		margin-bottom: 0.25rem;
	}

	label.check {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		color: #1d1f24;
		font-size: 0.875rem;
		margin: 0.5rem 0 0.25rem 0;
	}

	textarea {
		width: 100%;
		font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
		font-size: 0.85rem;
		padding: 0.375rem 0.5rem;
		border: 1px solid #d4d6db;
		border-radius: 0.25rem;
		resize: vertical;
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

	.buttons {
		display: flex;
		gap: 0.5rem;
		margin: 0.5rem 0;
		flex-wrap: wrap;
	}

	.approval,
	.minted {
		display: grid;
		gap: 0.375rem;
		padding: 0.5rem 0.75rem;
		background: #eef0f4;
		border-radius: 0.375rem;
	}

	.minted > button {
		justify-self: start;
	}

	.invitation-text {
		max-width: 100%;
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

	.value {
		word-break: break-all;
	}

	code.value {
		font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
		font-size: 0.9rem;
	}

	.notice {
		color: #b3261e;
		font-size: 0.8125rem;
		margin: 0.25rem 0 0.5rem 0;
	}

	.notice p {
		margin: 0.125rem 0 0 0;
		word-break: break-word;
	}

	.notice .detail {
		color: #8a8d94;
	}

	.bad {
		color: #b3261e;
		font-size: 0.8125rem;
		margin: 0 0 0.5rem 0;
	}

	.invites {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 0.375rem;
	}

	.invites li {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		padding: 0.375rem 0.625rem;
		border: 1px solid #e3e5ea;
		border-radius: 0.375rem;
		background: white;
	}

	.invite-for {
		font-size: 0.875rem;
	}

	.invite-meta {
		font-size: 0.75rem;
		color: #8a8d94;
		margin-top: 0.125rem;
	}
</style>
