<script lang="ts">
	let {
		symbol,
		size = 18
	}: {
		symbol: string;
		size?: number;
	} = $props();

	const clean = $derived(symbol.replace(/[{}]/g, '').trim().toUpperCase());
</script>

<span
	class="msym msym-{clean.replace('/', '-')}"
	style="width: {size}px; height: {size}px;"
	title={`{${clean}}`}
	aria-label={`{${clean}}`}
>
	{#if clean === 'T'}
		<!-- Tap Symbol {T}: Curved tap arrow -->
		<svg viewBox="0 0 24 24" width={size} height={size}>
			<circle cx="12" cy="12" r="11" fill="#c8c2bc" stroke="#221f22" stroke-width="1.6" />
			<path
				d="M7.5 15.5 C7.5 10.5, 11.5 7.5, 16 8.5 L14.2 6.2 M16 8.5 L13.5 10.6"
				fill="none"
				stroke="#19181a"
				stroke-width="2.2"
				stroke-linecap="round"
				stroke-linejoin="round"
			/>
			<rect x="6.5" y="14.5" width="5" height="3.5" rx="0.8" fill="#19181a" />
		</svg>
	{:else if clean === 'W'}
		<!-- White Mana {W}: Sunburst -->
		<svg viewBox="0 0 24 24" width={size} height={size}>
			<circle cx="12" cy="12" r="11" fill="#f7f1d0" stroke="#2d2a2e" stroke-width="1.6" />
			<circle cx="12" cy="12" r="4.2" fill="#2d2a2e" />
			<path
				d="M12 3.5V6.2 M12 17.8V20.5 M3.5 12H6.2 M17.8 12H20.5 M6 6L7.9 7.9 M16.1 16.1L18 18 M18 6L16.1 7.9 M7.9 16.1L6 18"
				stroke="#2d2a2e"
				stroke-width="1.9"
				stroke-linecap="round"
			/>
		</svg>
	{:else if clean === 'U'}
		<!-- Blue Mana {U}: Water Droplet -->
		<svg viewBox="0 0 24 24" width={size} height={size}>
			<circle cx="12" cy="12" r="11" fill="#9be3f0" stroke="#1b3a4b" stroke-width="1.6" />
			<path
				d="M12 4.8 C12 4.8, 6.8 11.2, 6.8 14.8 A5.2 5.2 0 0 0 17.2 14.8 C17.2 11.2, 12 4.8, 12 4.8 Z"
				fill="#152b38"
			/>
			<path
				d="M9.6 15.2 A2.4 2.4 0 0 0 12 17.4"
				fill="none"
				stroke="#9be3f0"
				stroke-width="1.5"
				stroke-linecap="round"
			/>
		</svg>
	{:else if clean === 'B'}
		<!-- Black Mana {B}: Swamp Skull -->
		<svg viewBox="0 0 24 24" width={size} height={size}>
			<circle cx="12" cy="12" r="11" fill="#bfb4c9" stroke="#221d26" stroke-width="1.6" />
			<path
				d="M12 5.2 C8.4 5.2, 6.2 7.6, 6.2 10.8 C6.2 12.9, 7.3 14.4, 8.6 15.2 L8.6 18.2 H15.4 L15.4 15.2 C16.7 14.4, 17.8 12.9, 17.8 10.8 C17.8 7.6, 15.6 5.2, 12 5.2 Z"
				fill="#1f1b24"
			/>
			<circle cx="9.8" cy="11" r="1.45" fill="#bfb4c9" />
			<circle cx="14.2" cy="11" r="1.45" fill="#bfb4c9" />
			<path d="M10.6 15.8V18 M13.4 15.8V18" stroke="#bfb4c9" stroke-width="1.2" />
		</svg>
	{:else if clean === 'R'}
		<!-- Red Mana {R}: Mountain Flame -->
		<svg viewBox="0 0 24 24" width={size} height={size}>
			<circle cx="12" cy="12" r="11" fill="#f79d84" stroke="#3b1812" stroke-width="1.6" />
			<path
				d="M12.6 4.6 C13.5 7.4, 17.4 8.8, 17.2 13.4 C17 16.8, 14.4 18.8, 11.8 18.8 C8.8 18.8, 6.8 16.5, 6.8 13.6 C6.8 11.2, 8.3 9.6, 9.6 8.8 C9.2 10.6, 10.4 11.6, 11.4 11 C11.1 8.5, 11.7 6.2, 12.6 4.6 Z"
				fill="#2e110d"
			/>
		</svg>
	{:else if clean === 'G'}
		<!-- Green Mana {G}: Forest Tree -->
		<svg viewBox="0 0 24 24" width={size} height={size}>
			<circle cx="12" cy="12" r="11" fill="#9bd69c" stroke="#18331c" stroke-width="1.6" />
			<path
				d="M12 4.8 C8.8 4.8, 6.6 7.3, 6.6 10.3 C6.6 12.8, 8.4 14.7, 10.7 15.1 V18.8 H13.3 V15.1 C15.6 14.7, 17.4 12.8, 17.4 10.3 C17.4 7.3, 15.2 4.8, 12 4.8 Z"
				fill="#162b19"
			/>
		</svg>
	{:else if clean === 'C'}
		<!-- Colorless Mana {C}: Diamond Star -->
		<svg viewBox="0 0 24 24" width={size} height={size}>
			<circle cx="12" cy="12" r="11" fill="#d2cfd6" stroke="#2d2a2e" stroke-width="1.6" />
			<path
				d="M12 4.8 L14.8 9.2 L19.2 12 L14.8 14.8 L12 19.2 L9.2 14.8 L4.8 12 L9.2 9.2 Z"
				fill="#221f22"
			/>
			<circle cx="12" cy="12" r="2" fill="#d2cfd6" />
		</svg>
	{:else}
		<!-- Generic / X / Hybrid Mana Badge -->
		<svg viewBox="0 0 24 24" width={size} height={size}>
			<circle cx="12" cy="12" r="11" fill="#cbc6ce" stroke="#2d2a2e" stroke-width="1.6" />
			<text
				x="12"
				y="16.2"
				text-anchor="middle"
				font-family="JetBrains Mono, monospace"
				font-size={clean.length > 2 ? '8.5' : clean.length > 1 ? '10.5' : '12.5'}
				font-weight="700"
				fill="#19181a"
			>
				{clean}
			</text>
		</svg>
	{/if}
</span>

<style>
	.msym {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		vertical-align: middle;
		flex-shrink: 0;
		line-height: 1;
	}
</style>
