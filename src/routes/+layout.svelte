<script lang="ts">
	import favicon from '/src/assets/favicon.ico';

	let { children } = $props();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
    <title>Ryan Peckham</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous" />
    <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:ital,wght@0,400;0,500;0,600;0,700;1,400&display=swap" rel="stylesheet" />
</svelte:head>

<style>
:global(:root) {
	--mono-font: "JetBrains Mono", ui-monospace, Menlo, Consolas, monospace;
}

:global(body) {
	font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
	font-size: 17px;
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
