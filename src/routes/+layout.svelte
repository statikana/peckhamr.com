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
	/* Monokai Pro Light (Default) */
	:global(:root),
	:global(:root[data-theme="light"]) {
		--mono-font: "JetBrains Mono", ui-monospace, Menlo, Consolas, monospace;

		--mp-bg: #faf4f2;
		--mp-bg-elevated: #f3edea;
		--mp-bg-subtle: #eae2de;
		--mp-bg-hover: #efe8e4;
		--mp-border: #ded5d0;
		--mp-border-subtle: #e7dfdb;
		--mp-border-strong: #c7bcb6;

		--mp-text: #2d2a2e;
		--mp-text-body: #403c41;
		--mp-text-muted: #72696a;
		--mp-text-faint: #918889;

		/* Monokai Pro Light Accents */
		--mp-red: #e14775;
		--mp-orange: #d45c1e;
		--mp-yellow: #b57600;
		--mp-green: #218859;
		--mp-cyan: #177996;
		--mp-purple: #6851a8;

		--mp-accent: #e14775;
		--mp-accent-secondary: #177996;
		--mp-btn-bg: #2d2a2e;
		--mp-btn-fg: #faf4f2;
		--mp-btn-hover: #e14775;
		--mp-btn-hover-fg: #faf4f2;
	}

	/* Monokai Pro Dark */
	:global(:root[data-theme="dark"]) {
		--mp-bg: #221f22;
		--mp-bg-elevated: #19181a;
		--mp-bg-subtle: #2d2a2e;
		--mp-bg-hover: #29262a;
		--mp-border: #3a373b;
		--mp-border-subtle: #312e32;
		--mp-border-strong: #524e53;

		--mp-text: #fcfcfa;
		--mp-text-body: #e2e1de;
		--mp-text-muted: #939293;
		--mp-text-faint: #727072;

		/* Monokai Pro Dark Accents */
		--mp-red: #ff6188;
		--mp-orange: #fc9867;
		--mp-yellow: #ffd866;
		--mp-green: #a9dc76;
		--mp-cyan: #78dce8;
		--mp-purple: #ab9df2;

		--mp-accent: #ffd866;
		--mp-accent-secondary: #78dce8;
		--mp-btn-bg: #ffd866;
		--mp-btn-fg: #19181a;
		--mp-btn-hover: #ffe28a;
		--mp-btn-hover-fg: #19181a;
	}

	:global(html) {
		scroll-behavior: smooth;
		background-color: var(--mp-bg);
		color: var(--mp-text);
		transition: background-color 0.18s ease, color 0.18s ease;
	}

	:global(body) {
		font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
		font-size: 17px;
		background-color: var(--mp-bg);
		color: var(--mp-text);
		margin: 0;
		min-height: 100vh;
		transition: background-color 0.18s ease, color 0.18s ease;
	}

	:global(a) {
		color: var(--mp-cyan);
		text-decoration: none;
	}
</style>

{@render children()}
