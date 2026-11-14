<script lang="ts">
	import type { GameState } from '../types.ts';

	let {
		gameState,
		onLeaveMatch
	}: {
		gameState: GameState;
		onLeaveMatch: () => void;
	} = $props();

	let peekingBattlefield = $state(false);

	const winner = $derived(
		gameState.players.find((p) => p.playerId === gameState.winnerPlayerId) ?? null
	);
</script>

{#if gameState.status === 'finished'}
	{#if peekingBattlefield}
		<div class="peek-banner-shell" role="region" aria-label="Match finished banner">
			<div class="peek-banner">
				<span class="peek-title">
					🏆 {winner ? `${winner.username} Wins the Pod` : 'Match Finished'}
				</span>
				<div class="peek-actions">
					<button
						type="button"
						class="hud-btn"
						onclick={() => (peekingBattlefield = false)}
					>
						↩ Restore Summary
					</button>
					<button type="button" class="arena-main-btn can-act compact" onclick={onLeaveMatch}>
						Return to Pod Lobby
					</button>
				</div>
			</div>
		</div>
	{:else}
		<div class="modal-backdrop">
			<div class="arena-modal">
				<div class="modal-head-row">
					<h2>{winner ? `${winner.username} Wins the Pod` : 'Match Finished'}</h2>
					<button
						type="button"
						class="peek-btn"
						onclick={() => (peekingBattlefield = true)}
					>
						👁 Peek Battlefield
					</button>
				</div>
				<p class="modal-desc">All Commander rules and state-based actions have concluded.</p>

				<div class="standings-list">
					{#each gameState.players as p (p.playerId)}
						{@const isWinner = p.playerId === gameState.winnerPlayerId}
						<div class="standing-row" class:winner={isWinner} class:eliminated={p.lost && !isWinner}>
							<span class="st-name">
								{isWinner ? '👑 ' : ''}{p.username}
							</span>
							<span class="st-stats">
								{p.life} life{p.poison > 0 ? ` · ${p.poison} poison` : ''}
							</span>
						</div>
					{/each}
				</div>

				<div class="modal-actions">
					<button type="button" class="arena-main-btn can-act" onclick={onLeaveMatch}>
						Return to Pod Lobby
					</button>
				</div>
			</div>
		</div>
	{/if}
{/if}

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
	.arena-modal {
		background: var(--mp-bg-elevated, #221f22);
		border: 1.5px solid var(--mp-accent, #ffd866);
		border-radius: 10px;
		padding: 1.15rem;
		max-width: 520px;
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
	.arena-modal h2 {
		margin: 0;
		color: var(--mp-accent, #ffd866);
	}
	.modal-desc {
		margin: 0;
		font-size: 0.8rem;
		color: var(--mp-text-body, #e3e1e4);
	}
	.standings-list {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}
	.standing-row {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 0.4rem 0.6rem;
		border-radius: 6px;
		background: var(--mp-bg, #19181a);
		border: 1px solid var(--mp-border, #3e3a42);
		font-size: 0.76rem;
		color: var(--mp-text, #fcfcfa);
	}
	.standing-row.winner {
		border-color: var(--mp-accent, #ffd866);
		background: rgba(255, 216, 102, 0.12);
	}
	.standing-row.eliminated {
		opacity: 0.65;
	}
	.st-name {
		font-weight: 700;
	}
	.st-stats {
		color: var(--mp-text-muted, #939293);
		font-size: 0.72rem;
	}
	.modal-actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.6rem;
	}
	.peek-btn {
		background: var(--mp-bg, #19181a);
		color: var(--mp-cyan, #78dce8);
		border: 1px solid var(--mp-cyan, #78dce8);
		border-radius: 6px;
		padding: 0.3rem 0.6rem;
		font-family: inherit;
		font-size: 0.72rem;
		font-weight: 700;
		cursor: pointer;
	}
	.peek-banner-shell {
		position: fixed;
		top: 0.65rem;
		left: 0;
		right: 0;
		display: flex;
		justify-content: center;
		pointer-events: none;
		z-index: 220;
		font-family: var(--mono-font, monospace);
	}
	.peek-banner {
		pointer-events: auto;
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.45rem 0.85rem;
		background: var(--mp-bg-elevated, #221f22);
		border: 1.5px solid var(--mp-accent, #ffd866);
		border-radius: 999px;
		box-shadow: 0 10px 30px rgba(0, 0, 0, 0.6);
	}
	.peek-title {
		font-size: 0.78rem;
		font-weight: 700;
		color: var(--mp-accent, #ffd866);
	}
	.peek-actions {
		display: flex;
		align-items: center;
		gap: 0.45rem;
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
	.arena-main-btn.compact {
		padding: 0.32rem 0.68rem;
		font-size: 0.72rem;
		border-radius: 999px;
	}
	.hud-btn {
		background: var(--mp-bg, #19181a);
		color: var(--mp-text, #fcfcfa);
		border: 1px solid var(--mp-border-strong, #524c58);
		border-radius: 999px;
		padding: 0.32rem 0.68rem;
		font-family: inherit;
		font-size: 0.72rem;
		font-weight: 600;
		cursor: pointer;
	}
</style>
