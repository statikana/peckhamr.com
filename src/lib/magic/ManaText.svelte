<script lang="ts">
	import ManaSymbol from './ManaSymbol.svelte';

	let {
		text,
		size = 17
	}: {
		text: string;
		size?: number;
	} = $props();

	interface TokenPart {
		kind: 'text' | 'symbol' | 'newline';
		value: string;
	}

	const tokens = $derived.by<TokenPart[]>(() => {
		if (!text) return [];
		const out: TokenPart[] = [];
		const lines = text.split('\n');
		lines.forEach((line, lIdx) => {
			if (lIdx > 0) out.push({ kind: 'newline', value: '\n' });
			const re = /\{([^}]+)\}/g;
			let lastIdx = 0;
			let m: RegExpExecArray | null;
			while ((m = re.exec(line)) !== null) {
				if (m.index > lastIdx) {
					out.push({ kind: 'text', value: line.slice(lastIdx, m.index) });
				}
				out.push({ kind: 'symbol', value: m[1] });
				lastIdx = re.lastIndex;
			}
			if (lastIdx < line.length) {
				out.push({ kind: 'text', value: line.slice(lastIdx) });
			}
		});
		return out;
	});
</script>

<span class="mana-text">
	{#each tokens as tok}
		{#if tok.kind === 'newline'}
			<br />
		{:else if tok.kind === 'symbol'}
			<ManaSymbol symbol={tok.value} {size} />
		{:else}
			{tok.value}
		{/if}
	{/each}
</span>

<style>
	.mana-text {
		display: inline;
		line-height: 1.45;
	}
	.mana-text :global(.msym) {
		margin: 0 1px;
	}
</style>
