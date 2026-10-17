<script lang="ts">
	import { untrack } from 'svelte';
	import { parseNullableStoredDatetimeMs } from '@serfab/cadre-core';
	import { nodeState } from './lib/store.svelte.js';
	import {
		askToRemove,
		cancelRemoval,
		closePanel,
		confirmRemoval,
		EXPORT_WARNING,
		exportOwnKey,
		importPasted,
		isLockedOwnerKeyText,
		makeGrant,
		OWN_KEY_LINE,
		OWNER_KEYS_CARD_ID,
		ownerKeyFacts,
		ownerKeyName,
		ownerKeysState,
		ownerKeyTitle,
		redeemPasted,
		refreshOwnerKeys,
		REMOVAL_REFUSAL_LINE,
		setKept,
		showExportForm,
		showGrantForm,
		withdrawGrant,
		type NoticeArea,
	} from './lib/owner-keys.svelte.js';
	import {
		BACKUP_NEEDS_A_MACHINE,
		BACKUP_WARNING,
		GRANT_WARNING,
		GRANT_WHERE_LINE,
		grantReachLine,
		grantRemovalLines,
		grantTitle,
		usesLeftText,
	} from './lib/owner-grants.js';
	import { ownerFingerprint, validUntilText } from './lib/cadre-format.js';
	import Copyable from './lib/Copyable.svelte';
	import QrCode from './lib/QrCode.svelte';
	import OwnerGrantForm from './OwnerGrantForm.svelte';
	import OwnerKeyExportForm from './OwnerKeyExportForm.svelte';

	const node = nodeState();
	const card = ownerKeysState();

	const NOT_OWNER_LINE = 'Only an owner of this cadre can add or remove owner keys. This tab is a member.';
	const UNREADABLE_LINE = 'Could not check whether this tab is an owner of this cadre, so it cannot add or remove owner keys from here until Refresh reads it.';
	const WITHDRAW_QUESTION = 'Withdraw this owner grant? Nobody can become an owner with it afterwards. Owner keys it already added stay owners; remove those above.';
	/** How long a download's Blob URL outlives the click: some browsers read it only after `click` returns. */
	const DOWNLOAD_URL_LIFETIME_MS = 1_000;

	const owner = $derived(card.standing === 'owner');
	/** The key this tab signs with, when the cadre lists it. */
	const ownKey = $derived(card.keys.find((key) => key.heldHere) ?? null);

	// Pasted grant and key text and the key's passphrase are the component's, so they leave with the page.
	let redeemText = $state('');
	let importText = $state('');
	let importPassphrase = $state('');
	const importLocked = $derived(isLockedOwnerKeyText(importText));

	// As "Devices and nodes": a restart or a join replaces the node, and an owner grant redeemed in
	// place or a key imported here changes the standing with the node still `running`.
	$effect(() => {
		if (node.status !== 'running' || node.owner === 'pending') return;
		untrack(() => void refreshOwnerKeys());
	});

	async function runRedeem(): Promise<void> {
		if (await redeemPasted(redeemText)) redeemText = '';
	}

	async function runImport(): Promise<void> {
		if (await importPasted(importText, importLocked ? importPassphrase : undefined)) {
			importText = '';
			importPassphrase = '';
		}
	}

	function confirmWithdraw(key: string): void {
		if (confirm(WITHDRAW_QUESTION)) void withdrawGrant(key);
	}

	/** A listed grant's expiry, as the phone's list writes it. */
	function grantExpiryText(expiresAt: string | null): string {
		return expiresAt === null ? 'Never expires' : validUntilText(parseNullableStoredDatetimeMs(expiresAt));
	}

	/** Save shown text as a text file; nothing is kept in the browser's storage. */
	function download(text: string, fileName: string): void {
		const url = URL.createObjectURL(new Blob([`${text}\n`], { type: 'text/plain' }));
		const link = document.createElement('a');
		link.href = url;
		link.download = fileName;
		link.click();
		setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_URL_LIFETIME_MS);
	}
</script>

{#snippet noticeFor(area: NoticeArea)}
	{#if card.notice?.area === area}
		<div class="notice" class:failed={card.notice.failed} data-testid="owner-keys-notice">
			<strong>{card.notice.title}</strong>
			<p>{card.notice.message}</p>
		</div>
	{/if}
{/snippet}

<section class="card" id={OWNER_KEYS_CARD_ID} data-testid="owner-keys">
	<h3>Owner keys</h3>

	{#if node.status !== 'running'}
		<p class="hint">The node is not running.</p>
	{:else}
		{#if card.confirming}
			{@const removal = card.confirming}
			{@const refusal = removal.plan.refusal}
			{@const grantLines = grantRemovalLines(removal.plan.grants)}
			<div class="confirm" data-testid="remove-owner-key-confirm">
				<h4>Remove owner key {ownerKeyName(removal.ownerKey)}?</h4>
				{#if refusal !== null}
					<p class="text">{REMOVAL_REFUSAL_LINE[refusal]}</p>
				{:else}
					<p class="text">
						Whoever holds this key can no longer act as an owner of this cadre. The devices it was used on stay in the cadre.
					</p>
					{#if grantLines.length > 0}
						<p class="text">It made these owner grants, which stop working with it:</p>
						{#each grantLines as line, index (index)}
							<p class="text">{line}</p>
						{/each}
						<p class="hint">Make new ones with another owner key if they are still needed.</p>
					{/if}
					{#if removal.rows.length > 0}
						<p class="text">These were added with this key. Keep each one?</p>
						{#each removal.rows as row (row.id)}
							<label class="check">
								<input
									type="checkbox"
									checked={removal.kept.includes(row.id)}
									onchange={(event) => setKept(row.id, event.currentTarget.checked)}
									data-testid="keep-dependent"
								/>
								{row.kind === 'device' ? 'Device' : 'Owner key'}
								{row.name}
							</label>
						{/each}
						<p class="hint">
							A kept one is vouched for again by this tab's key first. A device not kept stops counting as a member of this cadre; an owner key not kept stays trusted only by the machines that already trust it.
						</p>
					{/if}
					{#if removal.plan.ownDependency}
						<p class="hint">
							This tab's own owner key was added with this key. It stays an owner on the machines that already trust it, and another owner key can vouch for it again later.
						</p>
					{/if}
				{/if}
				<div class="buttons">
					{#if refusal === null}
						<button class="danger" onclick={() => void confirmRemoval()} disabled={card.busy} data-testid="btn-confirm-remove-owner-key">Remove</button>
					{/if}
					<button onclick={cancelRemoval} data-testid="btn-cancel-remove-owner-key">{refusal === null ? 'Cancel' : 'Close'}</button>
				</div>
			</div>
		{/if}

		{#if card.standing === 'member'}
			<p class="hint">{NOT_OWNER_LINE}</p>
		{:else if card.standing === 'unreadable'}
			<p class="hint">{UNREADABLE_LINE}</p>
		{/if}
		{#if card.listError}
			<p class="bad">Could not read the cadre's owner keys: {card.listError}</p>
		{/if}

		<ul class="keys">
			{#each card.keys as key (key.key)}
				<li data-testid="owner-key-row">
					<div class="item">
						<div>
							<div class="title">{ownerKeyTitle(key)}</div>
							<div class="meta">{ownerKeyFacts(key)}</div>
							{#if !key.trusted}
								<div class="untrusted">Not trusted here</div>
							{/if}
						</div>
						{#if owner && !key.heldHere}
							<button
								onclick={() => void askToRemove(key)}
								disabled={card.busy || card.confirming !== null}
								data-testid="btn-remove-owner-key"
							>
								Remove
							</button>
						{/if}
					</div>
					{#if owner && key.heldHere}
						<p class="hint self">{OWN_KEY_LINE}</p>
					{/if}
				</li>
			{/each}
		</ul>
		{@render noticeFor('list')}
		<div class="buttons">
			<button onclick={() => void refreshOwnerKeys()} data-testid="btn-refresh-owner-keys">Refresh</button>
		</div>

		{#if card.panel?.kind === 'export'}
			{@const shown = card.panel}
			<div class="export" data-testid="owner-key-export">
				<h4>{shown.title}</h4>
				<p class="hint warn">{EXPORT_WARNING}</p>
				<QrCode text={shown.text} label={shown.title} />
				<div class="export-text" data-testid="owner-key-export-text">
					<Copyable value={shown.text} />
				</div>
				<div class="buttons">
					<button
						onclick={() => download(shown.text, `sereus-owner-key-${ownerFingerprint(shown.publicKey)}.txt`)}
						data-testid="btn-download-owner-key"
					>
						Download
					</button>
					<button onclick={closePanel} data-testid="btn-owner-key-export-done">Done</button>
				</div>
			</div>
		{:else if card.panel?.kind === 'grant'}
			{@const shown = card.panel.grant}
			{@const reachLine = grantReachLine(shown.reach, shown.backup)}
			<div class="export" data-testid="owner-grant">
				<h4>{shown.title}</h4>
				<p class="hint warn">{shown.backup ? BACKUP_WARNING : GRANT_WARNING}</p>
				<p class="hint">{shown.backup ? BACKUP_NEEDS_A_MACHINE : `${validUntilText(shown.expiresAtMs)}, once. ${GRANT_WHERE_LINE}`}</p>
				{#if reachLine}
					<p class="hint" class:warn={reachLine.warning}>{reachLine.text}</p>
				{/if}
				<QrCode text={shown.text} label={shown.title} />
				<div class="export-text" data-testid="owner-grant-text">
					<Copyable value={shown.text} />
				</div>
				<div class="buttons">
					{#if shown.backup}
						<button onclick={() => download(shown.text, shown.fileName)} data-testid="btn-download-owner-grant">Download</button>
					{/if}
					<button onclick={closePanel} data-testid="btn-owner-grant-done">Done</button>
				</div>
			</div>
		{:else if card.panel?.kind === 'grant-form'}
			{@const backup = card.panel.backup}
			<OwnerGrantForm {backup} busy={card.busy} onSubmit={(label) => void makeGrant(backup, label)} onCancel={closePanel} />
			{@render noticeFor('form')}
		{:else if card.panel?.kind === 'export-form'}
			<OwnerKeyExportForm
				title="Export this tab's key"
				intro="The owner key this tab signs with, to import on another device or keep as a backup."
				defaultLabel={card.panel.defaultLabel}
				submitLabel="Export"
				busy={card.busy}
				onSubmit={(form) => void exportOwnKey(form)}
				onCancel={closePanel}
			/>
			{@render noticeFor('form')}
		{:else}
			{#if owner}
				<div class="buttons">
					<button onclick={() => showGrantForm(false)} disabled={card.busy} data-testid="btn-add-owner-key">Add an owner key</button>
					<button onclick={() => showGrantForm(true)} disabled={card.busy} data-testid="btn-make-backup">Make a backup</button>
					{#if ownKey}
						{@const own = ownKey}
						<button onclick={() => showExportForm(own)} disabled={card.busy} data-testid="btn-export-own-key">Export this tab's key</button>
					{/if}
				</div>

				<h4>Outstanding owner grants</h4>
				{#if card.grantsError}
					<p class="bad">Could not read the owner grants: {card.grantsError}</p>
				{:else if card.grants.length === 0}
					<p class="hint" data-testid="no-owner-grants">None.</p>
				{/if}
				<ul class="keys">
					{#each card.grants as { grant, usesRecorded } (grant.key)}
						<li data-testid="owner-grant-row">
							<div class="item">
								<div>
									<div class="title">{grantTitle(grant)}</div>
									<div class="meta">{grantExpiryText(grant.expiresAt)} · {usesLeftText(grant.totalUses, usesRecorded)}</div>
								</div>
								<button onclick={() => confirmWithdraw(grant.key)} disabled={card.busy} data-testid="btn-withdraw-owner-grant">Withdraw</button>
							</div>
						</li>
					{/each}
				</ul>
				{@render noticeFor('grants')}
			{/if}

			<h4>Redeem an owner grant</h4>
			<p class="hint">
				Made under Add an owner key or Make a backup on an owner device of this cadre. Redeeming it makes this tab an owner, with this tab's owner key, or a new one when it holds none.
			</p>
			<label for="owner-grant-in">Owner grant</label>
			<textarea
				id="owner-grant-in"
				rows="3"
				spellcheck="false"
				autocomplete="off"
				placeholder="sereus-owner-grant:1.…"
				bind:value={redeemText}
				data-testid="owner-grant-in"
			></textarea>
			<div class="buttons">
				<button onclick={() => void runRedeem()} disabled={card.busy || !redeemText.trim()} data-testid="btn-redeem-owner-grant">Redeem</button>
			</div>
			{@render noticeFor('redeem')}

			<h4>Import an owner key</h4>
			<p class="hint">
				An owner key exported on another device or tab. This tab keeps it, and is an owner of every cadre that lists it.
			</p>
			<label for="owner-key-in">Owner key</label>
			<textarea
				id="owner-key-in"
				rows="3"
				spellcheck="false"
				autocomplete="off"
				placeholder="sereus-owner-key…"
				bind:value={importText}
				data-testid="owner-key-in"
			></textarea>
			{#if importLocked}
				<label for="owner-key-import-passphrase-in">Its passphrase</label>
				<input
					id="owner-key-import-passphrase-in"
					type="password"
					autocomplete="off"
					bind:value={importPassphrase}
					data-testid="owner-key-import-passphrase-in"
				/>
			{/if}
			<div class="buttons">
				<button
					onclick={() => void runImport()}
					disabled={card.busy || !importText.trim() || (importLocked && importPassphrase === '')}
					data-testid="btn-import-owner-key"
				>
					{card.busy ? 'Working…' : 'Import'}
				</button>
			</div>
			{@render noticeFor('import')}
		{/if}
	{/if}
</section>

<style>
	.card {
		margin-top: 1.5rem;
		border: 1px solid #e3e5ea;
		border-radius: 0.5rem;
		background: #fafbfc;
		padding: 1rem 1.25rem;
		scroll-margin-top: 1rem;
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

	.confirm h4,
	.export h4 {
		margin-top: 0.5rem;
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
		background: #fff6e0;
		border: 1px solid #f0d68a;
		border-radius: 0.375rem;
		padding: 0.5rem 0.625rem;
	}

	.text {
		font-size: 0.875rem;
		margin: 0.25rem 0 0.5rem 0;
	}

	.confirm,
	.export {
		display: grid;
		gap: 0.375rem;
		padding: 0.5rem 0.75rem;
		margin-bottom: 0.75rem;
		background: #eef0f4;
		border-radius: 0.375rem;
	}

	.export {
		margin-top: 0.75rem;
	}

	.export-text {
		max-width: 100%;
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
		margin: 0.25rem 0;
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

	input[type='password'] {
		font: inherit;
		font-size: 0.875rem;
		padding: 0.375rem 0.5rem;
		border: 1px solid #d4d6db;
		border-radius: 0.25rem;
		max-width: 24rem;
		margin-top: 0.25rem;
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

	.keys {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 0.375rem;
	}

	.keys li {
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
		color: #1d1f24;
		font-size: 0.8125rem;
		margin: 0.5rem 0;
	}

	.notice.failed {
		color: #b3261e;
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
