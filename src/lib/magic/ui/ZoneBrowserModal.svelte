<script lang="ts">
	import {
		checkAbilityActivationLegality,
		getCastOptions,
		getEffectiveActivatedAbilities,
		getLandPlayOptions,
		getPlayerCommanderIdentity
	} from '../engine.ts';
	import { matchesScryfallQuery } from '../search.ts';
	import type {
		CardInstance,
		EffectiveActivatedAbility,
		GameActionPayload,
		GameState,
		PlayerGameState,
		ScryfallCard,
		TargetRef
	} from '../types.ts';
	import { DUNGEON_ART_URI, EMBLEM_ART_URI } from './boardViewModel.ts';
	import { FACE_DOWN_ART_URI, resolveCardInstanceDisplay } from './promptViewModel.ts';

	let {
		ownerName,
		title,
		cards,
		gameState,
		viewer = null,
		isGraveTargeting = false,
		isZoneTargeting = false,
		selectedTargets = [],
		minTargets = 1,
		isCardTargetable,
		isCardPlayableNow,
		getZoneAbilitiesOverride,
		onSelectTarget,
		onConfirmTargets,
		onCancelTargeting,
		onPlayFromZone,
		onGameAction,
		onClose,
		onHoverCard,
		onLeaveCard
	}: {
		ownerName: string;
		title: string;
		cards: CardInstance[];
		gameState: GameState;
		viewer?: PlayerGameState | null;
		isGraveTargeting?: boolean;
		isZoneTargeting?: boolean;
		selectedTargets?: TargetRef[];
		minTargets?: number;
		isCardTargetable?: (inst: CardInstance) => boolean;
		isCardPlayableNow?: (inst: CardInstance, zone: 'exile' | 'graveyard' | 'command') => boolean;
		getZoneAbilitiesOverride?: (
			inst: CardInstance,
			zone: 'graveyard'
		) => EffectiveActivatedAbility[];
		onSelectTarget?: (target: TargetRef) => void | Promise<void>;
		onConfirmTargets?: () => void | Promise<void>;
		onCancelTargeting?: () => void;
		onPlayFromZone?: (
			inst: CardInstance,
			zone: 'exile' | 'graveyard' | 'command'
		) => void | Promise<void>;
		onGameAction: (action: GameActionPayload) => void | Promise<void>;
		onClose: () => void;
		onHoverCard?: (card: ScryfallCard, inst?: CardInstance) => void;
		onLeaveCard?: (card: ScryfallCard) => void;
	} = $props();

	const activeZoneTargeting = $derived(isZoneTargeting || isGraveTargeting);

	let zoneSearchQuery = $state('');

	const filteredZoneCards = $derived(
		cards.filter((c) => {
			const disp = resolveCardInstanceDisplay(c, c.zone, viewer?.playerId ?? null);
			return matchesScryfallQuery(disp.displayCard, zoneSearchQuery);
		})
	);

	function defaultGetZoneAbilities(inst: CardInstance): EffectiveActivatedAbility[] {
		if (!viewer || inst.zone !== 'graveyard') return [];
		const cmdIdentity = getPlayerCommanderIdentity(viewer);
		return getEffectiveActivatedAbilities(gameState, viewer, inst, cmdIdentity).filter(
			(ab) =>
				!ab.isManaAbility &&
				Boolean(ab.activationZones?.includes('graveyard')) &&
				checkAbilityActivationLegality(gameState, viewer.playerId, inst, ab).ok
		);
	}

	function resolveGraveAbilities(inst: CardInstance): EffectiveActivatedAbility[] {
		return getZoneAbilitiesOverride
			? getZoneAbilitiesOverride(inst, 'graveyard')
			: defaultGetZoneAbilities(inst);
	}

	async function moveGraveyardCard(gyIndex: number, dir: 1 | -1) {
		const swapIndex = gyIndex + dir;
		if (swapIndex < 0 || swapIndex >= cards.length) return;
		const ids = cards.map((x) => x.instanceId);
		const tmp = ids[gyIndex];
		ids[gyIndex] = ids[swapIndex];
		ids[swapIndex] = tmp;
		await onGameAction({ type: 'reorder_graveyard', instanceIds: ids });
	}
</script>

<div class="modal-backdrop">
	<div class="arena-modal wide">
		<div class="modal-head-row">
			<h3>{ownerName} — {title} ({filteredZoneCards.length}/{cards.length})</h3>
			<input
				type="search"
				class="modal-scryfall-input"
				bind:value={zoneSearchQuery}
				placeholder="Scryfall search (e.g. t:creature mv<=3 o:draw)..."
			/>
		</div>

		<div class="modal-card-grid">
			{#each filteredZoneCards as c (c.instanceId)}
				{@const disp = resolveCardInstanceDisplay(c, c.zone, viewer?.playerId ?? null)}
				{#if activeZoneTargeting}
					{@const canTarget = isCardTargetable ? isCardTargetable(c) : true}
					{@const isSelected = selectedTargets.some((t) => t.id === c.instanceId)}
					<button
						type="button"
						class="modal-card-item selectable"
						class:selected={isSelected}
						disabled={!canTarget}
						data-game-id={c.instanceId}
						onmouseenter={() => onHoverCard?.(disp.displayCard, c)}
						onmouseleave={() => onLeaveCard?.(disp.displayCard)}
						onclick={() =>
							onSelectTarget?.({
								kind: c.zone === 'exile' ? 'exile_card' : 'graveyard_card',
								id: c.instanceId,
								label: disp.displayCard.name
							})}
					>
						<img src={disp.imageUrl} alt={disp.displayCard.name} />
						<span>{disp.displayCard.name}</span>
					</button>
				{:else}
					{@const isMyGraveyard = Boolean(
						viewer && title.includes('Graveyard') && ownerName === viewer.username
					)}
					{@const gyIndex = cards.findIndex((item) => item.instanceId === c.instanceId)}
					{@const exileCastOptions =
						viewer && c.zone === 'exile'
							? getCastOptions(gameState, viewer.playerId, c, 'exile')
							: []}
					{@const canPlayFromExile = Boolean(
						viewer &&
							c.zone === 'exile' &&
							(isCardPlayableNow ? isCardPlayableNow(c, 'exile') : exileCastOptions.length > 0)
					)}
					{@const gyCastOptions =
						viewer && isMyGraveyard && c.zone === 'graveyard'
							? getCastOptions(gameState, viewer.playerId, c, 'graveyard')
							: []}
					{@const gyZoneAbilities =
						viewer && isMyGraveyard && c.zone === 'graveyard' ? resolveGraveAbilities(c) : []}
					{@const canPlayFromGraveyard = Boolean(
						isMyGraveyard &&
							c.zone === 'graveyard' &&
							(isCardPlayableNow
								? isCardPlayableNow(c, 'graveyard')
								: gyCastOptions.length > 0 || gyZoneAbilities.length > 0)
					)}
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<div
						class="modal-card-item"
						class:playable-zone-card={canPlayFromGraveyard || canPlayFromExile}
						data-game-id={c.instanceId}
						onmouseenter={() => onHoverCard?.(disp.displayCard, c)}
						onmouseleave={() => onLeaveCard?.(disp.displayCard)}
					>
						<img
							src={disp.imageUrl ||
								(c.isEmblem
									? EMBLEM_ART_URI
									: c.isDungeon
										? DUNGEON_ART_URI
										: FACE_DOWN_ART_URI)}
							alt={disp.displayCard.name}
						/>
						<span>{disp.displayCard.name}</span>

						{#if c.isEmblem}
							<span class="badge purple">🛡️ Emblem (CR 114)</span>
						{:else if c.isDungeon}
							<span class="badge gold">🗺️ Dungeon (CR 309)</span>
						{/if}

						{#if c.isSuspended && c.counters.time > 0}
							<span class="badge purple">⏳ {c.counters.time} Time (Suspended)</span>
						{/if}

						{#if viewer && c.zone === 'exile' && (c.playableFromExileBy?.playerId === viewer.playerId || exileCastOptions.length > 0)}
							{@const exileIsLand =
								getLandPlayOptions(gameState, viewer.playerId, c, 'exile').length > 0}
							{@const exileIsSpell = exileCastOptions.length > 0}
							<span class="badge gold">
								✨ {c.playableFromExileBy?.sourceName
									? `Playable (${c.playableFromExileBy.sourceName})`
									: `Castable (${exileCastOptions.map((o) => o.costDisplay).join(' / ')})`}
							</span>
							{#if onPlayFromZone}
								<button
									type="button"
									class="scry-zone-toggle to-top"
									disabled={!canPlayFromExile}
									onclick={async () => {
										zoneSearchQuery = '';
										onClose();
										await onPlayFromZone(c, 'exile');
									}}
								>
									{exileIsLand && exileIsSpell
										? '▶ Play / Cast from Exile'
										: exileIsLand
											? '▶ Play Land from Exile'
											: '▶ Cast from Exile'}
								</button>
							{/if}
						{/if}

						{#if gyCastOptions.length > 0 || gyZoneAbilities.length > 0}
							<span class="badge gold">
								✨ {gyCastOptions.length > 0
									? `Castable (${gyCastOptions.map((o) => o.costDisplay).join(' / ')})`
									: gyZoneAbilities.map((a) => a.label).join(' / ')}
							</span>
							{#if onPlayFromZone}
								<button
									type="button"
									class="scry-zone-toggle to-top"
									disabled={!canPlayFromGraveyard}
									onclick={async () => {
										zoneSearchQuery = '';
										onClose();
										await onPlayFromZone(c, 'graveyard');
									}}
								>
									{gyCastOptions.length > 0 && gyZoneAbilities.length > 0
										? '▶ Cast / Activate'
										: gyCastOptions.length > 0
											? '▶ Cast from Graveyard'
											: '▶ Activate Ability'}
								</button>
							{/if}
						{/if}

						{#if title.includes('Graveyard') && gyIndex >= 0}
							<div class="gy-order-bar">
								<span class="gy-rank">
									#{cards.length - gyIndex}
									{gyIndex === cards.length - 1 ? '(Top)' : gyIndex === 0 ? '(Bottom)' : ''}
								</span>
								{#if isMyGraveyard && cards.length > 1}
									<button
										type="button"
										class="gy-move-btn"
										disabled={gyIndex >= cards.length - 1}
										title="Move toward Top of Graveyard (CR 404.2)"
										onclick={() => moveGraveyardCard(gyIndex, 1)}
									>
										⬆
									</button>
									<button
										type="button"
										class="gy-move-btn"
										disabled={gyIndex <= 0}
										title="Move toward Bottom of Graveyard (CR 404.2)"
										onclick={() => moveGraveyardCard(gyIndex, -1)}
									>
										⬇
									</button>
								{/if}
							</div>
						{/if}
					</div>
				{/if}
			{/each}
		</div>

		<div class="modal-actions">
			{#if activeZoneTargeting && selectedTargets.length >= minTargets && onConfirmTargets}
				<button type="button" class="arena-main-btn can-act" onclick={() => onConfirmTargets()}>
					Confirm {selectedTargets.length} Target(s)
				</button>
			{/if}
			{#if activeZoneTargeting && onCancelTargeting}
				<button
					type="button"
					class="hud-btn"
					onclick={() => {
						zoneSearchQuery = '';
						onClose();
					}}
				>
					Close Drawer
				</button>
			{/if}
			<button
				type="button"
				class="hud-btn"
				onclick={() => {
					zoneSearchQuery = '';
					if (activeZoneTargeting && onCancelTargeting) {
						onCancelTargeting();
					} else {
						onClose();
					}
				}}
			>
				{activeZoneTargeting ? 'Cancel Targeting' : 'Close'}
			</button>
		</div>
	</div>
</div>

<style>
	.modal-backdrop {
		position: fixed;
		inset: 0;
		background: rgba(10, 8, 14, 0.78);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 200;
		padding: 1rem;
		font-family: var(--mono-font, monospace);
	}
	.arena-modal.wide {
		background: var(--mp-bg-elevated, #221f22);
		border: 1.5px solid var(--mp-accent, #ffd866);
		border-radius: 10px;
		padding: 1.15rem;
		max-width: 820px;
		width: 100%;
		max-height: 86vh;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		box-shadow: 0 16px 48px rgba(0, 0, 0, 0.65);
	}
	.modal-head-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.65rem;
		flex-wrap: wrap;
	}
	.arena-modal h3 {
		margin: 0;
		color: var(--mp-accent, #ffd866);
	}
	.modal-scryfall-input {
		flex: 1 1 220px;
		max-width: 340px;
		background: var(--mp-bg, #19181a);
		color: var(--mp-text, #fcfcfa);
		border: 1px solid var(--mp-border-strong, #524c58);
		border-radius: 5px;
		padding: 0.32rem 0.55rem;
		font-family: inherit;
		font-size: 0.72rem;
	}
	.modal-scryfall-input:focus {
		outline: none;
		border-color: var(--mp-accent, #ffd866);
	}
	.modal-card-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(115px, 1fr));
		gap: 0.6rem;
		max-height: 48vh;
		overflow-y: auto;
	}
	.modal-card-item {
		background: var(--mp-bg, #19181a);
		border: 1.5px solid var(--mp-border-strong, #524c58);
		border-radius: 6px;
		padding: 0.3rem;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.25rem;
		font-size: 0.68rem;
		color: var(--mp-text, #fcfcfa);
		font-family: inherit;
	}
	.modal-card-item.selectable {
		cursor: pointer;
	}
	.modal-card-item.selected {
		border-color: var(--mp-accent, #ffd866);
		box-shadow: 0 0 10px var(--mp-accent, #ffd866);
	}
	.modal-card-item.playable-zone-card {
		border-color: #ffd866;
		box-shadow: 0 0 8px rgba(255, 216, 102, 0.35);
	}
	.modal-card-item:disabled {
		opacity: 0.35;
		cursor: not-allowed;
	}
	.modal-card-item img {
		width: 100%;
		border-radius: 4px;
	}
	.badge {
		padding: 1px 5px;
		border-radius: 4px;
		font-size: 0.58rem;
		font-weight: 700;
		text-align: center;
	}
	.badge.purple {
		background: rgba(171, 157, 242, 0.2);
		color: var(--mp-purple, #ab9df2);
		border: 1px solid rgba(171, 157, 242, 0.55);
	}
	.badge.gold {
		background: rgba(255, 216, 102, 0.16);
		color: #ffd866;
		border: 1px solid rgba(255, 216, 102, 0.55);
	}
	.scry-zone-toggle {
		width: 100%;
		background: var(--mp-bg-elevated, #221f22);
		border: 1px solid var(--mp-border-strong, #524c58);
		color: var(--mp-text, #fcfcfa);
		border-radius: 4px;
		padding: 0.18rem 0.3rem;
		font-family: inherit;
		font-size: 0.6rem;
		font-weight: 700;
		cursor: pointer;
	}
	.scry-zone-toggle.to-top:hover:not(:disabled) {
		border-color: var(--mp-cyan, #78dce8);
		color: var(--mp-cyan, #78dce8);
	}
	.scry-zone-toggle:disabled {
		opacity: 0.38;
		cursor: not-allowed;
	}
	.gy-order-bar {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		width: 100%;
		justify-content: center;
		margin-top: 2px;
	}
	.gy-rank {
		font-size: 0.6rem;
		color: var(--mp-text-muted, #939293);
		font-weight: 700;
	}
	.gy-move-btn {
		background: var(--mp-bg, #19181a);
		color: var(--mp-text, #fcfcfa);
		border: 1px solid var(--mp-border-strong, #524c58);
		border-radius: 3px;
		padding: 0 4px;
		font-size: 0.6rem;
		cursor: pointer;
	}
	.gy-move-btn:disabled {
		opacity: 0.35;
		cursor: not-allowed;
	}
	.modal-actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.6rem;
		flex-wrap: wrap;
	}
	.arena-main-btn {
		background: var(--mp-btn-bg, #ffd866);
		color: var(--mp-btn-fg, #19181a);
		border: 2px solid var(--mp-btn-bg, #ffd866);
		border-radius: 8px;
		padding: 0.65rem 0.85rem;
		font-family: inherit;
		font-size: 0.8rem;
		font-weight: 700;
		cursor: pointer;
	}
	.hud-btn {
		background: var(--mp-bg, #19181a);
		color: var(--mp-text, #fcfcfa);
		border: 1px solid var(--mp-border-strong, #524c58);
		border-radius: 6px;
		padding: 0.45rem 0.75rem;
		font-family: inherit;
		font-size: 0.76rem;
		font-weight: 600;
		cursor: pointer;
	}
</style>
