<script lang="ts">
	let {
		symbol,
		size = 18
	}: {
		symbol: string;
		size?: number;
	} = $props();

	interface SymbolPalette {
		bg: string;
		stroke: string;
		fg: string;
		accent?: string;
	}

	const PALETTES: Record<string, SymbolPalette> = {
		W: { bg: '#f7f1d0', stroke: '#2d2a2e', fg: '#2d2a2e' },
		U: { bg: '#9be3f0', stroke: '#1b3a4b', fg: '#152b38', accent: '#9be3f0' },
		B: { bg: '#bfb4c9', stroke: '#221d26', fg: '#1f1b24', accent: '#bfb4c9' },
		R: { bg: '#f79d84', stroke: '#3b1812', fg: '#2e110d' },
		G: { bg: '#9bd69c', stroke: '#18331c', fg: '#162b19' },
		C: { bg: '#d2cfd6', stroke: '#2d2a2e', fg: '#221f22', accent: '#d2cfd6' },
		S: { bg: '#d9f2fa', stroke: '#1b4353', fg: '#153747' }
	};

	const DEFAULT_PALETTE: SymbolPalette = {
		bg: '#cbc6ce',
		stroke: '#2d2a2e',
		fg: '#19181a'
	};

	function paletteFor(part: string): SymbolPalette {
		return PALETTES[part] ?? DEFAULT_PALETTE;
	}

	const clean = $derived(symbol.replace(/[{}]/g, '').trim().toUpperCase());
	const parts = $derived(clean.split('/').filter(Boolean));

	const isSinglePhyrexian = $derived(
		clean === 'P' || (parts.length === 2 && (parts[0] === 'P' || parts[1] === 'P'))
	);
	const phyrexianColorKey = $derived(
		parts.length === 2 ? (parts[0] === 'P' ? parts[1] : parts[0]) : 'P'
	);
	const isHybridPhyrexian = $derived(parts.length === 3 && parts[2] === 'P');
	const isSplitHybrid = $derived(parts.length === 2 && parts[0] !== 'P' && parts[1] !== 'P');
</script>

{#snippet manaGlyph(key: string)}
	{#if key === 'W'}
		<circle cx="12" cy="12" r="4.2" fill="#2d2a2e" />
		<path
			d="M12 3.5V6.2 M12 17.8V20.5 M3.5 12H6.2 M17.8 12H20.5 M6 6L7.9 7.9 M16.1 16.1L18 18 M18 6L16.1 7.9 M7.9 16.1L6 18"
			stroke="#2d2a2e"
			stroke-width="1.9"
			stroke-linecap="round"
		/>
	{:else if key === 'U'}
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
	{:else if key === 'B'}
		<path
			d="M12 5.2 C8.4 5.2, 6.2 7.6, 6.2 10.8 C6.2 12.9, 7.3 14.4, 8.6 15.2 L8.6 18.2 H15.4 L15.4 15.2 C16.7 14.4, 17.8 12.9, 17.8 10.8 C17.8 7.6, 15.6 5.2, 12 5.2 Z"
			fill="#1f1b24"
		/>
		<circle cx="9.8" cy="11" r="1.45" fill="#bfb4c9" />
		<circle cx="14.2" cy="11" r="1.45" fill="#bfb4c9" />
		<path d="M10.6 15.8V18 M13.4 15.8V18" stroke="#bfb4c9" stroke-width="1.2" />
	{:else if key === 'R'}
		<path
			d="M12.6 4.6 C13.5 7.4, 17.4 8.8, 17.2 13.4 C17 16.8, 14.4 18.8, 11.8 18.8 C8.8 18.8, 6.8 16.5, 6.8 13.6 C6.8 11.2, 8.3 9.6, 9.6 8.8 C9.2 10.6, 10.4 11.6, 11.4 11 C11.1 8.5, 11.7 6.2, 12.6 4.6 Z"
			fill="#2e110d"
		/>
	{:else if key === 'G'}
		<path
			d="M12 4.8 C8.8 4.8, 6.6 7.3, 6.6 10.3 C6.6 12.8, 8.4 14.7, 10.7 15.1 V18.8 H13.3 V15.1 C15.6 14.7, 17.4 12.8, 17.4 10.3 C17.4 7.3, 15.2 4.8, 12 4.8 Z"
			fill="#162b19"
		/>
	{:else if key === 'C'}
		<path
			d="M12 4.8 L14.8 9.2 L19.2 12 L14.8 14.8 L12 19.2 L9.2 14.8 L4.8 12 L9.2 9.2 Z"
			fill="#221f22"
		/>
		<circle cx="12" cy="12" r="2" fill="#d2cfd6" />
	{:else if key === 'S'}
		<path
			d="M12 4.4V19.6 M5.4 8.2L18.6 15.8 M18.6 8.2L5.4 15.8 M10.1 6.1L12 7.8L13.9 6.1 M10.1 17.9L12 16.2L13.9 17.9 M6.2 10.8L8.5 10L7.8 7.7 M17.8 13.2L15.5 14L16.2 16.3 M16.2 7.7L15.5 10L17.8 10.8 M7.8 16.3L8.5 14L6.2 13.2"
			fill="none"
			stroke="#153747"
			stroke-width="1.55"
			stroke-linecap="round"
			stroke-linejoin="round"
		/>
		<circle cx="12" cy="12" r="1.9" fill="#d9f2fa" stroke="#153747" stroke-width="1.4" />
	{:else}
		<text
			x="12"
			y="16.8"
			text-anchor="middle"
			font-family="JetBrains Mono, monospace"
			font-size={key.length > 1 ? '12.5' : '15.5'}
			font-weight="800"
			fill="#19181a"
		>
			{key}
		</text>
	{/if}
{/snippet}

<span
	class="msym msym-{clean.replaceAll('/', '-')}"
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
	{:else if clean === 'Q'}
		<!-- Untap Symbol {Q} (CR 107.6): Reverse curved arrow on dark badge -->
		<svg viewBox="0 0 24 24" width={size} height={size}>
			<circle cx="12" cy="12" r="11" fill="#1e1c22" stroke="#9d96a6" stroke-width="1.6" />
			<path
				d="M16.5 15.5 C16.5 10.5, 12.5 7.5, 8 8.5 L9.8 6.2 M8 8.5 L10.5 10.6"
				fill="none"
				stroke="#f5f2eb"
				stroke-width="2.2"
				stroke-linecap="round"
				stroke-linejoin="round"
			/>
			<rect x="12.5" y="14.5" width="5" height="3.5" rx="0.8" fill="#f5f2eb" />
		</svg>
	{:else if clean === 'E'}
		<!-- Energy Symbol {E}: Starburst & lightning rune -->
		<svg viewBox="0 0 24 24" width={size} height={size}>
			<circle cx="12" cy="12" r="11" fill="#241e12" stroke="#ffd866" stroke-width="1.6" />
			<path
				d="M12 2.5 L13.1 5.1 L12 4.4 L10.9 5.1 Z M12 21.5 L13.1 18.9 L12 19.6 L10.9 18.9 Z M2.5 12 L5.1 10.9 L4.4 12 L5.1 13.1 Z M21.5 12 L18.9 10.9 L19.6 12 L18.9 13.1 Z"
				fill="#f59e0b"
			/>
			<path
				d="M13.4 4.8 L7.6 12.6 H11.9 L10.6 19.2 L16.4 11.4 H12.1 Z"
				fill="#ffd866"
				stroke="#19181a"
				stroke-width="0.65"
				stroke-linejoin="round"
			/>
		</svg>
	{:else if clean === 'S'}
		<!-- Snow Mana {S}: Snowflake crystal -->
		{@const pal = paletteFor('S')}
		<svg viewBox="0 0 24 24" width={size} height={size}>
			<circle cx="12" cy="12" r="11" fill={pal.bg} stroke={pal.stroke} stroke-width="1.6" />
			{@render manaGlyph('S')}
		</svg>
	{:else if isSinglePhyrexian}
		<!-- Phyrexian Mana {W/P}, {U/P}, {B/P}, {R/P}, {G/P}, {P}: Colored circle with Phi glyph -->
		{@const pal = paletteFor(phyrexianColorKey)}
		<svg viewBox="0 0 24 24" width={size} height={size}>
			<circle cx="12" cy="12" r="11" fill={pal.bg} stroke={pal.stroke} stroke-width="1.6" />
			<circle cx="12" cy="12" r="5.1" fill="none" stroke={pal.fg} stroke-width="2.15" />
			<path d="M12 3.8V20.2" stroke={pal.fg} stroke-width="2.25" stroke-linecap="round" />
		</svg>
	{:else if isHybridPhyrexian}
		<!-- Hybrid Phyrexian Mana {G/U/P}, etc.: 45-deg split circle with Phi glyph -->
		{@const leftPal = paletteFor(parts[0])}
		{@const rightPal = paletteFor(parts[1])}
		<svg viewBox="0 0 24 24" width={size} height={size}>
			<path d="M 4.22 19.78 A 11 11 0 0 1 19.78 4.22 Z" fill={leftPal.bg} />
			<path d="M 4.22 19.78 A 11 11 0 0 0 19.78 4.22 Z" fill={rightPal.bg} />
			<line x1="4.22" y1="19.78" x2="19.78" y2="4.22" stroke="#221f22" stroke-width="1.2" />
			<circle cx="12" cy="12" r="5.1" fill="none" stroke="#19181a" stroke-width="2.15" />
			<path d="M12 3.8V20.2" stroke="#19181a" stroke-width="2.25" stroke-linecap="round" />
			<circle cx="12" cy="12" r="11" fill="none" stroke="#221f22" stroke-width="1.6" />
		</svg>
	{:else if isSplitHybrid}
		<!-- Two-Color, Twobrid & Colorless-Hybrid Split Mana ({W/U}, {2/W}, {C/R}, etc.) -->
		{@const leftKey = parts[0]}
		{@const rightKey = parts[1]}
		{@const leftPal = paletteFor(leftKey)}
		{@const rightPal = paletteFor(rightKey)}
		<svg viewBox="0 0 24 24" width={size} height={size}>
			<path d="M 4.22 19.78 A 11 11 0 0 1 19.78 4.22 Z" fill={leftPal.bg} />
			<path d="M 4.22 19.78 A 11 11 0 0 0 19.78 4.22 Z" fill={rightPal.bg} />
			<line x1="4.22" y1="19.78" x2="19.78" y2="4.22" stroke="#221f22" stroke-width="1.35" />
			<g transform="translate(8.1, 8.1) scale(0.45) translate(-12, -12)">
				{@render manaGlyph(leftKey)}
			</g>
			<g transform="translate(15.9, 15.9) scale(0.45) translate(-12, -12)">
				{@render manaGlyph(rightKey)}
			</g>
			<circle cx="12" cy="12" r="11" fill="none" stroke="#221f22" stroke-width="1.6" />
		</svg>
	{:else if clean === 'W' || clean === 'U' || clean === 'B' || clean === 'R' || clean === 'G' || clean === 'C'}
		{@const pal = paletteFor(clean)}
		<svg viewBox="0 0 24 24" width={size} height={size}>
			<circle cx="12" cy="12" r="11" fill={pal.bg} stroke={pal.stroke} stroke-width="1.6" />
			{@render manaGlyph(clean)}
		</svg>
	{:else}
		<!-- Generic / X / Numeric Mana Badge -->
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
