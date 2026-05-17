<script lang="ts">
	import { onMount } from 'svelte';

	import { apiDelete, ApiError } from '../lib/api.js';
	import {
		appState,
		refreshTrustCircle,
		pushToast,
		type PendingInvite,
		type TrustCircleMember,
	} from '../lib/state.svelte.js';
	import { formatRelativeTime, shortPeerId } from '../lib/format.js';

	import ConfirmDialog from '../components/ConfirmDialog.svelte';
	import InviteModal from '../components/InviteModal.svelte';

	const app = appState();

	let inviteOpen = $state(false);
	let confirmMember: TrustCircleMember | null = $state(null);
	let confirmInvite: PendingInvite | null = $state(null);

	onMount(() => {
		void refreshTrustCircle();
	});

	async function revokeMember(): Promise<void> {
		const member = confirmMember;
		if (!member) return;
		try {
			await apiDelete(`/auth/members/${encodeURIComponent(member.peerId)}`);
			pushToast('success', `Removed ${member.label || shortPeerId(member.peerId)}`);
			await refreshTrustCircle();
		} catch (err) {
			const code = err instanceof ApiError ? err.code : 'error';
			const msg = err instanceof Error ? err.message : String(err);
			pushToast('error', `Remove failed: ${msg} (${code})`);
		} finally {
			confirmMember = null;
		}
	}

	async function revokeInvite(): Promise<void> {
		const invite = confirmInvite;
		if (!invite) return;
		try {
			await apiDelete(`/auth/invites/${encodeURIComponent(invite.token)}`);
			pushToast('success', `Revoked invite for ${invite.label}`);
			await refreshTrustCircle();
		} catch (err) {
			const code = err instanceof ApiError ? err.code : 'error';
			const msg = err instanceof Error ? err.message : String(err);
			pushToast('error', `Revoke failed: ${msg} (${code})`);
		} finally {
			confirmInvite = null;
		}
	}
</script>

<section class="stack">
	<header class="page-header">
		<div>
			<h2>Trust Circle</h2>
			<p class="muted">Devices authorised to participate in your cadre.</p>
		</div>
		<button class="primary" onclick={() => (inviteOpen = true)}>Invite a friend</button>
	</header>

	<div class="card">
		<h3>Members ({app.trustCircle.members.length})</h3>
		{#if app.trustCircle.members.length === 0}
			<p class="muted">No members yet. Use “Invite a friend” to add one.</p>
		{:else}
			<ul class="list">
				{#each app.trustCircle.members as member (member.peerId)}
					<li>
						<div class="member-main">
							<div>
								<span class="member-label">{member.label || 'Unnamed'}</span>
								{#if member.self}
									<span class="badge info">This device</span>
								{/if}
							</div>
							<div class="muted small">
								<code title={member.peerId}>{shortPeerId(member.peerId)}</code>
								· added {formatRelativeTime(member.addedAt)}
							</div>
						</div>
						{#if !member.self}
							<button
								class="danger"
								onclick={() => (confirmMember = member)}
								aria-label={`Remove ${member.label || member.peerId}`}
							>Remove</button>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	</div>

	<div class="card">
		<h3>Pending invites ({app.trustCircle.pending.length})</h3>
		{#if app.trustCircle.pending.length === 0}
			<p class="muted">No outstanding invites.</p>
		{:else}
			<ul class="list">
				{#each app.trustCircle.pending as invite (invite.token)}
					<li>
						<div class="member-main">
							<div>
								<span class="member-label">{invite.label}</span>
							</div>
							<div class="muted small">
								issued {formatRelativeTime(invite.createdAt)}
								{#if invite.expiresAt}
									· expires {formatRelativeTime(invite.expiresAt)}
								{/if}
							</div>
						</div>
						<button onclick={() => (confirmInvite = invite)}>Revoke</button>
					</li>
				{/each}
			</ul>
		{/if}
	</div>
</section>

<InviteModal open={inviteOpen} onClose={() => (inviteOpen = false)} />

<ConfirmDialog
	open={confirmMember !== null}
	title="Remove member"
	message={`Remove ${confirmMember?.label || 'this device'} from your trust circle? This cannot be undone — they will lose access to your cadre.`}
	confirmLabel="Remove"
	danger
	onConfirm={revokeMember}
	onCancel={() => (confirmMember = null)}
/>

<ConfirmDialog
	open={confirmInvite !== null}
	title="Revoke invite"
	message={`Revoke the invite for ${confirmInvite?.label ?? 'this invite'}? It will no longer be redeemable.`}
	confirmLabel="Revoke"
	danger
	onConfirm={revokeInvite}
	onCancel={() => (confirmInvite = null)}
/>

<style>
	.page-header {
		display: flex;
		align-items: flex-end;
		justify-content: space-between;
		flex-wrap: wrap;
		gap: var(--space-3);
	}
	.list {
		list-style: none;
		padding: 0;
		margin: var(--space-3) 0 0 0;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.list li {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
		padding: var(--space-3);
		border: 1px solid var(--color-border);
		border-radius: var(--radius);
		background: var(--color-surface-alt);
	}
	.member-main {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
		min-width: 0;
	}
	.member-label { font-weight: 500; }
	.small { font-size: 0.85rem; }
</style>
