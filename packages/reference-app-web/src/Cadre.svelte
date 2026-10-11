<script lang="ts">
	import AddDevice from './AddDevice.svelte';
</script>

<section class="page">
	<header class="page-head">
		<h2>Cadre</h2>
	</header>

	<p class="hint">
		Your cadre is the set of devices and apps that hold your data together. An owner adds
		another device or app by giving it an invitation.
	</p>

	<AddDevice />
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
</style>
