<script lang="ts">
	import type { PlayerIncomingForecast } from '../engine.ts';
	import ManaSymbol from '../ManaSymbol.svelte';
	import type {
		CardInstance,
		ManaColor,
		PlayerGameState,
		ScryfallCard,
		TargetRef
	} from '../types.ts';
	import type { PlayerStatusView } from './boardViewModel.ts';

	interface ZoneModalRequest {
		title: string;
		cards: CardInstance[];
		ownerName: string;
	}

	interface Props {
		player: PlayerGameState;
		status: PlayerStatusView;
		playableGraveyardCount?: number;
		permittedExileCards?: CardInstance[];
		playableExileCount?: number;
		incomingForecast?: PlayerIncomingForecast;
		targetable?: boolean;
		canAcceptDrop?: boolean;
		previewManaPoolSpent?: Partial<Record<ManaColor, number>>;
		previewEnergySpent?: number;
		onAvatarClick?: (player: PlayerGameState) => void;
		onDropTarget?: (e: DragEvent, target: TargetRef) => void;
		onOpenZoneModal?: (req: ZoneModalRequest) => void;
		onInspectCard?: (card: ScryfallCard, inst?: CardInstance) => void;
		onHoverCard?: (card: ScryfallCard, inst?: CardInstance) => void;
		onLeaveCard?: (card: ScryfallCard) => void;
		onCompanionToHand?: () => void | Promise<void>;
		onPlayLandFromLibrary?: (inst: CardInstance, faceIndex?: number) => void | Promise<void>;
		onCastFromLibrary?: (inst: CardInstance) => void | Promise<void>;
		onDragTopLibraryCard?: (e: DragEvent, inst: CardInstance) => void;
		onDragEndTopLibraryCard?: () => void;
	}

	let {
		player,
		status,
		playableGraveyardCount = 0,
		permittedExileCards = [],
		playableExileCount = 0,
		incomingForecast,
		targetable = false,
		canAcceptDrop = false,
		previewManaPoolSpent,
		previewEnergySpent = 0,
		onAvatarClick,
		onDropTarget,
		onOpenZoneModal,
		onInspectCard,
		onHoverCard,
		onLeaveCard,
		onCompanionToHand,
		onPlayLandFromLibrary,
		onCastFromLibrary,
		onDragTopLibraryCard,
		onDragEndTopLibraryCard
	}: Props = $props();

	const MANA_ORB_COLORS: readonly ManaColor[] = ['W', 'U', 'B', 'R', 'G', 'C'];

	const snowManaTooltip = $derived.by(() => {
		if (status.snowManaTotal <= 0) return '';
		const breakdown = MANA_ORB_COLORS.filter((c) => (status.snowManaByColor[c] ?? 0) > 0)
			.map((c) => `${status.snowManaByColor[c]} {${c}}`)
			.join(', ');
		return `Snow mana in pool: ${status.snowManaTotal} {S}${breakdown ? ` (${breakdown})` : ''} — spendable on {S} costs (CR 107.4h)`;
	});

	const ringTooltip = $derived(
		status.ringLevel > 0
			? `The Ring (Level ${status.ringLevel}/4 — CR 701.54):\n${status.ringAbilities.join('\n')}`
			: ''
	);

	const hasEpicDesignation = $derived(
		status.cannotCastSpellsForRestOfGame || status.epicSpellNames.length > 0
	);

	const epicTooltip = $derived(
		status.epicSpellNames.length > 0
			? `Epic (CR 702.50): Can't cast spells for the rest of the game. Upkeep copies: ${status.epicSpellNames.join(', ')}`
			: "Can't cast spells for the rest of the game (CR 702.50)"
	);

	const attackTaxTooltip = $derived(
		status.attackTaxPerCreature
			? `Creatures can't attack you unless their controller pays ${status.attackTaxPerCreature} per attacker${
					status.attackTaxSources.length > 0 ? ` (${status.attackTaxSources.join(', ')})` : ''
				} (CR 508.1d)`
			: ''
	);

	const nonShieldRuleLocks = $derived(
		status.activeRuleLocks.filter(
			(l) =>
				l.id !== 'cant_lose_static' &&
				l.id !== 'zero_life_safe' &&
				l.id !== 'life_locked_static'
		)
	);
</script>

<div class="my-vitals">
	<button
		type="button"
		class="my-avatar-btn"
		class:targetable-player={targetable}
		data-game-id={player.playerId}
		onclick={() => onAvatarClick?.(player)}
		ondragover={(e) => {
			if (canAcceptDrop) e.preventDefault();
		}}
		ondrop={(e) =>
			onDropTarget?.(e, {
				kind: 'player',
				id: player.playerId,
				label: player.username
			})}
	>
		<div class="my-vitals-top">
			<span class="my-life" class:low={status.life <= 10}>LIFE {status.life}</span>
			{#if status.isMonarch}
				<span
					class="status-pill monarch"
					data-testid="vitals-monarch-pill"
					title="You are the Monarch (CR 724: draw a card at the beginning of your end step)"
				>
					👑 Monarch
				</span>
			{/if}
			{#if status.hasInitiative}
				<span
					class="status-pill initiative"
					data-testid="vitals-initiative-pill"
					title="You have the Initiative (CR 727: venture into Undercity at upkeep)"
				>
					🔦 Initiative
				</span>
			{/if}
		</div>

		{#if status.speed > 0 || status.hasCitysBlessing || status.hasEnduringStory || hasEpicDesignation || status.ringLevel > 0 || status.activeDungeon || status.completedDungeonCount > 0}
			<div class="player-designations-row">
				{#if status.speed > 0}
					<span
						class="status-pill speed"
						class:max-speed={status.isMaxSpeed}
						data-testid="vitals-speed-pill"
						title={status.isMaxSpeed
							? 'Max Speed (4/4 — CR 702.179: Max speed abilities are unlocked)'
							: `Speed ${status.speed}/4 (CR 702.178: increases once on your turn when an opponent loses life)`}
					>
						{status.isMaxSpeed ? '🔥 MAX SPEED 4' : `⚡ Speed ${status.speed}`}
					</span>
				{/if}
				{#if status.hasCitysBlessing}
					<span
						class="status-pill blessing"
						data-testid="vitals-blessing-pill"
						title="You have the City's Blessing for the rest of the game (CR 702.131)"
					>
						🏛️ City's Blessing
					</span>
				{/if}
				{#if status.hasEnduringStory}
					<span
						class="status-pill storied"
						data-testid="vitals-storied-pill"
						title="You have an Enduring Story for the rest of the game (CR 702.195)"
					>
						📜 Storied
					</span>
				{/if}
				{#if hasEpicDesignation}
					<span
						class="status-pill epic"
						data-testid="vitals-epic-pill"
						title={epicTooltip}
					>
						⏳ Epic{status.epicSpellNames.length > 1 ? ` ×${status.epicSpellNames.length}` : ''}
					</span>
				{/if}
				{#if status.ringLevel > 0}
					<span
						class="status-pill ring"
						data-testid="vitals-ring-pill"
						title={ringTooltip}
					>
						💍 Ring Lv.{status.ringLevel}
					</span>
				{/if}
				{#if status.activeDungeon}
					<span
						class="status-pill dungeon"
						data-testid="vitals-dungeon-pill"
						title={`${status.activeDungeon.dungeonName} — Room ${status.activeDungeon.roomIndex + 1}/${status.activeDungeon.totalRooms} (${status.activeDungeon.roomName}): ${status.activeDungeon.roomEffectText}`}
					>
						🗺️ {status.activeDungeon.dungeonName}: {status.activeDungeon.roomName}
					</span>
				{/if}
				{#if status.completedDungeonCount > 0}
					<span
						class="status-pill dungeon-done"
						title={`Completed dungeons (${status.completedDungeonCount}): ${status.completedDungeonNames.join(', ') || status.completedDungeonCount}`}
					>
						🏆 ×{status.completedDungeonCount}
					</span>
				{/if}
			</div>
		{/if}

		{#if status.poison > 0 || status.energyCounters > 0 || status.experienceCounters > 0 || status.radCounters > 0}
			<div class="player-counters-row">
				{#if status.energyCounters > 0}
					<span
						class="status-pill energy"
						class:preview-spend={previewEnergySpent > 0}
						title="Energy counters ({status.energyCounters}){previewEnergySpent > 0
							? ` — auto-tap spends ${previewEnergySpent}`
							: ''}"
					>
						<ManaSymbol symbol="E" size={13} />
						<span>{status.energyCounters}</span>
						{#if previewEnergySpent > 0}
							<span class="spend-delta">-{previewEnergySpent}</span>
						{/if}
					</span>
				{/if}
				{#if status.experienceCounters > 0}
					<span class="status-pill exp" title="Experience counters: {status.experienceCounters}">
						✦ EXP {status.experienceCounters}
					</span>
				{/if}
				{#if status.poison > 0}
					<span class="status-pill poison" title="Poison counters: {status.poison}">
						☠ {status.poison}
					</span>
				{/if}
				{#if status.radCounters > 0}
					<span class="status-pill rad" title="Rad counters: {status.radCounters}">
						☢ {status.radCounters}
					</span>
				{/if}
			</div>
		{/if}

		{#if status.turnShieldBadges.length > 0 || status.attackTaxPerCreature || nonShieldRuleLocks.length > 0}
			<div class="player-shields-row">
				{#if status.attackTaxPerCreature}
					<span
						class="shield-pill cyan"
						data-testid="vitals-attack-tax-pill"
						title={attackTaxTooltip}
					>
						🛡️ Tax {status.attackTaxPerCreature}/atk
					</span>
				{/if}
				{#each status.turnShieldBadges as shield (shield.id)}
					<span class="shield-pill {shield.tone}" data-testid="vitals-shield-pill" title={shield.description}>
						🛡️ {shield.label}
					</span>
				{/each}
				{#each nonShieldRuleLocks as lock (lock.id)}
					<span
						class="shield-pill {lock.tone}"
						data-testid="vitals-rule-lock-pill"
						title={lock.description}
					>
						⚖️ {lock.label}
					</span>
				{/each}
			</div>
		{/if}

		{#if incomingForecast && (incomingForecast.unblockedCount > 0 || incomingForecast.blockedCount > 0)}
			<div
				class="incoming-dmg-layover my-incoming"
				class:lethal={incomingForecast.isLethal}
				class:all-blocked={
					incomingForecast.totalLifeLoss === 0 && incomingForecast.totalPoisonGain === 0
				}
			>
				{#if incomingForecast.totalLifeLoss > 0}
					⚔️ INCOMING: -{incomingForecast.totalLifeLoss} LIFE ({status.life} → {incomingForecast.projectedLife})
				{:else if incomingForecast.totalPoisonGain > 0}
					☠️ INCOMING: +{incomingForecast.totalPoisonGain} POISON ({status.poison} → {incomingForecast.projectedPoison})
				{:else}
					🛡️ 0 DAMAGE (ALL BLOCKED)
				{/if}
				{#if incomingForecast.isLethal} · 💀 LETHAL!{/if}
			</div>
		{/if}

		<span class="my-uname" title={status.username}>{status.username}</span>
	</button>

	{#if status.commanderDamageEntries.length > 0}
		<div class="cmd-dmg-bar">
			{#each status.commanderDamageEntries as entry (entry.commanderId)}
				<span
					class="cmd-dmg-pill"
					title="Commander Combat Damage from {entry.commanderName}"
				>
					CMD {entry.shortName}: {entry.damage}/{entry.lethalThreshold || 'INF'}
				</span>
			{/each}
		</div>
	{/if}

	<!-- Mana Pool Orbs (Unrestricted + All Restricted Mana Buckets) -->
	<div class="mana-pool">
		{#each MANA_ORB_COLORS as col (col)}
			{@const amt = player.manaPool[col] || 0}
			{@const previewSpent = previewManaPoolSpent?.[col] || 0}
			<span
				class="mana-orb"
				class:filled={amt > 0}
				class:preview-spend={previewSpent > 0}
				title={`${amt} {${col}} in mana pool${previewSpent > 0 ? ` (auto-tap spends ${previewSpent})` : ''}`}
			>
				<ManaSymbol symbol={col} size={15} />
				<span>{amt}</span>
			</span>
		{/each}
		{#if status.snowManaTotal > 0}
			<span
				class="mana-orb filled snow-mana"
				data-testid="vitals-snow-mana"
				title={snowManaTooltip}
			>
				<ManaSymbol symbol="S" size={14} />
				<span>Snow ({status.snowManaTotal})</span>
			</span>
		{/if}
		{#each status.restrictedManaEntries as entry (entry.restriction)}
			<span
				class="mana-orb filled restricted-mana"
				title={entry.description}
			>
				<span class="rm-icons">
					{#each entry.colors as cItem (cItem.color)}
						<ManaSymbol symbol={cItem.color} size={13} />
						{#if cItem.amount > 1}<span>×{cItem.amount}</span>{/if}
					{/each}
				</span>
				<span class="rm-label">{entry.label} ({entry.total})</span>
			</span>
		{/each}
	</div>

	<div class="my-zones">
		<span class="z-chip" title="Lands played this turn">
			Lands {player.landsPlayedThisTurn}/{player.maxLandsPerTurn}
		</span>
		<span
			class="z-chip"
			data-game-id="{player.playerId}:library"
			title="Cards remaining in library"
		>
			Lib {player.libraryCount ?? player.library.length}
		</span>
		<button
			type="button"
			class="z-chip clickable"
			class:has-playable={playableGraveyardCount > 0}
			data-game-id="{player.playerId}:graveyard"
			title={playableGraveyardCount > 0
				? `${playableGraveyardCount} playable card(s) in your graveyard`
				: 'Open your graveyard'}
			onclick={() =>
				onOpenZoneModal?.({
					title: 'Your Graveyard',
					cards: player.graveyard,
					ownerName: player.username
				})}
		>
			GY {player.graveyard.length}{#if playableGraveyardCount > 0} ✨{playableGraveyardCount}{/if}
		</button>
		<button
			type="button"
			class="z-chip clickable"
			data-game-id="{player.playerId}:exile"
			onclick={() =>
				onOpenZoneModal?.({
					title: 'Your Exile',
					cards: player.exile,
					ownerName: player.username
				})}
		>
			Exile {player.exile.length}
		</button>
		{#if status.emblems.length > 0}
			<button
				type="button"
				class="z-chip clickable emblem-chip"
				data-testid="vitals-emblems-chip"
				title={status.emblems.map((em) => em.card.name).join(' · ')}
				onclick={() =>
					onOpenZoneModal?.({
						title: 'Your Emblems',
						cards: status.emblems,
						ownerName: player.username
					})}
			>
				🛡️ Emblems ({status.emblems.length})
			</button>
		{/if}
		{#if permittedExileCards.length > 0}
			<button
				type="button"
				class="z-chip clickable exile-playable-chip"
				class:has-playable={playableExileCount > 0}
				title="Cards in Exile you have permission to play"
				onclick={() =>
					onOpenZoneModal?.({
						title: 'Playable from Exile',
						cards: permittedExileCards,
						ownerName: player.username
					})}
			>
				✨ Exile Play ({permittedExileCards.length})
			</button>
		{/if}
		{#if status.companionView}
			{@const compView = status.companionView}
			<div class="vitals-special-strip" data-testid="vitals-companion-strip">
				<button
					type="button"
					class="vitals-card-link"
					title={`Designated outside-the-game card: ${compView.card.name} (CR 702.139)`}
					onmouseenter={() => onHoverCard?.(compView.card)}
					onmouseleave={() => onLeaveCard?.(compView.card)}
					onclick={() => onInspectCard?.(compView.card)}
				>
					🐾 {compView.card.name}
				</button>
				{#if onCompanionToHand}
					<button
						type="button"
						class="vitals-mini-action"
						data-testid="vitals-companion-to-hand-btn"
						disabled={!compView.canMoveToHand}
						title={compView.canMoveToHand
							? 'Pay {3} to put your designated card into your hand (CR 116.2g)'
							: (compView.illegalityReason ?? 'Cannot use special action right now.')}
						onclick={() => onCompanionToHand?.()}
					>
						&#123;3&#125; → Hand
					</button>
				{/if}
			</div>
		{/if}
		{#if status.topOfLibraryView?.topCard}
			{@const topLibView = status.topOfLibraryView}
			{@const topCard = topLibView.topCard!}
			<div
				class="vitals-special-strip"
				class:has-playable={topLibView.canPlayOrCast}
				data-testid="vitals-top-of-library"
			>
				<button
					type="button"
					class="vitals-card-link"
					draggable={topLibView.canPlayOrCast}
					data-game-id={topCard.instanceId}
					title={`Top of library (${topLibView.visibility === 'revealed' ? 'Revealed' : topLibView.visibility === 'look' ? 'Lookable' : 'Known'} — CR 401.5): ${topCard.card.name}`}
					onmouseenter={() => onHoverCard?.(topCard.card, topCard)}
					onmouseleave={() => onLeaveCard?.(topCard.card)}
					onclick={() => onInspectCard?.(topCard.card, topCard)}
					ondragstart={(e) => onDragTopLibraryCard?.(e, topCard)}
					ondragend={() => onDragEndTopLibraryCard?.()}
				>
					📖 Top: {topCard.card.name}
				</button>
				{#each topLibView.libraryLandPlayOptions as landOpt (landOpt.faceIndex)}
					<button
						type="button"
						class="vitals-mini-action"
						data-testid="vitals-top-lib-play-land-btn"
						onclick={() => onPlayLandFromLibrary?.(topCard, landOpt.faceIndex)}
					>
						{topLibView.libraryLandPlayOptions.length > 1
							? `Play (${landOpt.label})`
							: 'Play Land'}
					</button>
				{/each}
				{#if topLibView.libraryCastOptions.length > 0}
					<button
						type="button"
						class="vitals-mini-action"
						data-testid="vitals-top-lib-cast-btn"
						onclick={() => onCastFromLibrary?.(topCard)}
					>
						Cast
					</button>
				{/if}
			</div>
		{/if}
	</div>
</div>

<style>
	.my-vitals {
		display: flex;
		flex-direction: column;
		justify-content: space-between;
		gap: 0.24rem;
		min-width: 0;
		overflow-y: auto;
		overflow-x: hidden;
	}
	.my-avatar-btn {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.16rem;
		width: 100%;
		background: var(--mp-bg);
		border: 1.5px solid var(--mp-border-strong);
		border-radius: 7px;
		padding: 0.28rem 0.48rem;
		color: var(--mp-text);
		font-family: inherit;
		text-align: left;
		cursor: pointer;
	}
	.my-avatar-btn.targetable-player {
		border-color: #ffd866;
		box-shadow: 0 0 12px rgba(255, 216, 102, 0.55);
	}
	.my-vitals-top {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.3rem;
		width: 100%;
		flex-wrap: wrap;
	}
	.my-life {
		font-size: 0.92rem;
		font-weight: 700;
		line-height: 1.1;
		color: var(--mp-green);
	}
	.my-life.low {
		color: var(--mp-red);
	}
	.my-uname {
		font-size: 0.7rem;
		font-weight: 600;
		color: var(--mp-text-muted);
		width: 100%;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.player-counters-row,
	.player-shields-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.2rem;
		width: 100%;
	}
	.status-pill {
		display: inline-flex;
		align-items: center;
		gap: 0.16rem;
		font-size: 0.6rem;
		font-weight: 700;
		padding: 0.06rem 0.3rem;
		border-radius: 4px;
		background: var(--mp-bg-elevated);
		border: 1px solid var(--mp-border-strong);
		line-height: 1.15;
	}
	.status-pill.monarch {
		border-color: #ffd866;
		color: #ffd866;
		background: rgba(255, 216, 102, 0.14);
	}
	.status-pill.initiative {
		border-color: #fc9867;
		color: #fc9867;
		background: rgba(252, 152, 103, 0.14);
	}
	.player-designations-row {
		display: flex;
		flex-wrap: wrap;
		gap: 0.18rem;
		width: 100%;
	}
	.status-pill.speed {
		border-color: #fc9867;
		color: #fc9867;
		background: rgba(252, 152, 103, 0.12);
	}
	.status-pill.speed.max-speed {
		border-color: #ffd866;
		color: #ffd866;
		background: rgba(255, 97, 136, 0.22);
		box-shadow: 0 0 8px rgba(255, 216, 102, 0.45);
	}
	.status-pill.blessing {
		border-color: var(--mp-cyan);
		color: var(--mp-cyan);
		background: rgba(120, 220, 232, 0.12);
	}
	.status-pill.storied {
		border-color: #ffd866;
		color: #ffd866;
		background: rgba(255, 216, 102, 0.14);
	}
	.status-pill.epic {
		border-color: var(--mp-red);
		color: var(--mp-red);
		background: rgba(255, 97, 136, 0.14);
	}
	.status-pill.ring {
		border-color: #ffd866;
		color: #ffd866;
		background: rgba(255, 216, 102, 0.15);
	}
	.status-pill.dungeon {
		border-color: var(--mp-purple);
		color: var(--mp-purple);
		background: rgba(171, 157, 242, 0.14);
		max-width: 100%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.status-pill.dungeon-done {
		border-color: var(--mp-green);
		color: var(--mp-green);
		background: rgba(169, 220, 118, 0.12);
	}
	.status-pill.energy {
		border-color: #f59e0b;
		color: #ffd866;
	}
	.status-pill.energy.preview-spend {
		box-shadow: 0 0 8px rgba(245, 158, 11, 0.75);
	}
	.spend-delta {
		color: var(--mp-red);
		font-weight: 800;
	}
	.status-pill.exp {
		border-color: var(--mp-cyan);
		color: var(--mp-cyan);
	}
	.status-pill.poison {
		border-color: var(--mp-purple);
		color: var(--mp-purple);
	}
	.status-pill.rad {
		border-color: var(--mp-green);
		color: var(--mp-green);
	}

	.shield-pill {
		font-size: 0.56rem;
		font-weight: 700;
		padding: 0.05rem 0.28rem;
		border-radius: 3px;
		border: 1px solid var(--mp-border-strong);
	}
	.shield-pill.gold {
		border-color: #ffd866;
		color: #ffd866;
		background: rgba(255, 216, 102, 0.12);
	}
	.shield-pill.cyan {
		border-color: var(--mp-cyan);
		color: var(--mp-cyan);
		background: rgba(120, 220, 232, 0.12);
	}
	.shield-pill.purple {
		border-color: var(--mp-purple);
		color: var(--mp-purple);
		background: rgba(171, 157, 242, 0.12);
	}
	.shield-pill.amber {
		border-color: #f59e0b;
		color: #ffd866;
		background: rgba(245, 158, 11, 0.14);
	}
	.shield-pill.red {
		border-color: var(--mp-red);
		color: var(--mp-red);
		background: rgba(255, 97, 136, 0.14);
	}
	.shield-pill.green {
		border-color: var(--mp-green);
		color: var(--mp-green);
		background: rgba(169, 220, 118, 0.12);
	}

	.cmd-dmg-bar {
		display: flex;
		flex-wrap: wrap;
		gap: 0.2rem;
	}
	.cmd-dmg-pill {
		font-size: 0.58rem;
		background: var(--mp-bg);
		border: 1px solid var(--mp-red);
		color: var(--mp-red);
		padding: 0.04rem 0.26rem;
		border-radius: 3px;
	}

	.mana-pool {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 0.18rem;
	}
	.mana-orb {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.18rem;
		font-size: 0.62rem;
		padding: 0.08rem 0.2rem;
		border-radius: 4px;
		background: var(--mp-bg);
		border: 1px solid var(--mp-border);
		color: var(--mp-text-muted);
	}
	.mana-orb.filled {
		border-color: var(--mp-accent);
		color: var(--mp-text);
		font-weight: 700;
	}
	.mana-orb.preview-spend {
		border-color: #f59e0b;
		box-shadow: 0 0 8px rgba(245, 158, 11, 0.7);
	}
	.mana-orb.snow-mana {
		grid-column: 1 / -1;
		justify-content: center;
		gap: 0.28rem;
		border-color: var(--mp-cyan);
		color: var(--mp-cyan);
		background: rgba(120, 220, 232, 0.12);
		font-size: 0.6rem;
	}
	.mana-orb.restricted-mana {
		grid-column: 1 / -1;
		justify-content: space-between;
		padding: 0.1rem 0.3rem;
		border-color: #d97706;
		font-size: 0.58rem;
	}
	.rm-icons {
		display: inline-flex;
		align-items: center;
		gap: 0.14rem;
	}
	.rm-label {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.my-zones {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.2rem;
	}
	.z-chip {
		text-align: center;
		padding: 0.1rem 0.24rem;
		font-size: 0.62rem;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		background: var(--mp-bg);
		border: 1px solid var(--mp-border);
		color: var(--mp-text-muted);
		border-radius: 4px;
		font-family: inherit;
	}
	.z-chip.clickable {
		cursor: pointer;
	}
	.z-chip.clickable:hover {
		border-color: var(--mp-cyan);
		color: var(--mp-cyan);
	}
	.z-chip.has-playable {
		border-color: #ffd866;
		color: #ffd866;
		box-shadow: 0 0 6px rgba(255, 216, 102, 0.35);
	}
	.emblem-chip {
		grid-column: 1 / -1;
		border-color: var(--mp-purple);
		color: var(--mp-purple);
	}
	.exile-playable-chip {
		grid-column: 1 / -1;
	}
	.vitals-special-strip {
		grid-column: 1 / -1;
		display: flex;
		align-items: center;
		gap: 0.2rem;
		background: var(--mp-bg);
		border: 1px solid var(--mp-border-strong);
		border-radius: 4px;
		padding: 0.1rem 0.22rem;
		min-width: 0;
	}
	.vitals-special-strip.has-playable {
		border-color: #ffd866;
		box-shadow: 0 0 6px rgba(255, 216, 102, 0.3);
	}
	.vitals-card-link {
		flex: 1;
		min-width: 0;
		background: transparent;
		border: none;
		color: var(--mp-cyan);
		font-family: inherit;
		font-size: 0.6rem;
		font-weight: 700;
		text-align: left;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		padding: 0;
		cursor: pointer;
	}
	.vitals-card-link:hover {
		color: #ffd866;
	}
	.vitals-mini-action {
		flex-shrink: 0;
		background: rgba(255, 216, 102, 0.16);
		color: #ffd866;
		border: 1px solid rgba(255, 216, 102, 0.65);
		border-radius: 3px;
		padding: 0.04rem 0.28rem;
		font-family: inherit;
		font-size: 0.56rem;
		font-weight: 800;
		cursor: pointer;
	}
	.vitals-mini-action:hover:not(:disabled) {
		background: #ffd866;
		color: #19181a;
	}
	.vitals-mini-action:disabled {
		opacity: 0.42;
		cursor: not-allowed;
	}

	.incoming-dmg-layover {
		display: inline-flex;
		align-items: center;
		gap: 0.2rem;
		background: rgba(255, 97, 136, 0.22);
		border: 1px solid var(--mp-red);
		color: #ffd866;
		border-radius: 4px;
		padding: 0.08rem 0.36rem;
		font-size: 0.62rem;
		font-weight: 800;
	}
	.incoming-dmg-layover.my-incoming {
		width: 100%;
		justify-content: center;
		margin: 1px 0;
		padding: 0.12rem 0.32rem;
	}
	.incoming-dmg-layover.all-blocked {
		background: rgba(120, 220, 232, 0.18);
		border-color: var(--mp-cyan);
		color: var(--mp-cyan);
	}
	.incoming-dmg-layover.lethal {
		background: rgba(255, 97, 136, 0.9);
		color: #fff;
		border-color: #ffd866;
		box-shadow: 0 0 10px rgba(255, 97, 136, 0.7);
	}
</style>
