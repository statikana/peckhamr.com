<script lang="ts">
	import type { ModalDef } from '../ir.ts';
	import ManaText from '../ManaText.svelte';
	import { effectiveCardForObject } from '../scryfall.ts';
	import type { CardInstance } from '../types.ts';

	let {
		inst,
		modal,
		modeLabels,
		disabledIndices = [],
		initialSelectedModes,
		allowAllModes = false,
		onConfirm,
		onCancel
	}: {
		inst: CardInstance;
		modal: ModalDef;
		modeLabels: string[];
		disabledIndices?: number[];
		initialSelectedModes?: number[];
		allowAllModes?: boolean;
		onConfirm: (chosenModes: number[]) => void | Promise<void>;
		onCancel: () => void;
	} = $props();

	let lastSessionKey = '';
	let selectedModes = $state<number[]>([]);
	let minimized = $state(false);

	$effect.pre(() => {
		const nextKey = `${inst.instanceId}:${modeLabels.length}:${modal.min}:${modal.max}:${allowAllModes ? 1 : 0}`;
		if (nextKey !== lastSessionKey) {
			lastSessionKey = nextKey;
			selectedModes = initialSelectedModes ? [...initialSelectedModes] : [];
			minimized = false;
		}
	});

	const effCard = $derived(effectiveCardForObject(inst));
	const disabledSet = $derived(new Set(disabledIndices));
	const effectiveMax = $derived(
		allowAllModes ? Math.max(modal.max, modeLabels.length) : modal.max
	);
	const effectiveMin = $derived(
		allowAllModes ? Math.min(modal.min, modeLabels.length - disabledSet.size) : modal.min
	);
	const isReady = $derived(
		selectedModes.length >= effectiveMin && selectedModes.length <= effectiveMax
	);

	function toggleModeSelection(modeIdx: number) {
		if (disabledSet.has(modeIdx) || modal.allowRepeat) return;
		if (selectedModes.includes(modeIdx)) {
			selectedModes = selectedModes.filter((i) => i !== modeIdx);
		} else if (selectedModes.length < effectiveMax) {
			selectedModes = [...selectedModes, modeIdx];
		}
	}

	function adjustModeRepeat(modeIdx: number, delta: 1 | -1) {
		if (disabledSet.has(modeIdx)) return;
		if (delta > 0) {
			if (selectedModes.length >= effectiveMax) return;
			selectedModes = [...selectedModes, modeIdx];
		} else {
			const pos = selectedModes.lastIndexOf(modeIdx);
			if (pos < 0) return;
			const next = [...selectedModes];
			next.splice(pos, 1);
			selectedModes = next;
		}
	}
</script>

{#if minimized}
	<div class="modal-peek-bar" data-testid="mode-picker-peek-bar" role="region" aria-label="Minimized Mode Picker">
		<span class="peek-title">
			Choose Mode(s) — <strong>{effCard.name}</strong>
			{#if selectedModes.length > 0}
				<span class="peek-count">({selectedModes.length}/{effectiveMax})</span>
			{/if}
		</span>
		<div class="peek-actions">
			<button
				type="button"
				class="hud-btn active-ctrl"
				data-testid="restore-modal-btn"
				onclick={() => (minimized = false)}
			>
				👁 Return to Modes
			</button>
			<button type="button" class="hud-btn danger" onclick={onCancel}>
				Cancel
			</button>
		</div>
	</div>
{:else}
	<div class="modal-backdrop">
		<div class="arena-modal" role="dialog" aria-modal="true" aria-label="Choose Modes for {effCard.name}">
			<div class="modal-head-row">
				<h3>Choose Mode(s) — {effCard.name}</h3>
				<button
					type="button"
					class="hud-btn peek-btn"
					data-testid="peek-battlefield-btn"
					onclick={() => (minimized = true)}
				>
					👁 Peek Battlefield
				</button>
			</div>

			<p class="modal-desc">
				Choose {effectiveMin === effectiveMax ? effectiveMin : `${effectiveMin}–${effectiveMax}`} mode{effectiveMax === 1 ? '' : 's'}.
				{#if modal.allowRepeat}
					You may choose the same mode more than once.
				{/if}
				{#if modal.oncePerTurnUnique}
					Modes already chosen this turn cannot be chosen again.
				{/if}
			</p>

			{#if !modal.allowRepeat && effectiveMin === 1 && effectiveMax === 1}
				<div class="mode-picker-list">
					{#each modeLabels as label, i (i)}
						{@const isDisabled = disabledSet.has(i)}
						<button
							type="button"
							class="hud-btn mode-option-btn"
							data-testid="mode-option-btn-{i}"
							disabled={isDisabled}
							title={isDisabled ? 'Unavailable (no legal targets or already chosen this turn)' : label}
							onclick={() => onConfirm([i])}
						>
							<ManaText text={`${i + 1}. ${label}`} size={14} />
						</button>
					{/each}
				</div>
				<div class="modal-actions">
					<button type="button" class="hud-btn" onclick={onCancel}>
						Cancel
					</button>
				</div>
			{:else if modal.allowRepeat}
				<div class="mode-picker-list">
					{#each modeLabels as label, i (i)}
						{@const isDisabled = disabledSet.has(i)}
						{@const pickedCount = selectedModes.filter((x) => x === i).length}
						<div class="mode-repeat-row" class:disabled={isDisabled} data-testid="mode-repeat-row-{i}">
							<span class="mode-repeat-label">
								<ManaText text={`${i + 1}. ${label}`} size={14} />
							</span>
							<div class="mode-repeat-controls">
								<button
									type="button"
									class="hud-btn mini-btn"
									data-testid="mode-repeat-dec-{i}"
									disabled={pickedCount === 0}
									onclick={() => adjustModeRepeat(i, -1)}
								>
									−
								</button>
								<span class="mode-count-badge">×{pickedCount}</span>
								<button
									type="button"
									class="hud-btn mini-btn"
									data-testid="mode-repeat-inc-{i}"
									disabled={isDisabled || selectedModes.length >= effectiveMax}
									onclick={() => adjustModeRepeat(i, 1)}
								>
									+
								</button>
							</div>
						</div>
					{/each}
				</div>
				<div class="modal-actions">
					<button
						type="button"
						class="arena-main-btn"
						class:can-act={isReady}
						data-testid="confirm-modes-btn"
						disabled={!isReady}
						onclick={() => onConfirm([...selectedModes])}
					>
						Confirm Modes ({selectedModes.length}/{effectiveMax})
					</button>
					<button type="button" class="hud-btn" onclick={onCancel}>
						Cancel
					</button>
				</div>
			{:else}
				<div class="mode-picker-list">
					{#each modeLabels as label, i (i)}
						{@const isDisabled = disabledSet.has(i)}
						{@const isSelected = selectedModes.includes(i)}
						<button
							type="button"
							class={isSelected ? 'arena-main-btn can-act mode-option-btn' : 'hud-btn mode-option-btn'}
							data-testid="mode-option-btn-{i}"
							disabled={isDisabled}
							title={isDisabled ? 'Unavailable (no legal targets or already chosen this turn)' : label}
							onclick={() => toggleModeSelection(i)}
						>
							<ManaText text={`${i + 1}. ${label}`} size={14} />
						</button>
					{/each}
				</div>
				<div class="modal-actions">
					<button
						type="button"
						class="arena-main-btn"
						class:can-act={isReady}
						data-testid="confirm-modes-btn"
						disabled={!isReady}
						onclick={() => onConfirm([...selectedModes])}
					>
						Confirm Modes ({selectedModes.length}/{effectiveMax})
					</button>
					<button type="button" class="hud-btn" onclick={onCancel}>
						Cancel
					</button>
				</div>
			{/if}
		</div>
	</div>
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
	}
	.arena-modal {
		background: var(--mp-bg-elevated);
		border: 1.5px solid var(--mp-accent);
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
	.arena-modal h3 {
		margin: 0;
		color: var(--mp-accent);
	}
	.modal-desc {
		margin: 0;
		font-size: 0.8rem;
		color: var(--mp-text-body);
		white-space: pre-line;
	}
	.mode-picker-list {
		display: flex;
		flex-direction: column;
		gap: 0.45rem;
		margin: 0.3rem 0;
	}
	.mode-option-btn {
		text-align: left;
		justify-content: flex-start;
		width: 100%;
	}
	.mode-repeat-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.65rem;
		padding: 0.4rem 0.55rem;
		border: 1px solid var(--mp-border-strong);
		border-radius: 6px;
		background: rgba(255, 255, 255, 0.03);
	}
	.mode-repeat-row.disabled {
		opacity: 0.45;
	}
	.mode-repeat-label {
		flex: 1;
		text-align: left;
		font-size: 0.85rem;
		color: var(--mp-text);
	}
	.mode-repeat-controls {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		flex-shrink: 0;
	}
	.mode-count-badge {
		min-width: 1.8rem;
		text-align: center;
		font-weight: 600;
		font-size: 0.85rem;
		color: var(--mp-cyan);
	}
	.modal-actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.6rem;
		flex-wrap: wrap;
	}
	.modal-peek-bar {
		position: fixed;
		top: 0.65rem;
		left: 50%;
		transform: translateX(-50%);
		z-index: 205;
		display: flex;
		align-items: center;
		gap: 0.85rem;
		padding: 0.45rem 0.9rem;
		background: var(--mp-bg-elevated);
		border: 1.5px solid var(--mp-accent);
		border-radius: 999px;
		box-shadow: 0 10px 30px rgba(0, 0, 0, 0.55);
		font-size: 0.8rem;
		color: var(--mp-text);
	}
	.peek-title strong {
		color: var(--mp-accent);
	}
	.peek-count {
		color: var(--mp-cyan);
		font-weight: 700;
		margin-left: 0.25rem;
	}
	.peek-actions {
		display: inline-flex;
		align-items: center;
		gap: 0.45rem;
	}
	.arena-main-btn {
		background: var(--mp-bg-subtle);
		color: var(--mp-text-muted);
		border: 2px solid var(--mp-border-strong);
		border-radius: 8px;
		padding: 0.65rem 0.8rem;
		font-family: inherit;
		font-size: 0.8rem;
		font-weight: 700;
		cursor: pointer;
		transition: all 0.16s ease;
	}
	.arena-main-btn.can-act {
		background: var(--mp-btn-bg);
		color: var(--mp-btn-fg);
		border-color: var(--mp-btn-bg);
	}
	.arena-main-btn:disabled {
		background: var(--mp-bg-subtle);
		color: var(--mp-text-faint, var(--mp-text-muted));
		border-color: var(--mp-border);
		opacity: 0.36;
		cursor: not-allowed;
	}
	.hud-btn {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		background: var(--mp-bg);
		color: var(--mp-text);
		border: 1px solid var(--mp-border-strong);
		border-radius: 4px;
		padding: 0.32rem 0.6rem;
		font-size: 0.76rem;
		font-family: inherit;
		cursor: pointer;
	}
	.hud-btn.mini-btn {
		padding: 0.2rem 0.48rem;
	}
	.hud-btn:hover:not(:disabled) {
		border-color: var(--mp-accent);
		color: var(--mp-accent);
	}
	.hud-btn.active-ctrl {
		border-color: var(--mp-accent);
		color: var(--mp-accent);
		font-weight: 700;
	}
	.hud-btn.danger:hover:not(:disabled) {
		border-color: var(--mp-red);
		color: var(--mp-red);
	}
	.hud-btn:disabled {
		opacity: 0.42;
		cursor: not-allowed;
	}
</style>
