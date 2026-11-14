<script lang="ts">
	import type { PlayerIncomingForecast } from '../engine.ts';
	import ManaSymbol from '../ManaSymbol.svelte';
	import type { CardInstance, ManaColor, PlayerGameState, TargetRef } from '../types.ts';
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
		onOpenZoneModal
	}: Props = $props();

	const MANA_ORB_COLORS: readonly ManaColor[] = ['W', 'U', 'B', 'R', 'G', 'C'];
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
				<span class="status-pill monarch" title="You are the Monarch (draw at end step)">
					👑 Monarch
				</span>
			{/if}
		</div>

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

		{#if status.turnShieldBadges.length > 0}
			<div class="player-shields-row">
				{#each status.turnShieldBadges as shield (shield.id)}
					<span class="shield-pill {shield.tone}" title={shield.description}>
						🛡️ {shield.label}
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
	.exile-playable-chip {
		grid-column: 1 / -1;
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
