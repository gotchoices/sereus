<script lang="ts">
	import { onMount } from 'svelte';

	import { apiDelete } from '../lib/api.js';
	import {
		appState,
		refreshGrants,
		pushToast,
		reportError,
		type GrantListing,
	} from '../lib/state.svelte.js';
	import {
		DONATION_STATUS_LABEL,
		donationHasNode,
		grantState,
		sortGrants,
		type GrantState,
	} from '../lib/grants.js';
	import { formatRelativeDeadline, formatRelativeTime } from '../lib/format.js';
	import { hrefFor } from '../lib/router.js';

	import ConfirmDialog from '../components/ConfirmDialog.svelte';
	import GrantIssueModal from '../components/GrantIssueModal.svelte';

	const STATE_BADGE: Record<GrantState, { text: string; tone: string }> = {
		active: { text: 'Active', tone: 'ok' },
		expired: { text: 'Expired', tone: 'warn' },
		revoked: { text: 'Revoked', tone: 'err' },
	};

	const app = appState();

	let issueOpen = $state(false);
	let shareGrant = $state<GrantListing | null>(null);
	let revokeGrant = $state<GrantListing | null>(null);
	let keepNodes = $state(false);

	// Evaluated against the clock at each list change, not continuously: a grant
	// that expires while the page sits open keeps its badge until the next refresh.
	const grants = $derived(sortGrants(app.grants.list));

	/** Same reasoning as the Strands page: an unfetched list is not an empty one. */
	const listView = $derived.by((): 'loading' | 'empty' | 'list' | 'none' => {
		if (app.grants.loaded) return app.grants.list.length === 0 ? 'empty' : 'list';
		return app.grants.error ? 'none' : 'loading';
	});

	onMount(() => {
		void refreshGrants();
	});

	function nodeCount(n: number): string {
		return `${n} donated node${n === 1 ? '' : 's'}`;
	}

	function expiryText(grant: GrantListing, state: GrantState): string {
		if (state === 'revoked') return `revoked ${formatRelativeTime(grant.revokedAt)}`;
		if (!grant.expiresAt) return 'never expires';
		return state === 'expired'
			? `expired ${formatRelativeTime(grant.expiresAt)}`
			: `expires ${formatRelativeDeadline(grant.expiresAt)}`;
	}

	function openRevoke(grant: GrantListing): void {
		keepNodes = false;
		revokeGrant = grant;
	}

	function revokeMessage(grant: GrantListing | null, keep: boolean): string {
		if (!grant) return '';
		const lead = `Revoke the grant for ${grant.label}? Whoever holds its token can no longer ask this machine for nodes.`;
		const n = grant.donations.length;
		if (n === 0) return lead;
		if (keep) return `${lead} Its ${nodeCount(n)} keep running until you terminate them from their node pages.`;
		return `${lead} Its ${nodeCount(n)} will be shut down, and ${n === 1 ? 'its' : 'their'} data on this machine deleted.`;
	}

	async function revoke(): Promise<void> {
		const grant = revokeGrant;
		if (!grant) return;
		const keep = keepNodes && grant.donations.length > 0;
		try {
			const r = await apiDelete<{ ok: true; terminated: string[] }>(
				`/grants-admin/${encodeURIComponent(grant.token)}${keep ? '?keepNodes=true' : ''}`,
			);
			// The server's list, not the count the dialog showed: a node may have come or
			// gone while it was open.
			const outcome = keep
				? 'its nodes keep running'
				: r.terminated.length > 0 ? `shut down ${nodeCount(r.terminated.length)}` : '';
			pushToast('success', `Revoked grant for ${grant.label}${outcome ? `; ${outcome}` : ''}`);
		} catch (err) {
			reportError('Revoke', err);
		} finally {
			revokeGrant = null;
		}
		await refreshGrants();
	}
</script>

<section class="stack">
	<header class="page-header">
		<div>
			<h2>Grants</h2>
			<p class="muted">
				Tokens that let a friend's cadre borrow nodes from this machine. A grant stays
				usable, up to its node limit, until it expires or you revoke it.
			</p>
		</div>
		<button class="primary" onclick={() => (issueOpen = true)}>Issue grant</button>
	</header>

	<div class="card">
		<!-- As on the Strands page, a failed refresh keeps the last list that loaded. -->
		{#if app.grants.error}
			<p class="error">Couldn’t load grants: {app.grants.error}</p>
		{/if}
		{#if listView === 'loading'}
			<p class="muted">Loading…</p>
		{:else if listView === 'empty'}
			<p class="muted">No grants yet. Issue one to let a friend borrow nodes from this machine.</p>
		{:else if listView === 'list'}
			<ul class="list">
				{#each grants as grant (grant.token)}
					{@const state = grantState(grant)}
					<li>
						<div class="grant-main">
							<div class="row meta">
								<span class="grant-label">{grant.label}</span>
								<span class="badge {STATE_BADGE[state].tone}">{STATE_BADGE[state].text}</span>
							</div>
							<div class="muted small">
								{grant.liveNodes} / {grant.maxNodes} nodes
								· issued {formatRelativeTime(grant.createdAt)}
								· {expiryText(grant, state)}
							</div>
							{#if grant.donations.length > 0}
								<ul class="donations small">
									{#each grant.donations as donation (donation.id)}
										<li>
											{#if donationHasNode(donation.status)}
												<a href={hrefFor('node-detail', { id: donation.id })}><code>{donation.id}</code></a>
											{:else}
												<code>{donation.id}</code>
											{/if}
											<span class="muted">{DONATION_STATUS_LABEL[donation.status]}</span>
										</li>
									{/each}
								</ul>
							{/if}
						</div>
						<div class="actions">
							{#if state === 'active'}
								<button onclick={() => (shareGrant = grant)}>Show token</button>
							{/if}
							{#if state !== 'revoked'}
								<button
									class="danger"
									onclick={() => openRevoke(grant)}
									aria-label={`Revoke grant for ${grant.label}`}
								>Revoke</button>
							{/if}
						</div>
					</li>
				{/each}
			</ul>
		{/if}
	</div>
</section>

<GrantIssueModal
	open={issueOpen || shareGrant !== null}
	grant={shareGrant}
	onClose={() => {
		issueOpen = false;
		shareGrant = null;
	}}
/>

<ConfirmDialog
	open={revokeGrant !== null}
	title="Revoke grant"
	message={revokeMessage(revokeGrant, keepNodes)}
	confirmLabel="Revoke"
	danger
	onConfirm={revoke}
	onCancel={() => (revokeGrant = null)}
>
	{#if revokeGrant && revokeGrant.donations.length > 0}
		<label class="keep">
			<input type="checkbox" bind:checked={keepNodes} />
			Keep its {nodeCount(revokeGrant.donations.length)} running
		</label>
	{/if}
</ConfirmDialog>

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
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.list > li {
		display: flex;
		align-items: center;
		justify-content: space-between;
		flex-wrap: wrap;
		gap: var(--space-3);
		padding: var(--space-3);
		border: 1px solid var(--color-border);
		border-radius: var(--radius);
		background: var(--color-surface-alt);
	}
	.grant-main {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		min-width: 0;
		/* A long label wraps instead of widening the row. */
		overflow-wrap: anywhere;
	}
	.grant-label { font-weight: 500; }
	.meta { gap: 0.5rem; }
	.donations {
		list-style: none;
		padding: 0;
		margin: 0.25rem 0 0 0;
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
	}
	.donations li {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}
	.actions { display: flex; gap: 0.5rem; }
	.keep {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin-top: var(--space-3);
		/* Overrides the muted form-label style: this is an option, not a field caption. */
		font-size: 0.9rem;
		font-weight: 400;
		color: var(--color-text);
	}
	.error { color: var(--color-danger); }
	.small { font-size: 0.85rem; }
</style>
