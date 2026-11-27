<!--
	Example (Svelte 5): beside an invitation the app has just minted: whether it is ready to hand
	out, what it names in words, and its QR code full screen on a click. Copy and adapt; it is not
	built or published. The QR code here comes from the `qrcode` package (`toDataURL`).
	Props as in the React Native example: `token` (encoded, after `invitations.withBootstrap`),
	`link` (the text shared), `strandId`, `newStrand` (the invitation founded the strand just now).
-->
<script lang="ts">
	import QRCode from 'qrcode';
	import { invitationReadinessStore, type InvitationText } from '@serfab/cadre-client';
	import type { CadreClient } from '@serfab/cadre-client/sereus';

	const { client, token, link, strandId, newStrand }:
		{ client: CadreClient; token: string; link: string; strandId: string; newStrand: boolean } = $props();

	const readiness = $derived(invitationReadinessStore(client, strandId, { newStrand }));
	let details = $state<InvitationText | null>(null);
	let open = $state(false);
	let full = $state(false);
	let qr = $state('');

	$effect(() => { void QRCode.toDataURL(link, { margin: 2, width: 720 }).then(url => { qr = url; }); });
	$effect(() => {
		if (!open || details) return;
		void client.invitations.describe(token, link).then(r => { if (r.ok) details = r.value; });
	});

	const READINESS = {
		ready: 'Ready to hand out: your machine can answer even while this device sleeps.',
		waiting: 'Getting ready to hand out… your machine is taking a copy of the conversation.',
		'no-cadron': 'Only this device can answer it: keep the app open until they join, or add a machine that stays on.',
	} as const;
</script>

{#if qr}
	<button class="qr" onclick={() => { full = true; }} aria-label="Enlarge the QR code"><img src={qr} alt="Invitation QR code" width="180" /></button>
{/if}
<p class:ready={$readiness === 'ready'}>{READINESS[$readiness]}</p>

<button class="link" onclick={() => { open = !open; }}>{open ? 'Hide the details' : "What's in this invitation"}</button>
{#if open && details}
	<ul>
		{#each details.addresses as a (a.addr)}
			<li class:muted={!a.reachesAnywhere}>
				{a.thisDevice ? 'this device' : a.label} · {a.kind ?? 'not usable by a phone'} ·
				{a.via === 'relay' ? `through relay ${a.host}` : `${a.host}, port ${a.port ?? '?'}`}
			</li>
		{/each}
	</ul>
	<p class="muted">Expires {new Date(details.expiresAt).toLocaleString()} · link {details.linkLength} characters</p>
{/if}

{#if full}
	<button class="full" onclick={() => { full = false; }} aria-label="Close"><img src={qr} alt="Invitation QR code" /></button>
{/if}

<style>
	.qr, .link, .full { background: none; border: 0; padding: 0; cursor: pointer; }
	.link { color: #0066cc; }
	.ready { color: #2c8a3f; }
	.muted { color: #777; }
	.full { position: fixed; inset: 0; background: #fff; display: grid; place-items: center; }
	.full img { width: min(90vw, 90vh); height: auto; }
</style>
