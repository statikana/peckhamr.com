<script lang="ts">
	import ManaText from '../ManaText.svelte';
	import type { CardInstance, GameActionPayload, GameState, ScryfallCard } from '../types.ts';
	import { previewSpellAutoTap, type AutoTapPreviewResult } from './autoTapPreview.ts';
	import {
		sortHandCards,
		type HandCardPlayabilityView,
		type HandSortDir,
		type HandSortMode
	} from './boardViewModel.ts';

	interface Props {
		hand: readonly CardInstance[];
		handPlayabilityById: Record<string, HandCardPlayabilityView>;
		playerId?: string;
		gameState?: GameState;
		sortBy?: HandSortMode;
		sortDir?: HandSortDir;
		draggingInstanceId?: string | null;
		interactionBlocked?: boolean;
		onSortByChange?: (mode: HandSortMode) => void;
		onSortDirChange?: (dir: HandSortDir) => void;
		onHoverCard?: (
			card: ScryfallCard,
			inst: CardInstance,
			playability?: HandCardPlayabilityView
		) => void;
		onLeaveCard?: (card: ScryfallCard, inst: CardInstance) => void;
		onAutoTapPreviewChange?: (preview: AutoTapPreviewResult | null) => void;
		onCardClick?: (inst: CardInstance) => void;
		onCardDragStart?: (e: DragEvent, inst: CardInstance) => void;
		onCardDragEnd?: (e: DragEvent) => void;
		onGameAction?: (action: GameActionPayload) => void | Promise<void>;
	}

	let {
		hand,
		handPlayabilityById,
		playerId,
		gameState,
		sortBy,
		sortDir,
		draggingInstanceId = null,
		interactionBlocked = false,
		onSortByChange,
		onSortDirChange,
		onHoverCard,
		onLeaveCard,
		onAutoTapPreviewChange,
		onCardClick,
		onCardDragStart,
		onCardDragEnd,
		onGameAction
	}: Props = $props();

	let internalSortBy = $state<HandSortMode>('none');
	let internalSortDir = $state<HandSortDir>('asc');
	let lastPreviewedInstanceId = $state<string | null>(null);

	const effectiveSortBy = $derived(sortBy ?? internalSortBy);
	const effectiveSortDir = $derived(sortDir ?? internalSortDir);
	const sortedHand = $derived(sortHandCards(hand, effectiveSortBy, effectiveSortDir));

	const SORT_MODES: ReadonlyArray<readonly [HandSortMode, string]> = [
		['none', 'None'],
		['cmc', 'CMC'],
		['name', 'Name'],
		['color', 'Color'],
		['type', 'Type']
	];

	function selectSortMode(mode: HandSortMode): void {
		internalSortBy = mode;
		onSortByChange?.(mode);
	}

	function selectSortDir(dir: HandSortDir): void {
		internalSortDir = dir;
		onSortDirChange?.(dir);
	}

	function handleEnterCard(cardInst: CardInstance, play: HandCardPlayabilityView | undefined): void {
		onHoverCard?.(cardInst.card, cardInst, play);
		if (!onAutoTapPreviewChange) return;
		if (
			interactionBlocked ||
			!gameState ||
			!playerId ||
			!play ||
			play.castOptions.length === 0
		) {
			if (lastPreviewedInstanceId !== null) {
				lastPreviewedInstanceId = null;
				onAutoTapPreviewChange(null);
			}
			return;
		}
		if (lastPreviewedInstanceId === cardInst.instanceId) return;
		lastPreviewedInstanceId = cardInst.instanceId;
		const preview = previewSpellAutoTap(
			gameState,
			playerId,
			cardInst.instanceId,
			play.castOptions[0]
		);
		onAutoTapPreviewChange(preview.canAutoTap ? preview : null);
	}

	function handleExitCard(cardInst: CardInstance): void {
		onLeaveCard?.(cardInst.card, cardInst);
		if (lastPreviewedInstanceId === cardInst.instanceId) {
			lastPreviewedInstanceId = null;
			onAutoTapPreviewChange?.(null);
		}
	}
</script>

<div class="hand-tray" data-game-id={playerId ? `${playerId}:hand` : undefined}>
	<div class="hand-toolbar">
		<span class="hand-count-label">HAND ({sortedHand.length})</span>
		<div class="hand-sort-group" role="group" aria-label="Auto-sort hand">
			<span class="sort-caption">Sort:</span>
			{#each SORT_MODES as [mode, label] (mode)}
				<button
					type="button"
					class="sort-pill"
					class:active={effectiveSortBy === mode}
					onclick={() => selectSortMode(mode)}
				>
					{label}
				</button>
			{/each}
			<span class="sort-divider" aria-hidden="true">|</span>
			<button
				type="button"
				class="sort-pill dir-pill"
				class:active={effectiveSortBy !== 'none' && effectiveSortDir === 'asc'}
				title="Sort Ascending"
				onclick={() => selectSortDir('asc')}
			>
				ASC
			</button>
			<button
				type="button"
				class="sort-pill dir-pill"
				class:active={effectiveSortBy !== 'none' && effectiveSortDir === 'desc'}
				title="Sort Descending"
				onclick={() => selectSortDir('desc')}
			>
				DESC
			</button>
		</div>
	</div>

	<div class="hand-fan">
		{#each sortedHand as cardInst, idx (cardInst.instanceId)}
			{@const play = handPlayabilityById[cardInst.instanceId]}
			{@const playable = Boolean(!interactionBlocked && play?.playable)}
			{@const suspendSpec = play?.suspendSpec ?? null}
			{@const canSuspend = Boolean(!interactionBlocked && play?.canSuspend)}
			{@const legalSpecialActions = interactionBlocked
				? []
				: (play?.specialActions ?? []).filter((sa) => sa.legal)}
			{@const offset = idx - (sortedHand.length - 1) / 2}
			<div
				class="hand-card-wrap"
				style="--fan-rot: {offset * 1.4}deg; --fan-y: {Math.abs(offset) * 1.5}px;"
			>
				<button
					type="button"
					class="hand-card"
					class:playable={playable}
					class:unactable={!playable}
					class:dragging-source={draggingInstanceId === cardInst.instanceId}
					draggable={playable}
					data-game-id={cardInst.instanceId}
					onmouseenter={() => handleEnterCard(cardInst, play)}
					onmouseleave={() => handleExitCard(cardInst)}
					ondragstart={(e) => onCardDragStart?.(e, cardInst)}
					ondragend={(e) => {
						lastPreviewedInstanceId = null;
						onAutoTapPreviewChange?.(null);
						onCardDragEnd?.(e);
					}}
					onclick={() => onCardClick?.(cardInst)}
				>
					<img src={cardInst.card.imageUrl} alt={cardInst.card.name} loading="lazy" />
					<span class="hc-cost">
						{#if cardInst.card.manaCost}
							<ManaText text={cardInst.card.manaCost} size={14} />
						{:else if suspendSpec}
							Susp {suspendSpec.suspendCost}
						{:else if play?.isLand}
							Land
						{:else}
							0
						{/if}
					</span>
				</button>

				{#if suspendSpec && canSuspend}
					<button
						type="button"
						class="hc-suspend-btn"
						title="Suspend {suspendSpec.timeCounters} — {suspendSpec.suspendCost}"
						onclick={async (e) => {
							e.stopPropagation();
							await onGameAction?.({
								type: 'suspend_card',
								instanceId: cardInst.instanceId
							});
						}}
					>
						⏳ Suspend ({suspendSpec.timeCounters})
					</button>
				{/if}

				{#each legalSpecialActions as sa, saIdx (sa.id)}
					<button
						type="button"
						class="hc-suspend-btn special-action-btn"
						style="bottom: {4 + (suspendSpec && canSuspend ? saIdx + 1 : saIdx) * 18}px;"
						title={sa.label}
						onclick={async (e) => {
							e.stopPropagation();
							await onGameAction?.({
								type: 'hand_special_action',
								instanceId: cardInst.instanceId,
								actionId: sa.id
							});
						}}
					>
						✨ {sa.label}
					</button>
				{/each}
			</div>
		{/each}
	</div>
</div>

<style>
	.hand-tray {
		display: flex;
		flex-direction: column;
		justify-content: space-between;
		min-width: 0;
		overflow: hidden;
	}
	.hand-toolbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.4rem;
		padding: 0 0.25rem;
		flex-shrink: 0;
	}
	.hand-count-label {
		font-size: 0.62rem;
		font-weight: 700;
		letter-spacing: 0.05em;
		color: var(--mp-text-muted);
	}
	.hand-sort-group {
		display: inline-flex;
		align-items: center;
		gap: 0.2rem;
		flex-wrap: wrap;
	}
	.sort-caption {
		font-size: 0.62rem;
		color: var(--mp-text-faint);
		margin-right: 0.1rem;
	}
	.sort-pill {
		background: var(--mp-bg);
		color: var(--mp-text-muted);
		border: 1px solid var(--mp-border);
		border-radius: 4px;
		padding: 0.08rem 0.36rem;
		font-family: inherit;
		font-size: 0.62rem;
		font-weight: 600;
		cursor: pointer;
		transition: all 0.12s ease;
	}
	.sort-pill:hover {
		border-color: var(--mp-accent);
		color: var(--mp-text);
	}
	.sort-pill.active {
		background: var(--mp-accent);
		color: var(--mp-btn-fg);
		border-color: var(--mp-accent);
	}
	.sort-pill.dir-pill {
		font-size: 0.58rem;
		letter-spacing: 0.03em;
	}
	.sort-divider {
		font-size: 0.6rem;
		color: var(--mp-border-strong);
		margin: 0 0.1rem;
		user-select: none;
	}

	.hand-fan {
		flex: 1;
		display: flex;
		justify-content: center;
		align-items: center;
		min-height: 0;
		padding: 4px 8px;
		overflow-x: auto;
		overflow-y: hidden;
	}
	.hand-card-wrap {
		position: relative;
		display: inline-flex;
		flex-direction: column;
		align-items: center;
	}
	.hand-card {
		position: relative;
		width: var(--hc-w, 78px);
		height: var(--hc-h, 108px);
		max-height: calc(100% - 8px);
		margin: 0 -8px;
		border-radius: 7px;
		border: 1.5px solid var(--mp-border-strong);
		background: var(--mp-bg);
		padding: 0;
		overflow: hidden;
		cursor: pointer;
		transform: translateY(var(--fan-y, 0px)) rotate(var(--fan-rot, 0deg));
		transition:
			transform 0.16s ease,
			border-color 0.16s ease,
			box-shadow 0.16s ease,
			margin 0.16s ease;
		flex-shrink: 0;
	}
	.hand-card:hover {
		transform: translateY(-6px) scale(1.06) rotate(0deg);
		margin: 0 5px;
		z-index: 30;
		border-color: var(--mp-accent);
	}
	.hand-card.playable {
		border-color: var(--mp-cyan);
		box-shadow: 0 0 12px rgba(120, 220, 232, 0.5);
		cursor: grab;
	}
	.hand-card.dragging-source {
		opacity: 0.45;
		cursor: grabbing;
	}
	.hand-card.unactable::after {
		content: '';
		position: absolute;
		inset: 0;
		background: linear-gradient(180deg, rgba(6, 5, 10, 0.52) 0%, rgba(8, 7, 14, 0.58) 100%);
		box-shadow: inset 0 0 12px rgba(0, 0, 0, 0.55);
		border-radius: inherit;
		pointer-events: none;
		z-index: 4;
		transition: opacity 0.14s ease;
	}
	.hand-card.unactable:hover::after {
		opacity: 0.2;
	}
	.hand-card img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.hc-cost {
		position: absolute;
		top: 3px;
		right: 3px;
		background: rgba(18, 16, 22, 0.88);
		color: #ffd866;
		font-size: 0.58rem;
		font-weight: 700;
		padding: 1px 4px;
		border-radius: 3px;
		display: inline-flex;
		align-items: center;
	}
	.hc-suspend-btn {
		position: absolute;
		bottom: 4px;
		left: 3px;
		right: 3px;
		z-index: 6;
		background: rgba(171, 157, 242, 0.92);
		color: #19181a;
		border: 1px solid #ffd866;
		border-radius: 3px;
		padding: 1px 3px;
		font-family: inherit;
		font-size: 0.54rem;
		font-weight: 800;
		cursor: pointer;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.hc-suspend-btn:hover {
		background: #ffd866;
	}
</style>
