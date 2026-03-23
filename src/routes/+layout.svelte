<script lang="ts">
	import favicon from '/src/assets/favicon.ico';

	let { children } = $props();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
    <title>Ryan Peckham</title>
</svelte:head>

<style>
:global(body) {
	font-family: monospace !important;
	font-size: 18px;
	background-color: #242426;
	margin: 0;
	margin-left: 5%;
	margin-right: 5%;
}

:global(a) {
	color: cyan;
	text-decoration: none;
}
</style>

{@render children()}
