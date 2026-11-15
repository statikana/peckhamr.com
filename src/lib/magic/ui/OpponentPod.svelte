<script lang="ts">
	import type { CombatDamageForecast, PlayerIncomingForecast } from '../engine.ts';
	import ManaSymbol from '../ManaSymbol.svelte';
	import type { CardInstance, PlayerGameState, ScryfallCard, TargetRef } from '../types.ts';
	import {
		DUNGEON_ART_URI,
		EMBLEM_ART_URI,
		FACE_DOWN_ART_URI,
		type PermanentView,
		type PlayerStatusView
	} from './boardViewModel.ts';
	import PermanentCard from './PermanentCard.svelte';

	interface ZoneModalRequest {
		title: string;
		cards: CardInstance[];
		ownerName: string;
	}

	interface Props {
		opponent: PlayerGameState;
		status: PlayerStatusView;
		boardViews: PermanentView[];
		commanderTaxIncrement?: number;
		activeTurn?: boolean;
		hasPriority?: boolean;
		targetable?: boolean;
		isThinkingBot?: boolean;
		isWaitingOnPrompt?: boolean;
		canAcceptDrop?: boolean;
		incomingForecast?: PlayerIncomingForecast;
		combatForecast?: CombatDamageForecast;
		selectedTargetIds?: readonly string[];
		isPermanentActable?: (perm: CardInstance, owner: PlayerGameState) => boolean;
		isAttachmentLinked?: (perm: CardInstance) => boolean;
		onAvatarClick?: (opponent: PlayerGameState) => void;
		onDropTarget?: (e: DragEvent, target: TargetRef) => void;
		onOpenZoneModal?: (req: ZoneModalRequest) => void;
		onHoverCard?: (card: ScryfallCard, inst: CardInstance) => void;
		onLeaveCard?: (card: ScryfallCard, inst: CardInstance) => void;
		onInspectCard?: (card: ScryfallCard, inst: CardInstance) => void;
		onPermanentClick?: (perm: CardInstance, owner: PlayerGameState) => void;
	}

	let {
		opponent,
		status,
		boardViews,
		commanderTaxIncrement = 2,
		activeTurn = false,
		hasPriority = false,
		targetable = false,
		isThinkingBot = false,
		isWaitingOnPrompt = false,
		canAcceptDrop = false,
		incomingForecast,
		combatForecast,
		selectedTargetIds = [],
		isPermanentActable,
		isAttachmentLinked,
		onAvatarClick,
		onDropTarget,
		onOpenZoneModal,
		onHoverCard,
		onLeaveCard,
		onInspectCard,
		onPermanentClick
	}: Props = $props();
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
			? `${status.username} — Epic (CR 702.50): Can't cast spells for the rest of the game. Upkeep copies: ${status.epicSpellNames.join(', ')}`
			: `${status.username} can't cast spells for the rest of the game (CR 702.50)`
	);
</script>

<section
	class="opp-board"
	class:active-turn={activeTurn}
	class:has-prio={hasPriority}
	class:eliminated={opponent.lost}
>
	<div class="opp-header">
		<button
			type="button"
			class="player-badge"
			class:targetable-player={targetable}
			data-game-id={opponent.playerId}
			onclick={() => onAvatarClick?.(opponent)}
			ondragover={(e) => {
				if (canAcceptDrop) e.preventDefault();
			}}
			ondrop={(e) =>
				onDropTarget?.(e, {
					kind: 'player',
					id: opponent.playerId,
					label: opponent.username
				})}
		>
			<span class="p-name">
				{status.username}
				{#if opponent.isBot}<span class="bot-tag">BOT</span>{/if}
			</span>
			<span class="life-orb" class:low={status.life <= 10}>Life: {status.life}</span>

			{#if status.isMonarch}
				<span class="opp-pill monarch" title="{status.username} is the Monarch">👑 Monarch</span>
			{/if}
			{#if status.hasInitiative}
				<span
					class="opp-pill initiative"
					data-testid="opp-initiative-pill"
					title="{status.username} has the Initiative (CR 727)"
				>
					🔦 Initiative
				</span>
			{/if}
			{#if status.speed > 0}
				<span
					class="opp-pill speed"
					class:max-speed={status.isMaxSpeed}
					data-testid="opp-speed-pill"
					title={status.isMaxSpeed
						? `${status.username} has Max Speed (4/4 — CR 702.179)`
						: `${status.username} Speed: ${status.speed}/4 (CR 702.178)`}
				>
					{status.isMaxSpeed ? '🔥 MAX SPEED 4' : `⚡ Speed ${status.speed}`}
				</span>
			{/if}
			{#if status.hasCitysBlessing}
				<span
					class="opp-pill blessing"
					data-testid="opp-blessing-pill"
					title="{status.username} has the City's Blessing (CR 702.131)"
				>
					🏛️ City's Blessing
				</span>
			{/if}
			{#if status.hasEnduringStory}
				<span
					class="opp-pill storied"
					data-testid="opp-storied-pill"
					title="{status.username} has an Enduring Story for the rest of the game (CR 702.195)"
				>
					📜 Storied
				</span>
			{/if}
			{#if hasEpicDesignation}
				<span
					class="opp-pill epic"
					data-testid="opp-epic-pill"
					title={epicTooltip}
				>
					⏳ Epic{status.epicSpellNames.length > 1 ? ` ×${status.epicSpellNames.length}` : ''}
				</span>
			{/if}
			{#if status.ringLevel > 0}
				<span
					class="opp-pill ring"
					data-testid="opp-ring-pill"
					title={ringTooltip}
				>
					💍 Ring Lv.{status.ringLevel}
				</span>
			{/if}
			{#if status.activeDungeon}
				<span
					class="opp-pill dungeon"
					data-testid="opp-dungeon-pill"
					title={`${status.activeDungeon.dungeonName} — Room ${status.activeDungeon.roomIndex + 1}/${status.activeDungeon.totalRooms} (${status.activeDungeon.roomName}): ${status.activeDungeon.roomEffectText}`}
				>
					🗺️ {status.activeDungeon.dungeonName}: {status.activeDungeon.roomName}
				</span>
			{/if}
			{#if status.completedDungeonCount > 0}
				<span
					class="opp-pill dungeon-done"
					title={`Completed dungeons (${status.completedDungeonCount}): ${status.completedDungeonNames.join(', ') || status.completedDungeonCount}`}
				>
					🏆 ×{status.completedDungeonCount}
				</span>
			{/if}
			{#if status.energyCounters > 0}
				<span class="opp-pill energy" title="Energy counters: {status.energyCounters}">
					<ManaSymbol symbol="E" size={12} />
					<span>{status.energyCounters}</span>
				</span>
			{/if}
			{#if status.experienceCounters > 0}
				<span class="opp-pill exp" title="Experience counters: {status.experienceCounters}">
					✦ EXP {status.experienceCounters}
				</span>
			{/if}
			{#if status.poison > 0}
				<span class="opp-pill poison" title="Poison counters: {status.poison}">
					☠ {status.poison}
				</span>
			{/if}
			{#if status.radCounters > 0}
				<span class="opp-pill rad" title="Rad counters: {status.radCounters}">
					☢ {status.radCounters}
				</span>
			{/if}

			{#if incomingForecast && (incomingForecast.unblockedCount > 0 || incomingForecast.blockedCount > 0)}
				<span
					class="incoming-dmg-layover"
					class:lethal={incomingForecast.isLethal}
					class:all-blocked={
						incomingForecast.totalLifeLoss === 0 && incomingForecast.totalPoisonGain === 0
					}
				>
					{#if incomingForecast.totalLifeLoss > 0}
						⚔️ -{incomingForecast.totalLifeLoss} ({status.life}→{incomingForecast.projectedLife})
					{:else if incomingForecast.totalPoisonGain > 0}
						☠️ +{incomingForecast.totalPoisonGain} Psn
					{:else}
						🛡️ 0 DMG
					{/if}
					{#if incomingForecast.isLethal} 💀{/if}
				</span>
			{/if}
		</button>

		{#if isThinkingBot}
			<span class="bot-thinking-pill" aria-live="polite">{status.username} is thinking…</span>
		{:else if isWaitingOnPrompt}
			<span class="bot-thinking-pill waiting" aria-live="polite">
				Waiting for {status.username}…
			</span>
		{/if}

		<div class="opp-zones">
			<span
				class="z-chip"
				data-game-id="{opponent.playerId}:hand"
				title="Cards in Hand"
			>
				Hand: {opponent.handCount ?? opponent.hand.length}
			</span>
			<span
				class="z-chip"
				data-game-id="{opponent.playerId}:library"
				title="Cards in Library"
			>
				Lib: {opponent.libraryCount ?? opponent.library.length}
			</span>
			<button
				type="button"
				class="z-chip clickable"
				data-game-id="{opponent.playerId}:graveyard"
				onclick={() =>
					onOpenZoneModal?.({
						title: 'Graveyard',
						cards: opponent.graveyard,
						ownerName: opponent.username
					})}
			>
				GY: {opponent.graveyard.length}
			</button>
			<button
				type="button"
				class="z-chip clickable"
				data-game-id="{opponent.playerId}:exile"
				onclick={() =>
					onOpenZoneModal?.({
						title: 'Exile',
						cards: opponent.exile,
						ownerName: opponent.username
					})}
			>
				Exile: {opponent.exile.length}
			</button>
		</div>
	</div>

	{#if status.turnShieldBadges.length > 0 || status.restrictedManaEntries.length > 0 || status.snowManaTotal > 0}
		<div class="opp-status-strip">
			{#each status.turnShieldBadges as shield (shield.id)}
				<span class="shield-pill {shield.tone}" title={shield.description}>
					🛡️ {shield.label}
				</span>
			{/each}
			{#if status.snowManaTotal > 0}
				<span
					class="snow-pill"
					data-testid="opp-snow-mana"
					title="{status.username} has {status.snowManaTotal} snow mana in pool"
				>
					<ManaSymbol symbol="S" size={11} />
					<span>Snow: {status.snowManaTotal}</span>
				</span>
			{/if}
			{#each status.restrictedManaEntries as rm (rm.restriction)}
				<span class="rm-pill" title={rm.description}>
					{#each rm.colors as cItem (cItem.color)}
						<ManaSymbol symbol={cItem.color} size={11} />
					{/each}
					<span>{rm.label}: {rm.total}</span>
				</span>
			{/each}
		</div>
	{/if}

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

	<div class="opp-field">
		{#each opponent.command as cmd (cmd.instanceId)}
			{@const isEmblem = Boolean(cmd.isEmblem)}
			{@const isDungeon = Boolean(cmd.isDungeon)}
			{@const thumbSrc =
				cmd.card.artCropUrl ||
				cmd.card.imageUrl ||
				(isEmblem ? EMBLEM_ART_URI : isDungeon ? DUNGEON_ART_URI : FACE_DOWN_ART_URI)}
			<button
				type="button"
				class="mini-card unactable"
				class:cmd-zone-card={!isEmblem && !isDungeon}
				class:emblem-zone-card={isEmblem}
				class:dungeon-zone-card={isDungeon}
				data-game-id={cmd.instanceId}
				title={isEmblem ? `Emblem: ${cmd.card.name}` : isDungeon ? `Dungeon: ${cmd.card.name}` : cmd.card.name}
				onmouseenter={() => onHoverCard?.(cmd.card, cmd)}
				onmouseleave={() => onLeaveCard?.(cmd.card, cmd)}
				onclick={() => onInspectCard?.(cmd.card, cmd)}
			>
				<img src={thumbSrc} alt={cmd.card.name} loading="lazy" />
				{#if isEmblem}
					<span class="mc-tag emblem-tag">EMBLEM</span>
				{:else if isDungeon}
					<span class="mc-tag dungeon-tag">DUNGEON</span>
				{:else}
					<span class="mc-tag">CMD (+{cmd.commanderCastCount * commanderTaxIncrement})</span>
				{/if}
				<span class="mc-name">{cmd.card.name}</span>
			</button>
		{/each}

		{#each boardViews as pView (pView.instanceId)}
			<PermanentCard
				view={pView}
				variant="opponent"
				actable={isPermanentActable ? isPermanentActable(pView.perm, opponent) : false}
				selectedTarget={selectedTargetIds.includes(pView.instanceId)}
				attachmentLinked={isAttachmentLinked ? isAttachmentLinked(pView.perm) : false}
				attackerForecast={combatForecast?.attackerSummaries[pView.instanceId]}
				blockerForecast={combatForecast?.blockerSummaries[pView.instanceId]}
				planeswalkerForecast={combatForecast?.planeswalkerIncoming[pView.instanceId]}
				{canAcceptDrop}
				onHover={onHoverCard}
				onLeave={onLeaveCard}
				onClick={(perm) => onPermanentClick?.(perm, opponent)}
				{onDropTarget}
			/>
		{/each}
	</div>
</section>

<style>
	.opp-board {
		background: var(--mp-bg-elevated);
		border: 1px solid var(--mp-border);
		border-radius: 8px;
		padding: 0.4rem;
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		overflow: hidden;
	}
	.opp-board.active-turn {
		border-color: var(--mp-cyan);
	}
	.opp-board.has-prio {
		border-color: var(--mp-accent);
	}
	.opp-board.eliminated {
		opacity: 0.42;
	}

	.opp-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 0.35rem;
		flex-wrap: wrap;
	}
	.player-badge {
		display: inline-flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.38rem;
		background: var(--mp-bg);
		border: 1px solid var(--mp-border-strong);
		color: var(--mp-text);
		padding: 0.2rem 0.5rem;
		border-radius: 6px;
		font-family: inherit;
		font-size: 0.74rem;
		cursor: pointer;
	}
	.player-badge:hover {
		border-color: var(--mp-red);
	}
	.player-badge.targetable-player {
		border-color: #ffd866;
		box-shadow: 0 0 12px rgba(255, 216, 102, 0.55);
	}
	.bot-tag {
		font-size: 0.6rem;
		background: var(--mp-purple);
		color: #fcfcfa;
		padding: 0.06rem 0.28rem;
		border-radius: 3px;
	}
	.bot-thinking-pill {
		display: inline-flex;
		align-items: center;
		font-size: 0.66rem;
		font-style: italic;
		color: var(--mp-text-muted);
		background: var(--mp-bg);
		border: 1px dashed var(--mp-border);
		padding: 0.14rem 0.42rem;
		border-radius: 999px;
		white-space: nowrap;
	}
	.bot-thinking-pill.waiting {
		border-color: var(--mp-cyan);
		color: var(--mp-cyan);
	}

	.life-orb {
		font-weight: 700;
		color: var(--mp-green);
	}
	.life-orb.low {
		color: var(--mp-red);
	}

	.opp-pill {
		display: inline-flex;
		align-items: center;
		gap: 0.14rem;
		font-size: 0.62rem;
		font-weight: 700;
		padding: 0.05rem 0.28rem;
		border-radius: 4px;
		background: var(--mp-bg-elevated);
		border: 1px solid var(--mp-border-strong);
	}
	.opp-pill.monarch {
		border-color: #ffd866;
		color: #ffd866;
		background: rgba(255, 216, 102, 0.14);
	}
	.opp-pill.initiative {
		border-color: #fc9867;
		color: #fc9867;
		background: rgba(252, 152, 103, 0.14);
	}
	.opp-pill.speed {
		border-color: #fc9867;
		color: #fc9867;
		background: rgba(252, 152, 103, 0.12);
	}
	.opp-pill.speed.max-speed {
		border-color: #ffd866;
		color: #ffd866;
		background: rgba(255, 97, 136, 0.22);
		box-shadow: 0 0 8px rgba(255, 216, 102, 0.45);
	}
	.opp-pill.blessing {
		border-color: var(--mp-cyan);
		color: var(--mp-cyan);
		background: rgba(120, 220, 232, 0.12);
	}
	.opp-pill.storied {
		border-color: #ffd866;
		color: #ffd866;
		background: rgba(255, 216, 102, 0.14);
	}
	.opp-pill.epic {
		border-color: var(--mp-red);
		color: var(--mp-red);
		background: rgba(255, 97, 136, 0.14);
	}
	.opp-pill.ring {
		border-color: #ffd866;
		color: #ffd866;
		background: rgba(255, 216, 102, 0.15);
	}
	.opp-pill.dungeon {
		border-color: var(--mp-purple);
		color: var(--mp-purple);
		background: rgba(171, 157, 242, 0.14);
	}
	.opp-pill.dungeon-done {
		border-color: var(--mp-green);
		color: var(--mp-green);
		background: rgba(169, 220, 118, 0.12);
	}
	.opp-pill.energy {
		border-color: #f59e0b;
		color: #ffd866;
	}
	.opp-pill.exp {
		border-color: var(--mp-cyan);
		color: var(--mp-cyan);
	}
	.opp-pill.poison {
		border-color: var(--mp-purple);
		color: var(--mp-purple);
	}
	.opp-pill.rad {
		border-color: var(--mp-green);
		color: var(--mp-green);
	}

	.opp-status-strip,
	.cmd-dmg-bar {
		display: flex;
		flex-wrap: wrap;
		gap: 0.24rem;
	}
	.shield-pill {
		font-size: 0.58rem;
		font-weight: 700;
		padding: 0.04rem 0.28rem;
		border-radius: 3px;
		border: 1px solid var(--mp-border-strong);
	}
	.shield-pill.gold {
		border-color: #ffd866;
		color: #ffd866;
	}
	.shield-pill.cyan {
		border-color: var(--mp-cyan);
		color: var(--mp-cyan);
	}
	.shield-pill.purple {
		border-color: var(--mp-purple);
		color: var(--mp-purple);
	}
	.shield-pill.green {
		border-color: var(--mp-green);
		color: var(--mp-green);
	}
	.snow-pill {
		display: inline-flex;
		align-items: center;
		gap: 0.16rem;
		font-size: 0.58rem;
		background: rgba(120, 220, 232, 0.12);
		border: 1px solid var(--mp-cyan);
		color: var(--mp-cyan);
		padding: 0.04rem 0.28rem;
		border-radius: 3px;
		font-weight: 700;
	}
	.rm-pill {
		display: inline-flex;
		align-items: center;
		gap: 0.16rem;
		font-size: 0.58rem;
		background: var(--mp-bg);
		border: 1px solid #d97706;
		color: #ffd866;
		padding: 0.04rem 0.28rem;
		border-radius: 3px;
	}
	.cmd-dmg-pill {
		font-size: 0.62rem;
		background: var(--mp-bg);
		border: 1px solid var(--mp-red);
		color: var(--mp-red);
		padding: 0.05rem 0.3rem;
		border-radius: 3px;
	}

	.opp-zones {
		display: flex;
		align-items: center;
		gap: 0.28rem;
		flex-wrap: wrap;
	}
	.z-chip {
		font-size: 0.66rem;
		background: var(--mp-bg);
		border: 1px solid var(--mp-border);
		color: var(--mp-text-muted);
		padding: 0.12rem 0.36rem;
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

	.opp-field {
		flex: 1;
		display: flex;
		flex-wrap: wrap;
		align-content: flex-start;
		gap: 0.32rem;
		overflow-y: auto;
	}
	.mini-card {
		position: relative;
		width: 66px;
		height: 50px;
		border-radius: 5px;
		border: 1px solid var(--mp-border-strong);
		background: var(--mp-bg);
		padding: 0;
		overflow: hidden;
		cursor: pointer;
	}
	.mini-card img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.mini-card.cmd-zone-card {
		border-color: #ffd866;
	}
	.mini-card.emblem-zone-card {
		border-color: var(--mp-purple);
	}
	.mini-card.dungeon-zone-card {
		border-color: var(--mp-cyan);
	}
	.mini-card.unactable::after {
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
	.mini-card.unactable:hover::after {
		opacity: 0.2;
	}
	.mc-name {
		position: absolute;
		bottom: 0;
		left: 0;
		right: 0;
		background: rgba(15, 13, 18, 0.85);
		color: #fcfcfa;
		font-size: 0.54rem;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		padding: 1px 3px;
	}
	.mc-tag {
		position: absolute;
		top: 1px;
		left: 1px;
		background: #ffd866;
		color: #19181a;
		font-size: 0.5rem;
		font-weight: 700;
		padding: 0 3px;
		border-radius: 2px;
	}

	.mc-tag.emblem-tag {
		background: var(--mp-purple);
		color: #19181a;
	}
	.mc-tag.dungeon-tag {
		background: var(--mp-cyan);
		color: #19181a;
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
		font-size: 0.64rem;
		font-weight: 800;
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
