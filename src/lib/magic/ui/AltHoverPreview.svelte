<script lang="ts">
	import ManaText from '../ManaText.svelte';
	import { cardAbilityDisplayText } from '../compiler/support.ts';
	import type { CardContinuousBreakdown } from '../engine.ts';
	import type { ScryfallCard } from '../types.ts';
	import { FACE_DOWN_ART_URI } from './promptViewModel.ts';

	let {
		card,
		altHeld,
		mouseX,
		mouseY,
		breakdown = null,
		imageUrlOverride
	}: {
		card: ScryfallCard | null;
		altHeld: boolean;
		mouseX: number;
		mouseY: number;
		breakdown?: CardContinuousBreakdown | null;
		imageUrlOverride?: string;
	} = $props();

	let viewportWidth = $state(typeof window !== 'undefined' ? window.innerWidth : 1280);
	let viewportHeight = $state(typeof window !== 'undefined' ? window.innerHeight : 720);

	const previewPos = $derived.by(() => {
		const w = viewportWidth || 1280;
		const h = viewportHeight || 720;
		const imgW = 246;
		const imgH = 342;
		const detailsH = 148;
		const sideDetailsW = 254;

		const stackedTotalH = imgH + detailsH;
		const idealStackedY = mouseY - stackedTotalH * 0.42;
		const wouldOverflowVertically =
			idealStackedY < 14 || idealStackedY + stackedTotalH > h - 14 || h < 660;

		const sideMode = wouldOverflowVertically && w >= imgW + sideDetailsW + 40;
		const totalW = sideMode ? imgW + sideDetailsW : imgW;
		const totalH = sideMode ? imgH : stackedTotalH;

		let x = mouseX + 24;
		let placeLeft = false;
		if (x + totalW > w - 12) {
			if (mouseX - 24 - totalW >= 12) {
				x = mouseX - 24 - totalW;
				placeLeft = true;
			} else {
				x = Math.max(12, w - totalW - 12);
			}
		}

		let y = mouseY - totalH * 0.45;
		if (y < 12) y = 12;
		if (y + totalH > h - 12) y = Math.max(12, h - totalH - 12);

		return { x, y, sideMode, placeLeft };
	});

	const rulesText = $derived(card ? cardAbilityDisplayText(card) : '');
	const displayImage = $derived(
		imageUrlOverride || (card?.id === 'face_down' ? FACE_DOWN_ART_URI : card?.imageUrl || FACE_DOWN_ART_URI)
	);
</script>

<svelte:window bind:innerWidth={viewportWidth} bind:innerHeight={viewportHeight} />

{#if altHeld && card}
	<div
		class="alt-hover-preview"
		class:side-details={previewPos.sideMode}
		class:place-left={previewPos.placeLeft}
		style="left: {previewPos.x}px; top: {previewPos.y}px;"
	>
		<img src={displayImage} alt={card.name} />
		<div class="alt-preview-meta">
			<div class="alt-preview-head">
				<strong>{card.name}</strong>
				{#if card.manaCost}
					<ManaText text={card.manaCost} size={16} />
				{/if}
			</div>
			{#if breakdown?.effectiveTypeLine || card.typeLine}
				<div class="alt-preview-type">
					{breakdown ? breakdown.effectiveTypeLine : card.typeLine}
					{#if breakdown?.typeModified}
						<span class="type-mod-note">
							(was {breakdown.baseTypeLine} — {breakdown.typeModifiedBy.join(', ')})
						</span>
					{/if}
				</div>
			{/if}
			{#if breakdown && breakdown.effectivePower !== null && breakdown.effectiveToughness !== null}
				<div class="alt-preview-pt">
					<span>
						P/T: <strong>{breakdown.effectivePower}/{breakdown.effectiveToughness}</strong>
					</span>
					{#if breakdown.ptModifiedBy.length > 0}
						<span class="pt-mod-note">
							(base {breakdown.basePower ?? 0}/{breakdown.baseToughness ?? 0}: {breakdown.ptModifiedBy.join(', ')})
						</span>
					{/if}
				</div>
			{:else if card.power !== undefined && card.toughness !== undefined}
				<div class="alt-preview-pt">
					<span>P/T: <strong>{card.power}/{card.toughness}</strong></span>
				</div>
			{/if}
			{#if breakdown && breakdown.items.length > 0}
				<div class="alt-kw-section">
					<div class="alt-kw-title">KEYWORDS &amp; EFFECTS</div>
					<div class="alt-kw-list">
						{#each breakdown.items as item (item.id)}
							<div class="alt-kw-row" class:is-removed={item.removed}>
								<span class="kw-name" class:crossed-out={item.removed}>
									{item.name}
								</span>
								{#each item.sources as src}
									<span
										class="kw-source"
										class:innate={src === 'innate'}
										class:granted={src !== 'innate'}
									>
										({src})
									</span>
								{/each}
								{#if item.removed && item.removedBy.length > 0}
									<span class="kw-removed-by">
										(removed by {item.removedBy.join(', ')})
									</span>
								{/if}
							</div>
						{/each}
					</div>
				</div>
			{/if}
			{#if rulesText}
				<div class="alt-preview-oracle">
					<ManaText text={rulesText} size={15} />
				</div>
			{/if}
		</div>
	</div>
{/if}

<style>
	.alt-hover-preview {
		position: fixed;
		width: 246px;
		max-height: calc(100vh - 24px);
		background: var(--mp-bg-elevated, var(--mp-bg-panel, #221f22));
		border: 2px solid var(--mp-accent, var(--mp-yellow, #ffd866));
		border-radius: 10px;
		box-shadow: 0 18px 42px rgba(0, 0, 0, 0.65);
		overflow: hidden;
		pointer-events: none;
		z-index: 300;
		display: flex;
		flex-direction: column;
		font-family: var(--mono-font, monospace);
	}
	.alt-hover-preview.side-details {
		width: 500px;
		flex-direction: row;
		align-items: stretch;
	}
	.alt-hover-preview.side-details.place-left {
		flex-direction: row-reverse;
	}
	.alt-hover-preview img {
		width: 246px;
		height: auto;
		display: block;
		flex-shrink: 0;
		align-self: flex-start;
	}
	.alt-preview-meta {
		padding: 0.5rem 0.65rem;
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		font-size: 0.72rem;
		background: var(--mp-bg-elevated, var(--mp-bg-panel, #221f22));
		border-top: 1px solid var(--mp-border, #3e3a42);
		overflow-y: auto;
	}
	.alt-hover-preview.side-details .alt-preview-meta {
		border-top: none;
		border-left: 1px solid var(--mp-border, #3e3a42);
		width: 254px;
		justify-content: flex-start;
	}
	.alt-hover-preview.side-details.place-left .alt-preview-meta {
		border-left: none;
		border-right: 1px solid var(--mp-border, #3e3a42);
	}
	.alt-preview-head {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 0.4rem;
		color: var(--mp-text, #fcfcfa);
	}
	.alt-preview-type {
		font-size: 0.66rem;
		color: var(--mp-cyan, #78dce8);
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
	}
	.type-mod-note {
		font-size: 0.6rem;
		color: var(--mp-orange, #fc9867);
	}
	.alt-preview-pt {
		font-size: 0.66rem;
		color: var(--mp-green, #a9dc76);
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem;
		align-items: baseline;
	}
	.pt-mod-note {
		font-size: 0.6rem;
		color: var(--mp-text-muted, #939293);
	}
	.alt-kw-section {
		background: var(--mp-bg, #19181a);
		border: 1px solid var(--mp-border-strong, #524c58);
		border-radius: 6px;
		padding: 0.32rem 0.45rem;
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
	}
	.alt-kw-title {
		font-size: 0.58rem;
		font-weight: 700;
		letter-spacing: 0.04em;
		color: var(--mp-accent, var(--mp-yellow, #ffd866));
	}
	.alt-kw-list {
		display: flex;
		flex-direction: column;
		gap: 0.16rem;
	}
	.alt-kw-row {
		font-size: 0.64rem;
		line-height: 1.28;
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0.24rem;
		color: var(--mp-text, #fcfcfa);
	}
	.alt-kw-row .kw-name {
		font-weight: 600;
		color: var(--mp-text, #fcfcfa);
	}
	.alt-kw-row .kw-name.crossed-out {
		text-decoration: line-through;
		text-decoration-thickness: 1.5px;
		text-decoration-color: var(--mp-red, #ff6188);
		color: var(--mp-text-muted, #939293);
		opacity: 0.78;
	}
	.alt-kw-row .kw-source.innate {
		color: var(--mp-text-muted, #939293);
		opacity: 0.68;
		font-size: 0.6rem;
	}
	.alt-kw-row .kw-source.granted {
		color: var(--mp-cyan, #78dce8);
		font-weight: 600;
		font-size: 0.6rem;
	}
	.alt-kw-row .kw-removed-by {
		color: var(--mp-red, #ff6188);
		font-weight: 600;
		font-size: 0.6rem;
	}
	.alt-preview-oracle {
		font-size: 0.68rem;
		color: var(--mp-text-body, #e3e1e4);
		line-height: 1.35;
	}
</style>
