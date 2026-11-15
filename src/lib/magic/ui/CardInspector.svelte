<script lang="ts">
	import ManaText from '../ManaText.svelte';
	import {
		cardAbilityDisplayText,
		cardSupportReport,
		displayAbilityText,
		unsupportedKindLabel
	} from '../compiler/support.ts';
	import { inspectCardContinuousBreakdown, type CardContinuousBreakdown } from '../engine.ts';
	import type { CardInstance, GameActionPayload, GameState, ScryfallCard } from '../types.ts';
	import { DUNGEON_ART_URI, EMBLEM_ART_URI } from './boardViewModel.ts';
	import { FACE_DOWN_ART_URI } from './promptViewModel.ts';

	let {
		inspectedCard,
		inspectedInstance = null,
		inspectedFaceIndex = $bindable(0),
		height = 240,
		gameState,
		breakdownOverride,
		canResolveManually = false,
		onGameAction
	}: {
		inspectedCard: ScryfallCard | null;
		inspectedInstance?: CardInstance | null;
		inspectedFaceIndex?: number;
		height?: number;
		gameState?: GameState;
		breakdownOverride?: CardContinuousBreakdown | null;
		canResolveManually?: boolean;
		onGameAction?: (action: GameActionPayload) => void | Promise<void>;
	} = $props();

	const inspectBreakdown = $derived.by(() => {
		if (breakdownOverride !== undefined) return breakdownOverride;
		if (!inspectedCard || !gameState) return null;
		return inspectCardContinuousBreakdown(inspectedInstance ?? inspectedCard, gameState);
	});

	const inspectedFaceCount = $derived(inspectedCard?.faces?.length ?? 0);
	const inspectedActiveFace = $derived(
		inspectedCard?.faces && inspectedFaceCount > 1
			? (inspectedCard.faces[inspectedFaceIndex] ?? inspectedCard.faces[0])
			: null
	);
	const inspectUnsupported = $derived(
		inspectedCard ? cardSupportReport(inspectedCard).unsupported : []
	);
</script>

<div class="card-zoom-box" style="height: {height}px;">
	{#if inspectedCard}
		{@const zoomName = inspectedActiveFace?.name || inspectedCard.name}
		{@const rawImg = inspectedActiveFace?.imageUrl || inspectedCard.imageUrl}
		{@const zoomImg =
			inspectedCard.id === 'face_down'
				? FACE_DOWN_ART_URI
				: rawImg ||
					(inspectedInstance?.isEmblem
						? EMBLEM_ART_URI
						: inspectedInstance?.isDungeon
							? DUNGEON_ART_URI
							: FACE_DOWN_ART_URI)}
		{@const zoomMana = inspectedActiveFace ? inspectedActiveFace.manaCost : inspectedCard.manaCost}
		{@const zoomType = inspectedActiveFace ? inspectedActiveFace.typeLine : inspectedCard.typeLine}
		{@const zoomRulesText = cardAbilityDisplayText(
			inspectedActiveFace ? (inspectedActiveFace as ScryfallCard) : inspectedCard
		)}
		{@const zoomPower = inspectedActiveFace ? inspectedActiveFace.power : inspectedCard.power}
		{@const zoomTough = inspectedActiveFace
			? inspectedActiveFace.toughness
			: inspectedCard.toughness}
		<div class="zoom-inner">
			<img src={zoomImg} alt={zoomName} class="zoom-img" />
			<div class="zoom-meta">
				<div class="zoom-title">
					<strong>{zoomName}</strong>
					{#if zoomMana}
						<ManaText text={zoomMana} size={16} />
					{/if}
				</div>
				{#if inspectedFaceCount > 1}
					<button
						type="button"
						class="zoom-flip-btn"
						data-testid="flip-face-btn"
						onclick={() => (inspectedFaceIndex = (inspectedFaceIndex + 1) % inspectedFaceCount)}
					>
						Flip / View Other Face ({inspectedFaceIndex + 1}/{inspectedFaceCount})
					</button>
				{/if}
				<div class="zoom-type">
					{inspectBreakdown && (!inspectedActiveFace || inspectedFaceIndex === 0)
						? inspectBreakdown.effectiveTypeLine
						: zoomType}
					{#if inspectBreakdown?.typeModified && (!inspectedActiveFace || inspectedFaceIndex === 0)}
						<span class="type-mod-note">
							(was {inspectBreakdown.baseTypeLine} — {inspectBreakdown.typeModifiedBy.join(', ')})
						</span>
					{/if}
				</div>
				{#if inspectedInstance && (inspectedInstance.isEmblem || inspectedInstance.isPrepared || inspectedInstance.protectorId || (inspectedInstance.unlockedFaces && inspectedInstance.unlockedFaces.length > 0))}
					<div class="zoom-status-tags">
						{#if inspectedInstance.isEmblem}
							<span class="inspector-tag purple">🛡️ Emblem</span>
						{/if}
						{#if inspectedInstance.isPrepared}
							<span class="inspector-tag cyan">📖 Prepared</span>
						{/if}
						{#if inspectedInstance.protectorId && gameState}
							{@const prot = gameState.players.find((p) => p.playerId === inspectedInstance.protectorId)}
							{#if prot}
								<span class="inspector-tag gold">🛡️ Protector: {prot.username}</span>
							{/if}
						{/if}
						{#if inspectedInstance.counters.defense > 0}
							<span class="inspector-tag gold">Def: {inspectedInstance.counters.defense}</span>
						{/if}
					</div>
				{/if}
				{#if inspectBreakdown && inspectBreakdown.items.length > 0}
					<div class="alt-kw-section compact">
						<div class="alt-kw-title">KEYWORDS &amp; EFFECTS</div>
						<div class="alt-kw-list">
							{#each inspectBreakdown.items as item (item.id)}
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
				{#if zoomRulesText}
					<div class="zoom-oracle">
						<ManaText text={zoomRulesText} size={15} />
					</div>
				{/if}
				{#if inspectUnsupported.length > 0}
					<div class="zoom-unsupported">
						<div class="zoom-unsupported-title">Not automated</div>
						{#each inspectUnsupported as u, i (i)}
							<div class="zoom-unsupported-row">
								<span class="zoom-unsupported-kind">{unsupportedKindLabel(u.kind)}:</span>
								<ManaText
									text={displayAbilityText(u.text, u.face, inspectedCard) || '(whole card)'}
									size={13}
								/>
								{#if canResolveManually && inspectedInstance && onGameAction && u.kind !== 'mana' && u.kind !== 'multiface'}
									<button
										type="button"
										class="zoom-resolve-btn"
										title="Apply this ability by hand with guided operations (doesn't use the stack)"
										onclick={() =>
											inspectedInstance &&
											onGameAction({
												type: 'resolve_manually',
												instanceId: inspectedInstance.instanceId,
												abilityIndex: i
											})}
									>
										Resolve manually
									</button>
								{/if}
							</div>
						{/each}
					</div>
				{/if}
				{#if inspectBreakdown && inspectBreakdown.effectivePower !== null && inspectBreakdown.effectiveToughness !== null && (!inspectedActiveFace || zoomPower !== undefined)}
					<div class="zoom-pt">
						{inspectBreakdown.effectivePower}/{inspectBreakdown.effectiveToughness}
					</div>
				{:else if zoomPower !== undefined}
					<div class="zoom-pt">{zoomPower}/{zoomTough}</div>
				{/if}
			</div>
		</div>
	{:else}
		<div class="zoom-placeholder">
			Click or hover any card to inspect details (Hold ALT to float over cursor)
		</div>
	{/if}
</div>

<style>
	.card-zoom-box {
		padding: 0.55rem;
		overflow-y: auto;
		flex-shrink: 0;
	}
	.zoom-inner {
		display: grid;
		grid-template-columns: 112px 1fr;
		gap: 0.55rem;
	}
	.zoom-img {
		width: 112px;
		border-radius: 6px;
		border: 1px solid var(--mp-border-strong, #524c58);
	}
	.zoom-meta {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		font-size: 0.72rem;
	}
	.zoom-title {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 0.3rem;
		color: var(--mp-text, #fcfcfa);
	}
	.zoom-status-tags {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem;
	}
	.inspector-tag {
		font-size: 0.6rem;
		font-weight: 700;
		padding: 0.06rem 0.32rem;
		border-radius: 3px;
		border: 1px solid var(--mp-border-strong);
		background: var(--mp-bg);
	}
	.inspector-tag.purple {
		border-color: var(--mp-purple);
		color: var(--mp-purple);
	}
	.inspector-tag.cyan {
		border-color: var(--mp-cyan);
		color: var(--mp-cyan);
	}
	.inspector-tag.gold {
		border-color: #ffd866;
		color: #ffd866;
	}
	.zoom-type {
		color: var(--mp-cyan, #78dce8);
		font-size: 0.66rem;
		display: flex;
		flex-direction: column;
		gap: 0.08rem;
	}
	.type-mod-note {
		font-size: 0.6rem;
		color: var(--mp-orange, #fc9867);
	}
	.zoom-oracle {
		color: var(--mp-text-body, #e3e1e4);
		line-height: 1.38;
		font-size: 0.68rem;
	}
	.zoom-unsupported {
		border: 1px solid rgba(255, 216, 102, 0.55);
		background: rgba(255, 216, 102, 0.08);
		border-radius: 4px;
		padding: 0.25rem 0.35rem;
		font-size: 0.64rem;
		line-height: 1.3;
	}
	.zoom-unsupported-title {
		color: #ffd866;
		font-weight: 700;
		font-size: 0.6rem;
		letter-spacing: 0.02em;
		margin-bottom: 0.15rem;
	}
	.zoom-unsupported-row {
		color: var(--mp-text-body, #e3e1e4);
	}
	.zoom-unsupported-row + .zoom-unsupported-row {
		margin-top: 0.15rem;
	}
	.zoom-unsupported-kind {
		color: #ffd866;
		font-weight: 600;
		margin-right: 0.25rem;
	}
	.zoom-flip-btn {
		align-self: flex-start;
		margin: 0.1rem 0 0.25rem;
		font-size: 0.65rem;
		padding: 0.15rem 0.45rem;
		border-radius: 4px;
		border: 1px solid rgba(56, 189, 248, 0.55);
		background: rgba(56, 189, 248, 0.12);
		color: #bae6fd;
		cursor: pointer;
	}
	.zoom-resolve-btn {
		display: block;
		margin-top: 0.15rem;
		font-size: 0.6rem;
		padding: 0.1rem 0.35rem;
		border-radius: 3px;
		border: 1px solid rgba(255, 216, 102, 0.55);
		background: transparent;
		color: #ffd866;
		cursor: pointer;
	}
	.zoom-pt {
		align-self: flex-end;
		font-weight: 700;
		color: var(--mp-green, #a9dc76);
	}
	.zoom-placeholder {
		height: 100%;
		display: flex;
		align-items: center;
		justify-content: center;
		color: var(--mp-text-muted, #939293);
		font-size: 0.72rem;
		text-align: center;
		padding: 0.5rem;
	}
	.alt-kw-section.compact {
		background: var(--mp-bg, #19181a);
		border: 1px solid var(--mp-border-strong, #524c58);
		border-radius: 6px;
		padding: 0.24rem 0.38rem;
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
	}
	.alt-kw-title {
		font-size: 0.58rem;
		font-weight: 700;
		letter-spacing: 0.04em;
		color: var(--mp-accent, #ffd866);
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
</style>
