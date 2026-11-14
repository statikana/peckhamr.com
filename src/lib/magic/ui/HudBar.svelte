<script lang="ts">
	import {
		PHASE_LABELS,
		PHASE_ORDER,
		type GameActionPayload,
		type GameState,
		type PlayerGameState
	} from '../types.ts';

	interface Props {
		gameState: GameState;
		viewer: PlayerGameState | undefined;
		lobbyCode: string;
		ropeRemainingSec?: number | null;
		waitingOnPlayerIds?: string[];
		theme?: 'dark' | 'light';
		shortcutsDisabled?: boolean;
		onLeaveMatch: () => void;
		onResetLayout: () => void;
		onToggleTheme: () => void;
		onGameAction: (action: GameActionPayload) => void | Promise<void>;
		onPrimaryAction?: () => void | Promise<void>;
		onPassTurn?: () => void | Promise<void>;
	}

	let {
		gameState,
		viewer,
		lobbyCode,
		ropeRemainingSec = null,
		waitingOnPlayerIds,
		theme = 'dark',
		shortcutsDisabled = false,
		onLeaveMatch,
		onResetLayout,
		onToggleTheme,
		onGameAction,
		onPrimaryAction,
		onPassTurn
	}: Props = $props();

	const activePlayer = $derived(gameState.players[gameState.activePlayerIndex]);
	const priorityPlayer = $derived(gameState.players[gameState.priorityPlayerIndex]);
	const hasPriority = $derived(
		Boolean(viewer && priorityPlayer?.playerId === viewer.playerId)
	);

	// Include ALL meaningful phase stops on the ladder, explicitly including
	// `first_strike_damage` and `end_combat` (excluding only `untap` and `cleanup`).
	const stoppablePhases = $derived(
		PHASE_ORDER.filter((ph) => ph !== 'untap' && ph !== 'cleanup')
	);

	const waitingPlayerNames = $derived.by(() => {
		const ids =
			waitingOnPlayerIds ??
			(() => {
				const viewerId = viewer?.playerId;
				if (viewerId && gameState.pendingPrompts.some((pr) => pr.playerId === viewerId)) {
					return [];
				}
				const unique: string[] = [];
				for (const pr of gameState.pendingPrompts) {
					if (pr.playerId !== viewerId && !unique.includes(pr.playerId)) {
						unique.push(pr.playerId);
					}
				}
				return unique;
			})();

		return ids.map(
			(pid) => gameState.players.find((p) => p.playerId === pid)?.username ?? 'Opponent'
		);
	});

	function isTextEntryTarget(target: EventTarget | null): boolean {
		if (!target || !(target instanceof HTMLElement)) return false;
		const tag = target.tagName;
		if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
		return target.isContentEditable;
	}

	function handleWindowKeyDown(e: KeyboardEvent): void {
		if (shortcutsDisabled || gameState.status !== 'active') return;
		if (isTextEntryTarget(e.target)) return;

		// Ctrl (standalone press): toggle Full Control
		if (e.key === 'Control' && !e.repeat && !e.altKey && !e.metaKey && !e.shiftKey) {
			if (viewer && !viewer.lost) {
				onGameAction({ type: 'toggle_full_control', enabled: !viewer.fullControl });
			}
			return;
		}

		// Shift + Space OR Enter: Pass to End of Turn
		if (
			(e.code === 'Space' && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) ||
			(e.key === 'Enter' &&
				!e.shiftKey &&
				!e.ctrlKey &&
				!e.metaKey &&
				!e.altKey &&
				!(e.target instanceof HTMLButtonElement) &&
				!(e.target instanceof HTMLAnchorElement))
		) {
			if (!viewer || viewer.lost) return;
			e.preventDefault();
			if (onPassTurn) {
				onPassTurn();
			} else {
				onGameAction({ type: 'end_turn' });
			}
			return;
		}

		// Space: Primary pass / confirm action
		if (e.code === 'Space' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
			if (e.target instanceof HTMLButtonElement) return;
			if (!viewer || viewer.lost) return;
			e.preventDefault();
			if (onPrimaryAction) {
				onPrimaryAction();
			} else if (hasPriority && gameState.pendingPrompts.length === 0) {
				onGameAction({ type: 'pass_priority' });
			}
		}
	}
</script>

<svelte:window onkeydown={handleWindowKeyDown} />

<header class="arena-hud">
	<div class="hud-left">
		<button type="button" class="hud-btn" onclick={onLeaveMatch}>
			Back to Pod ({lobbyCode})
		</button>
		<span class="turn-pill">TURN {gameState.turnNumber}</span>
		<span class="active-pill">
			Active: <strong>{activePlayer?.username}</strong>
		</span>
		<span class="priority-pill" class:mine={hasPriority}>
			Priority: <strong>{priorityPlayer?.username}</strong>
		</span>
		{#if waitingPlayerNames.length > 0}
			<span class="waiting-pill" role="status" aria-live="polite">
				<span class="waiting-dot" aria-hidden="true"></span>
				Waiting for {waitingPlayerNames.join(', ')}...
			</span>
		{/if}
	</div>

	<!-- Phase Ladder (including First Strike & End of Combat stops) -->
	<div class="phase-ladder" role="group" aria-label="Turn phase stops">
		{#each stoppablePhases as ph (ph)}
			<button
				type="button"
				class="phase-step"
				class:current={gameState.phase === ph}
				class:stopped={viewer?.stopPhases.includes(ph)}
				title="Click to toggle Phase Stop on {PHASE_LABELS[ph]}"
				onclick={() => onGameAction({ type: 'toggle_stop_phase', phase: ph })}
			>
				{PHASE_LABELS[ph]}
			</button>
		{/each}
	</div>

	<div class="hud-right">
		<span
			class="alt-hint"
			title="Hold Alt to preview card · Space: Pass/Confirm · Shift+Space/Enter: End Turn · Ctrl: Full Control"
		>
			[ALT: Preview · Space: Pass]
		</span>
		{#if ropeRemainingSec !== null}
			<span class="rope-pill" class:urgent={ropeRemainingSec <= 15}>
				Timer: {ropeRemainingSec}s
			</span>
		{/if}
		<button
			type="button"
			class="hud-btn"
			title="Reset adjustable panel sizes to defaults"
			onclick={onResetLayout}
		>
			Reset Layout
		</button>
		<button
			type="button"
			class="hud-btn"
			class:active-ctrl={viewer?.fullControl}
			title="Shortcut: Ctrl"
			onclick={() =>
				onGameAction({ type: 'toggle_full_control', enabled: !viewer?.fullControl })}
		>
			{viewer?.fullControl ? 'Full Control: ON' : 'Full Control: OFF'}
		</button>
		<button
			type="button"
			class="hud-btn danger"
			onclick={() => onGameAction({ type: 'concede' })}
		>
			Concede
		</button>
		<button
			type="button"
			class="theme-btn"
			onclick={onToggleTheme}
			aria-label="Toggle color theme"
			title={theme === 'light' ? 'Switch to Monokai Pro Dark' : 'Switch to Monokai Pro Light'}
		>
			<svg viewBox="0 0 20 20" width="13" height="13" aria-hidden="true">
				{#if theme === 'light'}
					<path
						d="M17.293 13.293A8 8 0 016.707 2.707a8.001 8.001 0 1010.586 10.586z"
						fill="currentColor"
					/>
				{:else}
					<circle cx="10" cy="10" r="4.2" fill="currentColor" />
					<path
						d="M10 1.5v2.2M10 16.3v2.2M1.5 10h2.2M16.3 10h2.2M4 4l1.6 1.6M14.4 14.4L16 16M16 4l-1.6 1.6M5.6 14.4L4 16"
						stroke="currentColor"
						stroke-width="1.6"
						stroke-linecap="round"
					/>
				{/if}
			</svg>
			<span>{theme === 'light' ? 'Dark' : 'Light'}</span>
		</button>
	</div>
</header>

<style>
	.arena-hud {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.6rem;
		padding: 0.4rem 0.8rem;
		background: var(--mp-bg-elevated);
		border-bottom: 1px solid var(--mp-border);
		z-index: 160;
	}
	.hud-left,
	.hud-right {
		display: flex;
		align-items: center;
		gap: 0.45rem;
		flex-wrap: wrap;
	}
	.alt-hint {
		font-size: 0.66rem;
		color: var(--mp-text-muted);
	}
	.turn-pill,
	.active-pill,
	.priority-pill,
	.rope-pill,
	.waiting-pill {
		font-size: 0.72rem;
		padding: 0.2rem 0.5rem;
		border-radius: 4px;
		background: var(--mp-bg);
		border: 1px solid var(--mp-border);
	}
	.priority-pill.mine {
		border-color: var(--mp-accent);
		color: var(--mp-accent);
	}
	.rope-pill.urgent {
		border-color: var(--mp-red);
		color: var(--mp-red);
	}
	.waiting-pill {
		display: inline-flex;
		align-items: center;
		gap: 0.34rem;
		border-color: var(--mp-cyan);
		color: var(--mp-cyan);
		background: rgba(120, 220, 232, 0.08);
		font-weight: 600;
	}
	.waiting-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--mp-cyan);
		animation: waiting-pulse 1.2s ease-in-out infinite;
	}
	@keyframes waiting-pulse {
		0%,
		100% {
			opacity: 0.35;
			transform: scale(0.88);
		}
		50% {
			opacity: 1;
			transform: scale(1.15);
		}
	}

	.phase-ladder {
		display: flex;
		align-items: center;
		gap: 0.2rem;
		flex-wrap: wrap;
	}
	.phase-step {
		background: var(--mp-bg);
		color: var(--mp-text-muted);
		border: 1px solid var(--mp-border);
		border-radius: 4px;
		padding: 0.16rem 0.38rem;
		font-size: 0.66rem;
		font-family: inherit;
		cursor: pointer;
		transition: border-color 0.12s ease, color 0.12s ease;
	}
	.phase-step:hover {
		border-color: var(--mp-accent);
		color: var(--mp-text);
	}
	.phase-step.current {
		background: var(--mp-btn-bg);
		color: var(--mp-btn-fg);
		font-weight: 700;
		border-color: var(--mp-btn-bg);
	}
	.phase-step.stopped {
		border-bottom: 2px solid var(--mp-red);
	}

	.hud-btn,
	.theme-btn {
		display: inline-flex;
		align-items: center;
		gap: 0.32rem;
		background: var(--mp-bg);
		color: var(--mp-text);
		border: 1px solid var(--mp-border-strong);
		border-radius: 4px;
		padding: 0.24rem 0.55rem;
		font-size: 0.72rem;
		font-family: inherit;
		cursor: pointer;
	}
	.hud-btn:hover,
	.theme-btn:hover {
		border-color: var(--mp-accent);
		color: var(--mp-accent);
	}
	.hud-btn.active-ctrl {
		border-color: var(--mp-accent);
		color: var(--mp-accent);
	}
	.hud-btn.danger:hover {
		border-color: var(--mp-red);
		color: var(--mp-red);
	}
</style>
